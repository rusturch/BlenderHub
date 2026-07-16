import { mkdir, readdir, readFile, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { randomBytes } from 'crypto'
import { shell } from 'electron'
import { getDataRoot } from '../paths'
import type { SettingsBackupInfo, SyncComponentId } from '../../shared/types'
import { copyComponentItems, expandEntries, measureComponent } from './components'
import type { ResolvedItem } from './components'

// Snapshots live under <dataRoot>/settings-backups/<minor>/<id>/ with meta.json at the
// snapshot root and the captured tree under files/. meta.json IS the record of truth:
// snapshots stay self-contained (survive config.json resets, deletable by hand) and
// listing them is a readdir — config.json is not involved at all.

const KEEP_PER_MINOR = 10

const backupsRoot = (): string => join(getDataRoot(), 'settings-backups')

export interface StoredBackup {
  info: SettingsBackupInfo
  dir: string
}

async function readSnapshot(minor: string, id: string): Promise<StoredBackup | null> {
  const dir = join(backupsRoot(), minor, id)
  try {
    const parsed = JSON.parse(await readFile(join(dir, 'meta.json'), 'utf8')) as SettingsBackupInfo
    // a broken or foreign folder never breaks the listing — it is simply not shown
    if (typeof parsed?.id !== 'string' || parsed.id !== id) return null
    return { info: parsed, dir }
  } catch {
    return null
  }
}

async function listStored(): Promise<StoredBackup[]> {
  let minors: string[] = []
  try {
    minors = (await readdir(backupsRoot(), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
  } catch {
    return []
  }
  const all: StoredBackup[] = []
  for (const minor of minors) {
    let ids: string[] = []
    try {
      ids = (await readdir(join(backupsRoot(), minor), { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
    } catch {
      continue
    }
    for (const id of ids) {
      const snapshot = await readSnapshot(minor, id)
      if (snapshot) all.push(snapshot)
    }
  }
  all.sort((a, b) => b.info.createdAt.localeCompare(a.info.createdAt))
  return all
}

export async function listBackups(): Promise<SettingsBackupInfo[]> {
  return (await listStored()).map((snapshot) => snapshot.info)
}

/** resolve a renderer-sent id strictly through our own listing — never by joining it into a path */
export async function findBackup(id: string): Promise<StoredBackup> {
  const found = (await listStored()).find((snapshot) => snapshot.info.id === id)
  if (!found) throw new Error('Backup not found')
  return found
}

async function pruneMinor(minor: string): Promise<void> {
  const stored = (await listStored()).filter((snapshot) => snapshot.info.minor === minor)
  for (const extra of stored.slice(KEEP_PER_MINOR)) {
    // auto-prune skips the OS trash on purpose — silently filling it would be worse
    await rm(extra.dir, { recursive: true, force: true })
  }
}

/** snapshot a version's current files before an overwrite; null when nothing exists yet */
export async function createSnapshot(
  minor: string,
  base: string,
  components: SyncComponentId[],
  reason: 'sync' | 'restore',
  sourceMinor: string | null
): Promise<SettingsBackupInfo | null> {
  const present: { component: SyncComponentId; items: ResolvedItem[] }[] = []
  for (const component of components) {
    const items = await expandEntries(base, component)
    if (items.length > 0) present.push({ component, items })
  }
  if (present.length === 0) return null
  const id = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomBytes(2).toString('hex')}`
  const dir = join(backupsRoot(), minor, id)
  const filesDir = join(dir, 'files')
  await mkdir(filesDir, { recursive: true })
  try {
    let bytes = 0
    for (const { component, items } of present) {
      await copyComponentItems(base, filesDir, items)
      bytes += (await measureComponent(filesDir, component)).bytes
    }
    const info: SettingsBackupInfo = {
      id,
      minor,
      createdAt: new Date().toISOString(),
      reason,
      components: present.map(({ component }) => component),
      sourceMinor,
      bytes
    }
    await writeFile(join(dir, 'meta.json'), JSON.stringify(info, null, 2))
    await pruneMinor(minor)
    return info
  } catch (error) {
    // never leave a half-written snapshot behind — without meta.json it would be invisible
    await rm(dir, { recursive: true, force: true })
    throw error
  }
}

export async function deleteBackup(id: string): Promise<SettingsBackupInfo[]> {
  const { dir } = await findBackup(id)
  try {
    await shell.trashItem(dir)
  } catch {
    await rm(dir, { recursive: true, force: true })
  }
  return listBackups()
}

export async function revealBackup(id: string): Promise<void> {
  const { dir } = await findBackup(id)
  shell.showItemInFolder(join(dir, 'meta.json'))
}
