import { nativeImage } from 'electron'
import { readdir, stat } from 'fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'path'
import { readBlendInfo } from '../blender/blend-parser'
import { findPreviewSidecar } from './manage'
import { isSkippedScanDir } from '../scan-skip'
import { identityOf, matchMovedFiles } from './identity'
import {
  getFileIdentities,
  getKnownFiles,
  getProjectFiles,
  getProjectFolders,
  isPathUnder,
  migrateProjectPath,
  setScanMemory
} from './store'
import type { BlendThumbnail } from '../blender/blend-parser'
import type { FileIdentity } from '../config'
import type { MovedFile } from './identity'
import type { BlendFileInfo } from '../../shared/types'

const MAX_FILES = 400
const MAX_DEPTH = 5
const MAX_PREVIEW_EDGE = 512

const cache = new Map<string, { key: string; info: BlendFileInfo }>()

async function collectBlendFiles(dir: string, out: string[], depth: number): Promise<void> {
  if (depth > MAX_DEPTH || out.length >= MAX_FILES) return
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (out.length >= MAX_FILES) return
    if (isSkippedScanDir(entry.name)) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      await collectBlendFiles(full, out, depth + 1)
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.blend')) {
      out.push(full)
    }
  }
}

// .blend thumbnails are RGBA stored bottom-up; nativeImage expects BGRA top-down
function thumbnailToDataUrl(thumbnail: BlendThumbnail): string | null {
  const { width, height, rgba } = thumbnail
  const bgra = Buffer.alloc(width * height * 4)
  for (let y = 0; y < height; y++) {
    const sourceRow = (height - 1 - y) * width * 4
    const targetRow = y * width * 4
    for (let x = 0; x < width; x++) {
      const s = sourceRow + x * 4
      const t = targetRow + x * 4
      bgra[t] = rgba[s + 2]
      bgra[t + 1] = rgba[s + 1]
      bgra[t + 2] = rgba[s]
      bgra[t + 3] = rgba[s + 3]
    }
  }
  try {
    const image = nativeImage.createFromBitmap(bgra, { width, height })
    const dataUrl = image.toDataURL()
    return dataUrl.length > 'data:image/png;base64,'.length ? dataUrl : null
  } catch {
    return null
  }
}

// A user-supplied preview image; downscaled so the data URL stays small.
async function loadCustomThumbnail(imagePath: string): Promise<string | null> {
  try {
    let image = nativeImage.createFromPath(imagePath)
    if (image.isEmpty()) return null
    const size = image.getSize()
    const longest = Math.max(size.width, size.height)
    if (longest > MAX_PREVIEW_EDGE) {
      const scale = MAX_PREVIEW_EDGE / longest
      image = image.resize({
        width: Math.round(size.width * scale),
        height: Math.round(size.height * scale)
      })
    }
    const url = image.toDataURL()
    return url.length > 'data:image/png;base64,'.length ? url : null
  } catch {
    return null
  }
}

// Cheap folder + individual-file listing sorted by last-modified — no thumbnail or
// .blend header parsing, unlike scanProjectFiles. Used by the tray's flat recent-
// projects list, which just needs paths and dates, not full project cards.
export async function listRecentProjectFiles(
  folders: string[],
  individualFiles: string[],
  limit: number
): Promise<{ path: string; mtimeMs: number }[]> {
  const found = new Map<string, string>()
  for (const root of folders) {
    const files: string[] = []
    await collectBlendFiles(root, files, 0)
    for (const file of files) {
      if (!found.has(file)) found.set(file, root)
    }
  }
  for (const file of individualFiles) {
    if (file.toLowerCase().endsWith('.blend') && !found.has(file)) {
      found.set(file, dirname(file))
    }
  }
  const stats = await Promise.all(
    [...found.keys()].map(async (file) => {
      try {
        const fileStat = await stat(file)
        return { path: resolve(file), mtimeMs: fileStat.mtimeMs }
      } catch {
        return null
      }
    })
  )
  return stats
    .filter((entry): entry is { path: string; mtimeMs: number } => entry !== null)
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, limit)
}

// Registered folders whose root cannot be read (moved, renamed, drive offline).
// Their vanished files get one folder-level banner instead of per-file missing cards.
export async function listUnavailableFolders(folders: string[]): Promise<string[]> {
  const result: string[] = []
  for (const folder of folders) {
    try {
      if (!(await stat(folder)).isDirectory()) result.push(folder)
    } catch {
      result.push(folder)
    }
  }
  return result
}

/**
 * The project list as the page sees it. A file that moved on disk outside the launcher
 * is the same project at a new address, not a loss plus a newcomer: its history moves
 * with it before the scan memory is rewritten.
 */
export async function listProjectFiles(): Promise<{ files: BlendFileInfo[]; moved: MovedFile[] }> {
  const [folders, individualFiles, knownFiles, identities] = await Promise.all([
    getProjectFolders(),
    getProjectFiles(),
    getKnownFiles(),
    getFileIdentities()
  ])
  const scan = await scanProjectFiles(folders, individualFiles, knownFiles, identities)
  for (const move of scan.moved) {
    // same rule as moving a project from inside the launcher: only a file that ends up
    // outside every tracked folder needs an individual entry to stay listed
    const insideTracked = folders.some((root) => isPathUnder(move.to, root))
    await migrateProjectPath(move.from, move.to, !insideTracked)
  }
  await setScanMemory(scan.known, scan.identities)
  return { files: scan.files, moved: scan.moved }
}

export async function scanProjectFiles(
  folders: string[],
  individualFiles: string[] = [],
  knownFiles: string[] = [],
  identities: Record<string, FileIdentity> = {}
): Promise<{
  files: BlendFileInfo[]
  known: string[]
  identities: Record<string, FileIdentity>
  /** files recognised at a new place on disk — the caller carries their state over */
  moved: MovedFile[]
}> {
  const individualSet = new Set(individualFiles.map((path) => resolve(path)))
  const known = new Set(knownFiles.map((path) => resolve(path)))
  const folderRoots = folders.map((folder) => resolve(folder))
  const insideFolders = (p: string): boolean =>
    folderRoots.some((root) => {
      const rel = relative(root, p)
      return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
    })
  // files under an unreadable root are not reported missing one by one — the folder
  // itself is the missing thing, and config entries stay put until it is relocated
  const unavailableRoots = (await listUnavailableFolders(folders)).map((folder) => resolve(folder))
  const underUnavailable = (p: string): boolean =>
    unavailableRoots.some((root) => {
      const rel = relative(root, p)
      return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
    })

  const found = new Map<string, string>() // file path → folder it belongs to (first wins)
  const currentFolderPaths = new Set<string>() // resolved paths of files present in folders now
  for (const root of folders) {
    const files: string[] = []
    await collectBlendFiles(root, files, 0)
    for (const file of files) {
      currentFolderPaths.add(resolve(file))
      if (!found.has(file)) found.set(file, root)
    }
  }
  for (const file of individualFiles) {
    if (file.toLowerCase().endsWith('.blend') && !found.has(file)) {
      found.set(file, dirname(file))
    }
  }

  const result: BlendFileInfo[] = []
  // how every file found right now looks to the filesystem — the raw material for
  // recognising a file that shows up somewhere else in a later scan
  const seenIdentities = new Map<string, FileIdentity>()
  // vanished files are held back rather than reported straight away: one of the files
  // found in this same scan may turn out to be one of them, moved elsewhere on disk
  const vanished: { path: string; folder: string; tracked: boolean }[] = []
  for (const [file, root] of found) {
    // listed because of its individual entry: not among the folder-scanned files
    const tracked = individualSet.has(resolve(file)) && !currentFolderPaths.has(resolve(file))
    try {
      const fileStat = await stat(file)
      seenIdentities.set(resolve(file), identityOf(fileStat))
      const sidecar = await findPreviewSidecar(file)
      const sidecarStat = sidecar ? await stat(sidecar).catch(() => null) : null
      // the attributed root is part of the cached info: leaving it out of the key
      // kept files pinned to a folder the user had already stopped tracking
      const cacheKey = `${fileStat.mtimeMs}:${fileStat.size}|${sidecar ?? ''}:${sidecarStat?.mtimeMs ?? ''}|${tracked}|${root}`
      const cached = cache.get(file)
      if (cached && cached.key === cacheKey) {
        result.push(cached.info)
        continue
      }
      const parsed = await readBlendInfo(file)
      const custom = sidecar ? await loadCustomThumbnail(sidecar) : null
      const info: BlendFileInfo = {
        path: file,
        name: basename(file),
        folder: root,
        size: fileStat.size,
        mtimeMs: fileStat.mtimeMs,
        blenderVersion: parsed.version,
        thumbnail: custom ?? (parsed.thumbnail ? thumbnailToDataUrl(parsed.thumbnail) : null),
        hasCustomPreview: sidecar !== null,
        missing: false,
        tracked
      }
      cache.set(file, { key: cacheKey, info })
      result.push(info)
    } catch {
      // an individually-tracked file that vanished — surface it as missing so it can be relocated
      if (individualSet.has(resolve(file)) && !underUnavailable(resolve(file))) {
        vanished.push({ path: file, folder: root, tracked: true })
      }
      // folder-scanned files that fail to read are just skipped
    }
  }

  // folder files seen in a previous scan that are gone now → missing (unless folder removed)
  for (const kp of known) {
    if (currentFolderPaths.has(kp) || individualSet.has(kp)) continue
    if (!insideFolders(kp) || underUnavailable(kp)) continue
    vanished.push({ path: kp, folder: dirname(kp), tracked: false })
  }

  // a file this scan met for the first time is a possible new home for a vanished one
  const appeared: { path: string; identity: FileIdentity }[] = []
  for (const [path, identity] of seenIdentities) {
    if (!known.has(path) && !individualSet.has(path)) appeared.push({ path, identity })
  }
  const moved = matchMovedFiles(
    vanished
      .map((entry) => ({ path: resolve(entry.path), identity: identities[resolve(entry.path)] }))
      .filter((entry): entry is { path: string; identity: FileIdentity } => entry.identity !== undefined),
    appeared
  )
  const movedFrom = new Set(moved.map((move) => move.from))

  for (const entry of vanished) {
    if (movedFrom.has(resolve(entry.path))) continue
    result.push({
      path: entry.path,
      name: basename(entry.path),
      folder: entry.folder,
      size: 0,
      mtimeMs: 0,
      blenderVersion: null,
      thumbnail: null,
      hasCustomPreview: false,
      missing: true,
      tracked: entry.tracked
    })
  }

  // remember current + still-missing folder files for the next scan
  const newKnown = new Set<string>()
  for (const p of currentFolderPaths) if (insideFolders(p)) newKnown.add(p)
  for (const kp of known)
    if (
      !currentFolderPaths.has(kp) &&
      !individualSet.has(kp) &&
      insideFolders(kp) &&
      !movedFrom.has(kp)
    )
      newKnown.add(kp)

  // identities worth carrying to the next scan: what is on disk now, plus the last known
  // look of files still remembered as missing — those are the ones we may yet recognise
  const nextIdentities: Record<string, FileIdentity> = {}
  for (const [path, identity] of seenIdentities) nextIdentities[path] = identity
  for (const path of [...newKnown, ...individualSet]) {
    // a path that was just recognised elsewhere is dead: keeping its old look around
    // would make the very next scan rewrite the config for nothing
    if (movedFrom.has(path)) continue
    const remembered = identities[path]
    if (!nextIdentities[path] && remembered) nextIdentities[path] = remembered
  }

  return {
    files: result.sort((a, b) => b.mtimeMs - a.mtimeMs),
    known: [...newKnown],
    identities: nextIdentities,
    moved
  }
}
