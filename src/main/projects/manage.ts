import { constants, copyFile, cp, mkdir, readdir, rename, rm, stat } from 'fs/promises'
import { existsSync } from 'fs'
import { shell } from 'electron'
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'path'
import {
  addKeptFolder,
  addProjectFile,
  forgetProjectPath,
  forgetProjectPathsUnder,
  getProjectFiles,
  getProjectFolders,
  isPathUnder,
  migrateProjectPath,
  remapProjectPaths
} from './store'
import { isSkippedScanDir } from '../scan-skip'

export const PREVIEW_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp']

const EMPTY_CHECK_MAX_DEPTH = 8
// Proving a folder empty means walking all of it, and a tracked drive root would mean
// walking the drive. Past this many directories the answer is "assume something is in
// there": the folder simply is not kept — far better than stalling the operation.
const EMPTY_CHECK_MAX_DIRS = 400

/** stops at the first .blend — this only answers "is anything left in here?" */
async function holdsBlendFiles(dir: string, budget = { dirs: EMPTY_CHECK_MAX_DIRS }, depth = 0): Promise<boolean> {
  if (depth > EMPTY_CHECK_MAX_DEPTH) return false
  if (budget.dirs-- <= 0) return true
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return false
  }
  for (const entry of entries) {
    if (entry.isFile() && entry.name.toLowerCase().endsWith('.blend')) return true
  }
  for (const entry of entries) {
    if (entry.isDirectory() && !entry.name.startsWith('.')) {
      if (await holdsBlendFiles(join(dir, entry.name), budget, depth + 1)) return true
    }
  }
  return false
}

/**
 * A folder whose last project just left would drop out of the tree mid-gesture — the
 * user moved a file, not the folder. Keep it listed (dimmed) until they hide it.
 */
async function keepIfEmptied(dir: string): Promise<void> {
  try {
    if (!(await holdsBlendFiles(dir))) await addKeptFolder(dir)
  } catch {
    // best effort — never fail the operation the user actually asked for
  }
}

// A custom preview lives next to the .blend as "<name>-preview.<ext>", e.g.
// scene.blend → scene-preview.png. It is auto-detected on scan.
export function previewBaseName(blendPath: string): string {
  return basename(blendPath).replace(/\.blend$/i, '') + '-preview'
}

export async function findPreviewSidecar(blendPath: string): Promise<string | null> {
  const dir = dirname(blendPath)
  const base = previewBaseName(blendPath).toLowerCase()
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    return null
  }
  for (const name of entries) {
    const lower = name.toLowerCase()
    const dot = lower.lastIndexOf('.')
    if (dot < 0) continue
    if (lower.slice(0, dot) === base && PREVIEW_EXTENSIONS.includes(lower.slice(dot + 1))) {
      return join(dir, name)
    }
  }
  return null
}

async function moveFile(from: string, to: string): Promise<void> {
  try {
    await rename(from, to)
  } catch {
    // rename fails across drives — fall back to copy + delete
    await copyFile(from, to)
    await rm(from, { force: true })
  }
}

export async function setPreviewSidecar(blendPath: string, imagePath: string): Promise<void> {
  const existing = await findPreviewSidecar(blendPath)
  if (existing) await rm(existing, { force: true })
  const ext = (extname(imagePath).slice(1) || 'png').toLowerCase()
  const target = join(dirname(blendPath), `${previewBaseName(blendPath)}.${ext}`)
  await copyFile(imagePath, target)
}

export async function clearPreviewSidecar(blendPath: string): Promise<void> {
  const existing = await findPreviewSidecar(blendPath)
  if (existing) await shell.trashItem(existing)
}

export async function moveProject(blendPath: string, destDir: string): Promise<string> {
  const dir = resolve(destDir)
  const targetPath = join(dir, basename(blendPath))
  if (resolve(targetPath) === resolve(blendPath)) return resolve(blendPath)
  if (existsSync(targetPath)) throw new Error('A file with this name already exists in the destination')

  const sidecar = await findPreviewSidecar(blendPath)
  // never mkdir a destination that is already there: on Windows a drive root answers
  // EPERM rather than EEXIST, so dropping onto "D:\" would fail outright
  if (!existsSync(dir)) await mkdir(dir, { recursive: true })
  await moveFile(blendPath, targetPath)
  if (sidecar) {
    await moveFile(sidecar, join(dir, basename(sidecar))).catch(() => undefined)
  }
  // landing inside a tracked folder means the scan finds it again on its own; only a
  // file that ends up outside every root needs an individual entry to stay listed
  const roots = await getProjectFolders()
  const insideTracked = roots.some((root) => isPathUnder(targetPath, root))
  await migrateProjectPath(blendPath, targetPath, !insideTracked)
  await keepIfEmptied(dirname(blendPath))
  return targetPath
}

// Rename in place. The preview sidecar's name is derived from the .blend name, so it
// is renamed along, and config entries move to the new path without converting a
// folder-scanned file into an individually-tracked one.
export async function renameProject(blendPath: string, newFileName: string): Promise<string> {
  const dir = dirname(blendPath)
  const targetPath = join(dir, newFileName)
  if (resolve(targetPath) === resolve(blendPath)) return resolve(blendPath)
  // NTFS is case-insensitive: a case-only rename is legal even though the target "exists"
  const caseOnly = resolve(targetPath).toLowerCase() === resolve(blendPath).toLowerCase()
  if (!caseOnly && existsSync(targetPath)) {
    throw new Error('A file with this name already exists in this folder')
  }
  const sidecar = await findPreviewSidecar(blendPath)
  await moveFile(blendPath, targetPath)
  if (sidecar) {
    await moveFile(sidecar, join(dir, `${previewBaseName(targetPath)}${extname(sidecar)}`)).catch(
      () => undefined
    )
  }
  await migrateProjectPath(blendPath, targetPath, false)
  return targetPath
}

// Copy next to the original as "<name> copy.blend" ("<name> copy 2.blend", …), the
// custom preview sidecar included. An individually-tracked source gets its copy
// tracked too — a folder-scanned one is picked up by the next scan on its own.
// Returns the copy's real stat so the renderer can place the card exactly where
// the reconcile scan will put it.
export async function duplicateProject(
  blendPath: string
): Promise<{ path: string; mtimeMs: number; size: number }> {
  const dir = dirname(blendPath)
  const base = basename(blendPath).replace(/\.blend$/i, '')
  let targetPath = join(dir, `${base} copy.blend`)
  for (let n = 2; existsSync(targetPath); n++) {
    if (n > 99) throw new Error('Too many copies of this file')
    targetPath = join(dir, `${base} copy ${n}.blend`)
  }
  // COPYFILE_EXCL: fail instead of overwriting if the target appears mid-operation
  await copyFile(blendPath, targetPath, constants.COPYFILE_EXCL)
  const sidecar = await findPreviewSidecar(blendPath)
  if (sidecar) {
    await copyFile(sidecar, join(dir, `${previewBaseName(targetPath)}${extname(sidecar)}`)).catch(
      () => undefined
    )
  }
  const tracked = await getProjectFiles()
  if (tracked.some((known) => resolve(known) === resolve(blendPath))) {
    await addProjectFile(targetPath)
  }
  const copyStat = await stat(targetPath)
  return { path: targetPath, mtimeMs: copyStat.mtimeMs, size: copyStat.size }
}

// Folder operations behind the Projects tree's context menu. Every one of them ends
// by rewriting the stored paths, so projects inside keep their list entry, their
// recents and their tracking instead of turning up missing on the next scan.

export async function renameFolderOnDisk(folderPath: string, newName: string): Promise<string> {
  const targetPath = join(dirname(folderPath), newName)
  if (resolve(targetPath) === resolve(folderPath)) return resolve(folderPath)
  // NTFS is case-insensitive: a case-only rename is legal even though the target "exists"
  const caseOnly = resolve(targetPath).toLowerCase() === resolve(folderPath).toLowerCase()
  if (!caseOnly && existsSync(targetPath)) {
    throw new Error('A folder with this name already exists here')
  }
  await rename(folderPath, targetPath)
  await remapProjectPaths(folderPath, targetPath)
  return targetPath
}

export async function moveFolderOnDisk(folderPath: string, destDir: string): Promise<string> {
  const dir = resolve(destDir)
  const targetPath = join(dir, basename(folderPath))
  if (resolve(targetPath) === resolve(folderPath)) return resolve(folderPath)
  // moving a folder inside itself would eat it
  if (isPathUnder(dir, folderPath)) throw new Error('Cannot move a folder into itself')
  if (existsSync(targetPath)) {
    throw new Error('A folder with this name already exists in the destination')
  }
  // see moveProject: mkdir on an existing drive root throws EPERM on Windows
  if (!existsSync(dir)) await mkdir(dir, { recursive: true })
  try {
    await rename(folderPath, targetPath)
  } catch {
    // rename fails across volumes — copy, then drop the source only once the copy is whole
    try {
      await cp(folderPath, targetPath, { recursive: true, errorOnExist: true, force: false })
    } catch (cause) {
      await rm(targetPath, { recursive: true, force: true }).catch(() => undefined)
      throw cause
    }
    await rm(folderPath, { recursive: true, force: true })
  }
  await remapProjectPaths(folderPath, targetPath)
  await keepIfEmptied(dirname(folderPath))
  return targetPath
}

export async function deleteFolderToTrash(folderPath: string): Promise<void> {
  // Application Security Requirement: user-initiated deletion goes through the OS trash
  // rather than an unrecoverable unlink — a folder holds far more than its .blend files.
  if (existsSync(folderPath)) await shell.trashItem(resolve(folderPath))
  await forgetProjectPathsUnder(folderPath)
}

export async function deleteProject(blendPath: string): Promise<void> {
  const sidecar = await findPreviewSidecar(blendPath)
  // Application Security Requirement: user-initiated file deletion goes through the OS
  // trash (shell.trashItem) rather than an unrecoverable unlink, so a mistaken delete
  // of project data can still be restored from the Recycle Bin / Trash.
  if (existsSync(blendPath)) await shell.trashItem(blendPath)
  if (sidecar && existsSync(sidecar)) await shell.trashItem(sidecar)
  await forgetProjectPath(blendPath)
  await keepIfEmptied(dirname(blendPath))
}

const SEARCH_MAX_DEPTH = 8

async function searchForFile(dir: string, targetLower: string, depth: number): Promise<string | null> {
  if (depth > SEARCH_MAX_DEPTH) return null
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return null
  }
  for (const entry of entries) {
    if (entry.isFile() && entry.name.toLowerCase() === targetLower) return join(dir, entry.name)
  }
  for (const entry of entries) {
    if (entry.isDirectory() && !isSkippedScanDir(entry.name)) {
      const hit = await searchForFile(join(dir, entry.name), targetLower, depth + 1)
      if (hit) return hit
    }
  }
  return null
}

// Search a folder for a file with the missing file's name and re-point the project at it.
export async function findMissingFile(oldPath: string, searchDir: string): Promise<string | null> {
  const found = await searchForFile(resolve(searchDir), basename(oldPath).toLowerCase(), 0)
  if (!found) return null
  await migrateProjectPath(oldPath, found)
  return found
}

const MAX_RELINK_CANDIDATES = 2000

async function collectBlendCandidates(dir: string, out: string[], depth: number): Promise<void> {
  if (depth > SEARCH_MAX_DEPTH || out.length >= MAX_RELINK_CANDIDATES) return
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (out.length >= MAX_RELINK_CANDIDATES) return
    if (isSkippedScanDir(entry.name)) continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) await collectBlendCandidates(full, out, depth + 1)
    else if (entry.isFile() && entry.name.toLowerCase().endsWith('.blend')) out.push(full)
  }
}

// How many trailing path segments two paths share — "moved folder" keeps the old
// subfolder layout, so the candidate whose tail matches longest is the right one.
function tailMatchScore(a: string, b: string): number {
  const as = resolve(a).toLowerCase().split(/[\\/]/)
  const bs = resolve(b).toLowerCase().split(/[\\/]/)
  let n = 0
  while (n < as.length && n < bs.length && as[as.length - 1 - n] === bs[bs.length - 1 - n]) n++
  return n
}

// Batch findMissingFile: walk the picked folder once, then give each missing project
// the best same-named candidate. Each candidate is consumed at most once, so two
// missing files with equal names cannot collapse onto a single file.
export async function relinkMissingFiles(
  missingPaths: string[],
  searchDir: string,
  registeredFolders: string[]
): Promise<number> {
  const candidates: string[] = []
  await collectBlendCandidates(resolve(searchDir), candidates, 0)
  const byName = new Map<string, string[]>()
  for (const candidate of candidates) {
    const key = basename(candidate).toLowerCase()
    const list = byName.get(key)
    if (list) list.push(candidate)
    else byName.set(key, [candidate])
  }
  const roots = registeredFolders.map((folder) => resolve(folder))
  const insideRegistered = (p: string): boolean =>
    roots.some((root) => {
      const rel = relative(root, resolve(p))
      return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
    })
  const used = new Set<string>()
  let relinked = 0
  for (const oldPath of [...missingPaths].sort()) {
    const options = byName.get(basename(oldPath).toLowerCase())?.filter((c) => !used.has(c)) ?? []
    if (options.length === 0) continue
    let best = options[0]
    let bestScore = tailMatchScore(oldPath, best)
    for (const option of options.slice(1)) {
      const score = tailMatchScore(oldPath, option)
      if (score > bestScore) {
        best = option
        bestScore = score
      }
    }
    used.add(best)
    // a file that lands outside every registered folder must become individually
    // tracked, or it would vanish from the list right after relinking
    await migrateProjectPath(oldPath, best, !insideRegistered(best))
    relinked++
  }
  return relinked
}
