import { isAbsolute, relative, resolve } from 'path'
import { readConfig, updateConfig } from '../config'

export async function getProjectFolders(): Promise<string[]> {
  return (await readConfig()).projectFolders
}

export async function addProjectFolder(folder: string): Promise<void> {
  const normalized = resolve(folder)
  const isInside = (p: string): boolean => {
    const rel = relative(normalized, resolve(p))
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
  }
  // re-adding a folder brings back any files inside it that were removed from the list
  await updateConfig((config) => ({
    ...config,
    projectFolders: config.projectFolders.includes(normalized)
      ? config.projectFolders
      : [...config.projectFolders, normalized],
    hiddenFiles: config.hiddenFiles.filter((p) => !isInside(p))
  }))
}

export async function removeProjectFolder(folder: string): Promise<void> {
  await updateConfig((config) => ({
    ...config,
    projectFolders: config.projectFolders.filter((known) => known !== folder)
  }))
}

export async function getProjectFiles(): Promise<string[]> {
  return (await readConfig()).projectFiles
}

export async function addProjectFile(file: string): Promise<void> {
  const normalized = resolve(file)
  // adding a file explicitly un-hides it — otherwise a prior "Remove from list"
  // would keep it filtered out of scan results forever
  await updateConfig((config) => ({
    ...config,
    projectFiles: config.projectFiles.some((known) => resolve(known) === normalized)
      ? config.projectFiles
      : [...config.projectFiles, normalized],
    hiddenFiles: config.hiddenFiles.filter((known) => resolve(known) !== normalized)
  }))
}

export async function removeProjectFile(file: string): Promise<void> {
  const normalized = resolve(file)
  await updateConfig((config) => ({
    ...config,
    projectFiles: config.projectFiles.filter((known) => resolve(known) !== normalized)
  }))
}

export async function getHiddenFiles(): Promise<string[]> {
  return (await readConfig()).hiddenFiles
}

export async function addHiddenFile(file: string): Promise<void> {
  const key = resolve(file)
  await updateConfig((config) =>
    config.hiddenFiles.some((known) => resolve(known) === key)
      ? config
      : { ...config, hiddenFiles: [...config.hiddenFiles, key] }
  )
}

export async function removeHiddenFile(file: string): Promise<void> {
  const key = resolve(file)
  await updateConfig((config) => ({
    ...config,
    hiddenFiles: config.hiddenFiles.filter((known) => resolve(known) !== key)
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
      hiddenFiles: config.hiddenFiles.filter((known) => resolve(known) !== oldKey),
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
      hiddenFiles: config.hiddenFiles.filter((known) => resolve(known) !== key),
      knownFiles: config.knownFiles.filter((known) => resolve(known) !== key),
      recentlyOpened
    }
  })
}
