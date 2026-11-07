import { app } from 'electron'
import { randomUUID } from 'crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { hostname } from 'os'
import { join } from 'path'

// A stable per-machine identity for cloud sync. It lives in Electron's userData
// dir — NOT in the portable data/ folder — precisely because it must be
// machine-local: two copies of a portable folder on two machines each get their
// own id, so their per-machine state/token files never collide when data/ is
// itself synced through Dropbox. The id is a random GUID; the hostname only
// makes the derived filenames human-readable.

const ID_FILE = 'cloud-machine-id'

let cached: string | null = null

function hostSlug(): string {
  const slug = hostname()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24)
  return slug || 'machine'
}

function readOrCreateGuid(): string {
  const path = join(app.getPath('userData'), ID_FILE)
  try {
    const existing = readFileSync(path, 'utf8').trim()
    if (/^[0-9a-f-]{36}$/.test(existing)) return existing
  } catch {
    // missing or unreadable — mint a fresh one below
  }
  const guid = randomUUID()
  try {
    mkdirSync(app.getPath('userData'), { recursive: true })
    writeFileSync(path, guid)
  } catch (error) {
    console.warn('[cloud-sync] could not persist machine id, using a volatile one:', error)
  }
  return guid
}

function guid(): string {
  cached ??= readOrCreateGuid()
  return cached
}

/** filename-safe machine tag: `<hostslug>-<guid8>`; the full guid is the identity. */
export function machineTag(): string {
  return `${hostSlug()}-${guid().slice(0, 8)}`
}

/** the full stable machine guid, written into per-machine files as `deviceId`. */
export function machineId(): string {
  return guid()
}

/**
 * Best-effort detection that the data folder is itself inside a file-sync client.
 * Only used to warn the user that cloud sync would duplicate what the folder
 * already does — never to block. Returns the provider name or null.
 */
export function detectCloudSyncedDataFolder(dataRoot: string): string | null {
  const lower = dataRoot.toLowerCase()
  const markers: Array<[string, string]> = [
    ['dropbox', 'Dropbox'],
    ['onedrive', 'OneDrive'],
    ['google drive', 'Google Drive'],
    ['googledrive', 'Google Drive'],
    ['\\my drive', 'Google Drive'],
    ['yandexdisk', 'Yandex Disk'],
    ['yandex.disk', 'Yandex Disk'],
    ['\\icloud', 'iCloud']
  ]
  for (const [needle, name] of markers) {
    if (lower.includes(needle)) return name
  }
  const homeMarker = join(app.getPath('home'), 'Dropbox').toLowerCase()
  if (existsSync(homeMarker) && lower.startsWith(homeMarker)) return 'Dropbox'
  return null
}
