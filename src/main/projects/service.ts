import { nativeImage } from 'electron'
import { readdir, stat } from 'fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'path'
import { readBlendInfo } from '../blender/blend-parser'
import { findPreviewSidecar } from './manage'
import type { BlendThumbnail } from '../blender/blend-parser'
import type { BlendFileInfo } from '../../shared/types'
import type { ProjectOverride } from '../config'

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
    if (entry.name.startsWith('.')) continue
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

export async function scanProjectFiles(
  folders: string[],
  individualFiles: string[] = [],
  hiddenFiles: string[] = [],
  overrides: Record<string, ProjectOverride> = {},
  knownFiles: string[] = []
): Promise<{ files: BlendFileInfo[]; known: string[] }> {
  const hidden = new Set(hiddenFiles.map((path) => resolve(path)))
  const individualSet = new Set(individualFiles.map((path) => resolve(path)))
  const known = new Set(knownFiles.map((path) => resolve(path)))
  const folderRoots = folders.map((folder) => resolve(folder))
  const insideFolders = (p: string): boolean =>
    folderRoots.some((root) => {
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
      if (!found.has(file) && !hidden.has(resolve(file))) found.set(file, root)
    }
  }
  for (const file of individualFiles) {
    if (file.toLowerCase().endsWith('.blend') && !found.has(file) && !hidden.has(resolve(file))) {
      found.set(file, dirname(file))
    }
  }

  const result: BlendFileInfo[] = []
  for (const [file, root] of found) {
    try {
      const fileStat = await stat(file)
      const displayName = overrides[resolve(file)]?.displayName ?? null
      const sidecar = await findPreviewSidecar(file)
      const sidecarStat = sidecar ? await stat(sidecar).catch(() => null) : null
      const cacheKey = `${fileStat.mtimeMs}:${fileStat.size}|${sidecar ?? ''}:${sidecarStat?.mtimeMs ?? ''}|${displayName ?? ''}`
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
        displayName,
        folder: root,
        size: fileStat.size,
        mtimeMs: fileStat.mtimeMs,
        blenderVersion: parsed.version,
        thumbnail: custom ?? (parsed.thumbnail ? thumbnailToDataUrl(parsed.thumbnail) : null),
        hasCustomPreview: sidecar !== null,
        missing: false
      }
      cache.set(file, { key: cacheKey, info })
      result.push(info)
    } catch {
      // an individually-tracked file that vanished — surface it as missing so it can be relocated
      if (individualSet.has(resolve(file))) {
        result.push({
          path: file,
          name: basename(file),
          displayName: overrides[resolve(file)]?.displayName ?? null,
          folder: root,
          size: 0,
          mtimeMs: 0,
          blenderVersion: null,
          thumbnail: null,
          hasCustomPreview: false,
          missing: true
        })
      }
      // folder-scanned files that fail to read are just skipped
    }
  }

  // folder files seen in a previous scan that are gone now → missing (unless hidden / folder removed)
  for (const kp of known) {
    if (currentFolderPaths.has(kp) || hidden.has(kp) || individualSet.has(kp)) continue
    if (!insideFolders(kp)) continue
    result.push({
      path: kp,
      name: basename(kp),
      displayName: overrides[kp]?.displayName ?? null,
      folder: dirname(kp),
      size: 0,
      mtimeMs: 0,
      blenderVersion: null,
      thumbnail: null,
      hasCustomPreview: false,
      missing: true
    })
  }

  // remember current + still-missing folder files (in-folder, not hidden) for the next scan
  const newKnown = new Set<string>()
  for (const p of currentFolderPaths) if (!hidden.has(p) && insideFolders(p)) newKnown.add(p)
  for (const kp of known)
    if (!currentFolderPaths.has(kp) && !hidden.has(kp) && !individualSet.has(kp) && insideFolders(kp))
      newKnown.add(kp)

  return { files: result.sort((a, b) => b.mtimeMs - a.mtimeMs), known: [...newKnown] }
}
