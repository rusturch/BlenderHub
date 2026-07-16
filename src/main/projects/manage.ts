import { copyFile, mkdir, readdir, rename, rm } from 'fs/promises'
import { existsSync } from 'fs'
import { shell } from 'electron'
import { basename, dirname, extname, join, resolve } from 'path'
import { forgetProjectPath, migrateProjectPath } from './store'

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
