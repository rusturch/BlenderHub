import { existsSync } from 'fs'
import { dirname, isAbsolute, join, relative, resolve } from 'path'
import { readConfig, updateConfig } from '../config'
import type { FileIdentity } from '../config'

// Folders are the only thing the launcher tracks. Older versions also kept a list of
// single .blend files; a file listed that way now stands for the folder it lives in.
// Entries whose file is gone are dropped — a dead path is no reason to start watching
// a folder. Runs once per process, ahead of the first read of the folder list.
let legacyFilesAdopted: Promise<void> | null = null

function adoptLegacyFiles(): Promise<void> {
  legacyFilesAdopted ??= updateConfig((config) => {
    if (config.projectFiles.length === 0) return config
    const projectFolders = [...config.projectFolders]
    for (const file of config.projectFiles) {
      const folder = dirname(resolve(file))
      if (!existsSync(file)) continue
      if (!projectFolders.some((known) => isPathUnder(folder, known))) projectFolders.push(folder)
    }
    return { ...config, projectFolders, projectFiles: [] }
  }).then(
    () => undefined,
    (error) => {
      // a locked config must not poison every later read: try again next time
      legacyFilesAdopted = null
      throw error
    }
  )
  return legacyFilesAdopted
}

export async function getProjectFolders(): Promise<string[]> {
  await adoptLegacyFiles()
  return (await readConfig()).projectFolders
}

/**
 * Makes sure the launcher lists what lives in `folder`: registers it unless a tracked
 * folder already covers it. This is how anything pointed at from outside the tracked
 * set (a dropped file, a new project, a move destination) stays visible.
 */
export async function ensureFolderTracked(folder: string): Promise<void> {
  const normalized = resolve(folder)
  const folders = await getProjectFolders()
  if (folders.some((known) => isPathUnder(normalized, known))) return
  await addProjectFolder(normalized)
}

export async function addProjectFolder(folder: string): Promise<void> {
  const normalized = resolve(folder)
  await updateConfig((config) => ({
    ...config,
    projectFolders: config.projectFolders.includes(normalized)
      ? config.projectFolders
      : [...config.projectFolders, normalized]
  }))
}

export async function removeProjectFolder(folder: string): Promise<void> {
  await updateConfig((config) => ({
    ...config,
    projectFolders: config.projectFolders.filter((known) => known !== folder)
  }))
}

/** true when `path` is `root` itself or lives inside it */
export function isPathUnder(path: string, root: string): boolean {
  const rel = relative(resolve(root), resolve(path))
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/**
 * A folder changed place on disk (relocated, renamed or moved): rewrite the old prefix
 * in every stored path. Registered roots are remapped by prefix too, so a tracked
 * folder nested inside the one that moved follows along instead of going missing.
 */
export async function remapProjectPaths(oldRoot: string, newRoot: string): Promise<void> {
  const oldKey = resolve(oldRoot)
  const newKey = resolve(newRoot)
  if (oldKey === newKey) return
  const remap = (p: string): string =>
    isPathUnder(p, oldKey) ? join(newKey, relative(oldKey, resolve(p))) : p
  await updateConfig((config) => {
    const recentlyOpened: Record<string, number> = {}
    for (const [path, openedAt] of Object.entries(config.recentlyOpened)) {
      const next = remap(path)
      recentlyOpened[next] = Math.max(recentlyOpened[next] ?? 0, openedAt)
    }
    return {
      ...config,
      projectFolders: [...new Set(config.projectFolders.map(remap))],
      knownFiles: [...new Set(config.knownFiles.map(remap))],
      keptFolders: [...new Set(config.keptFolders.map(remap))],
      favoriteFolders: [...new Set(config.favoriteFolders.map(remap))],
      recentlyOpened
    }
  })
}

/** The registered folder moved on disk: re-point the registration and everything under it. */
export const relocateProjectFolder = remapProjectPaths

/**
 * Folders the tree keeps showing while they hold no .blend: created from the tree, or
 * left empty after their last project moved away. They stay listed (dimmed) until the
 * user hides them, so work in progress does not vanish mid-gesture.
 */
export async function getKeptFolders(): Promise<string[]> {
  return (await readConfig()).keptFolders
}

export async function addKeptFolder(folder: string): Promise<void> {
  const normalized = resolve(folder)
  await updateConfig((config) =>
    config.keptFolders.some((known) => resolve(known) === normalized)
      ? config
      : { ...config, keptFolders: [...config.keptFolders, normalized] }
  )
}

export async function removeKeptFolders(folders: string[]): Promise<void> {
  if (folders.length === 0) return
  const keys = new Set(folders.map((folder) => resolve(folder)))
  await updateConfig((config) => ({
    ...config,
    keptFolders: config.keptFolders.filter((known) => !keys.has(resolve(known)))
  }))
}

export async function clearKeptFolders(): Promise<void> {
  await updateConfig((config) => ({ ...config, keptFolders: [] }))
}

/** Starred folders: quick filters above the grid, marked with a star in the tree. */
export async function getFavoriteFolders(): Promise<string[]> {
  return (await readConfig()).favoriteFolders
}

export async function setFavoriteFolder(folder: string, favorite: boolean): Promise<void> {
  const normalized = resolve(folder)
  await updateConfig((config) => {
    const without = config.favoriteFolders.filter((known) => resolve(known) !== normalized)
    return { ...config, favoriteFolders: favorite ? [...without, normalized] : without }
  })
}

export async function removeFavoriteFolders(folders: string[]): Promise<void> {
  if (folders.length === 0) return
  const keys = new Set(folders.map((folder) => resolve(folder)))
  await updateConfig((config) => ({
    ...config,
    favoriteFolders: config.favoriteFolders.filter((known) => !keys.has(resolve(known)))
  }))
}

/** A folder is gone (deleted): drop every stored path inside it, tracking included. */
export async function forgetProjectPathsUnder(root: string): Promise<void> {
  const rootKey = resolve(root)
  await updateConfig((config) => {
    const recentlyOpened: Record<string, number> = {}
    for (const [path, openedAt] of Object.entries(config.recentlyOpened)) {
      if (!isPathUnder(path, rootKey)) recentlyOpened[path] = openedAt
    }
    return {
      ...config,
      projectFolders: config.projectFolders.filter((known) => !isPathUnder(known, rootKey)),
      knownFiles: config.knownFiles.filter((known) => !isPathUnder(known, rootKey)),
      keptFolders: config.keptFolders.filter((known) => !isPathUnder(known, rootKey)),
      favoriteFolders: config.favoriteFolders.filter((known) => !isPathUnder(known, rootKey)),
      recentlyOpened
    }
  })
}

// Forget remembered paths without touching the files: a file that is still (or later
// reappears) inside a tracked folder is simply picked up by the next scan again.
export async function untrackProjectPaths(paths: string[]): Promise<void> {
  if (paths.length === 0) return
  const keys = new Set(paths.map((path) => resolve(path)))
  await updateConfig((config) => ({
    ...config,
    knownFiles: config.knownFiles.filter((known) => !keys.has(resolve(known)))
  }))
}

export async function getKnownFiles(): Promise<string[]> {
  return (await readConfig()).knownFiles
}

export async function getFileIdentities(): Promise<Record<string, FileIdentity>> {
  return (await readConfig()).fileIdentities
}

function sameIdentities(
  a: Record<string, FileIdentity>,
  b: Record<string, FileIdentity>
): boolean {
  const keys = Object.keys(a)
  if (keys.length !== Object.keys(b).length) return false
  return keys.every((key) => {
    const left = a[key]
    const right = b[key]
    return (
      right !== undefined &&
      left.size === right.size &&
      left.mtimeMs === right.mtimeMs &&
      left.ino === right.ino &&
      left.dev === right.dev
    )
  })
}

/** What the next scan needs to remember: the file list and how those files looked. */
export async function setScanMemory(
  files: string[],
  identities: Record<string, FileIdentity>
): Promise<void> {
  await updateConfig((config) => {
    const sameKnown =
      config.knownFiles.length === files.length &&
      config.knownFiles.every((path, index) => path === files[index])
    // an unchanged scan must not rewrite the config file — that is every idle refresh
    if (sameKnown && sameIdentities(config.fileIdentities, identities)) return config
    return { ...config, knownFiles: files, fileIdentities: identities }
  })
}

// After a file changed place: its recents entry follows, the old path is forgotten.
// Whether the file stays listed is decided by folders alone — see ensureFolderTracked.
export async function migrateProjectPath(oldPath: string, newPath: string): Promise<void> {
  const oldKey = resolve(oldPath)
  const newKey = resolve(newPath)
  await updateConfig((config) => {
    const recentlyOpened = { ...config.recentlyOpened }
    if (recentlyOpened[oldKey] !== undefined) {
      recentlyOpened[newKey] = recentlyOpened[oldKey]
      delete recentlyOpened[oldKey]
    }
    return {
      ...config,
      knownFiles: config.knownFiles.filter((known) => resolve(known) !== oldKey),
      recentlyOpened
    }
  })
}

// keep a small buffer beyond what the tray shows — a couple of recent entries can
// point at since-deleted files, and the caller filters those out at read time
const MAX_TRACKED_RECENTS = 20

/** Record "opened via the launcher, right now" — the tray's Recent Projects reads this. */
export async function recordProjectOpened(path: string): Promise<void> {
  const key = resolve(path)
  await updateConfig((config) => {
    const next = { ...config.recentlyOpened, [key]: Date.now() }
    const trimmed = Object.entries(next)
      .sort((a, b) => b[1] - a[1])
      .slice(0, MAX_TRACKED_RECENTS)
    return { ...config, recentlyOpened: Object.fromEntries(trimmed) }
  })
}

export async function getRecentlyOpened(limit: number): Promise<{ path: string; openedAt: number }[]> {
  const { recentlyOpened } = await readConfig()
  return Object.entries(recentlyOpened)
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([path, openedAt]) => ({ path, openedAt }))
}

// After deleting a file: drop every trace of it from config.
export async function forgetProjectPath(path: string): Promise<void> {
  const key = resolve(path)
  await updateConfig((config) => {
    const recentlyOpened = { ...config.recentlyOpened }
    delete recentlyOpened[key]
    return {
      ...config,
      knownFiles: config.knownFiles.filter((known) => resolve(known) !== key),
      recentlyOpened
    }
  })
}
