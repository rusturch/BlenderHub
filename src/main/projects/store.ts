import { isAbsolute, join, relative, resolve } from 'path'
import { readConfig, updateConfig } from '../config'

export async function getProjectFolders(): Promise<string[]> {
  return (await readConfig()).projectFolders
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
      projectFiles: [...new Set(config.projectFiles.map(remap))],
      knownFiles: [...new Set(config.knownFiles.map(remap))],
      recentlyOpened
    }
  })
}

/** The registered folder moved on disk: re-point the registration and everything under it. */
export const relocateProjectFolder = remapProjectPaths

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
      projectFiles: config.projectFiles.filter((known) => !isPathUnder(known, rootKey)),
      knownFiles: config.knownFiles.filter((known) => !isPathUnder(known, rootKey)),
      recentlyOpened
    }
  })
}

// "Remove from list": drop entries from individual tracking and scan memory, leaving
// the files themselves alone. A file that is (or later reappears) inside a tracked
// folder is simply picked up by the next scan again.
export async function untrackProjectPaths(paths: string[]): Promise<void> {
  if (paths.length === 0) return
  const keys = new Set(paths.map((path) => resolve(path)))
  await updateConfig((config) => ({
    ...config,
    projectFiles: config.projectFiles.filter((known) => !keys.has(resolve(known))),
    knownFiles: config.knownFiles.filter((known) => !keys.has(resolve(known)))
  }))
}

export async function getProjectFiles(): Promise<string[]> {
  return (await readConfig()).projectFiles
}

export async function addProjectFile(file: string): Promise<void> {
  const normalized = resolve(file)
  await updateConfig((config) => ({
    ...config,
    projectFiles: config.projectFiles.some((known) => resolve(known) === normalized)
      ? config.projectFiles
      : [...config.projectFiles, normalized]
  }))
}

export async function getKnownFiles(): Promise<string[]> {
  return (await readConfig()).knownFiles
}

export async function setKnownFiles(files: string[]): Promise<void> {
  await updateConfig((config) => ({ ...config, knownFiles: files }))
}

// After moving a file: carry its list membership and recents over to the new path.
// alwaysTrack=false (rename in place) only keeps an existing individual-tracking entry
// instead of converting folder-scanned files into individually-tracked ones.
export async function migrateProjectPath(
  oldPath: string,
  newPath: string,
  alwaysTrack = true
): Promise<void> {
  const oldKey = resolve(oldPath)
  const newKey = resolve(newPath)
  await updateConfig((config) => {
    const wasTracked = config.projectFiles.some((known) => resolve(known) === oldKey)
    const projectFiles = config.projectFiles.filter((known) => resolve(known) !== oldKey)
    if ((alwaysTrack || wasTracked) && !projectFiles.some((known) => resolve(known) === newKey)) {
      projectFiles.push(newKey)
    }
    const recentlyOpened = { ...config.recentlyOpened }
    if (recentlyOpened[oldKey] !== undefined) {
      recentlyOpened[newKey] = recentlyOpened[oldKey]
      delete recentlyOpened[oldKey]
    }
    return {
      ...config,
      projectFiles,
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
      projectFiles: config.projectFiles.filter((known) => resolve(known) !== key),
      knownFiles: config.knownFiles.filter((known) => resolve(known) !== key),
      recentlyOpened
    }
  })
}
