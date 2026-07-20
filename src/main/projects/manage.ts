import { constants, copyFile, mkdir, readdir, rename, rm, stat } from 'fs/promises'
import { existsSync } from 'fs'
import { shell } from 'electron'
import { basename, dirname, extname, join, resolve } from 'path'
import { addProjectFile, forgetProjectPath, getProjectFiles, migrateProjectPath } from './store'

export const PREVIEW_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp']

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
  await mkdir(dir, { recursive: true })
  await moveFile(blendPath, targetPath)
  if (sidecar) {
    await moveFile(sidecar, join(dir, basename(sidecar))).catch(() => undefined)
  }
  await migrateProjectPath(blendPath, targetPath)
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

export async function deleteProject(blendPath: string): Promise<void> {
  const sidecar = await findPreviewSidecar(blendPath)
  // Application Security Requirement: user-initiated file deletion goes through the OS
  // trash (shell.trashItem) rather than an unrecoverable unlink, so a mistaken delete
  // of project data can still be restored from the Recycle Bin / Trash.
  if (existsSync(blendPath)) await shell.trashItem(blendPath)
  if (sidecar && existsSync(sidecar)) await shell.trashItem(sidecar)
  await forgetProjectPath(blendPath)
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
    if (entry.isDirectory() && !entry.name.startsWith('.')) {
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
