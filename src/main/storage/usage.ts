import { existsSync } from 'fs'
import type { Dirent } from 'fs'
import { readdir, stat } from 'fs/promises'
import { join, resolve } from 'path'
import { getDataRoot } from '../paths'
import { getDownloadsDir, getInstallsDir, listInstalled } from '../blender/installs'
import { getLibraryDir } from '../addons/library'
import { getAssetsDir } from '../asset-library/service'
import type { StorageCategoryUsage, StorageInstallUsage, StorageUsage } from '../../shared/types'

// How much disk each part of the launcher's portable data folder takes, so the
// Settings page can show "what eats the space" (installs dominate — gigabytes).
// This is a pure read-only stat walk: no config writes, no Blender launch, so it
// needs no op-lock and can run freely alongside anything else.

const BACKUPS_DIR_NAME = 'settings-backups'

/**
 * Recursively sum the size of regular files under `dir`. Symlinks are NOT followed
 * (a macOS build bundle may contain one; following it could escape the tree or
 * double-count), and entries that vanish or are unreadable mid-walk are skipped
 * rather than failing the whole tally. Missing directory → 0.
 */
async function dirSize(dir: string): Promise<number> {
  const entries = await readdir(dir, { withFileTypes: true }).catch((): Dirent[] => [])
  const sizes = await Promise.all(
    entries.map(async (entry) => {
      if (entry.isSymbolicLink()) return 0
      const full = join(dir, entry.name)
      if (entry.isDirectory()) return dirSize(full)
      if (entry.isFile()) {
        try {
          return (await stat(full)).size
        } catch {
          return 0
        }
      }
      return 0
    })
  )
  return sizes.reduce((sum, size) => sum + size, 0)
}

/**
 * Everything that lives directly in the data root but is not one of the category
 * folders already counted (config.json, ui-state.json, sync-state.json, stray
 * files). Category dirs may be overridden to sit outside the data root — those are
 * matched by absolute path and skipped, so nothing is counted twice.
 */
async function otherDataRootSize(dataRoot: string, exclude: string[]): Promise<number> {
  const excluded = new Set(exclude.map((path) => resolve(path)))
  const entries = await readdir(dataRoot, { withFileTypes: true }).catch((): Dirent[] => [])
  const sizes = await Promise.all(
    entries.map(async (entry) => {
      const full = join(dataRoot, entry.name)
      if (excluded.has(resolve(full)) || entry.isSymbolicLink()) return 0
      if (entry.isDirectory()) return dirSize(full)
      if (entry.isFile()) {
        try {
          return (await stat(full)).size
        } catch {
          return 0
        }
      }
      return 0
    })
  )
  return sizes.reduce((sum, size) => sum + size, 0)
}

export async function computeStorageUsage(): Promise<StorageUsage> {
  const dataRoot = getDataRoot()
  const [installsDir, downloadsDir, libraryDir, installed] = await Promise.all([
    getInstallsDir(),
    getDownloadsDir(),
    getLibraryDir(),
    listInstalled()
  ])
  const backupsDir = join(dataRoot, BACKUPS_DIR_NAME)

  // Per-build sizes drive the installs total, so the category figure and the
  // detail list always agree. Only launcher-managed builds live under installsDir;
  // located installs sit wherever the user keeps them and are not our storage.
  const managed = installed.filter((build) => build.managed)
  const installs: StorageInstallUsage[] = await Promise.all(
    managed.map(async (build) => ({
      id: build.id,
      version: build.version,
      releaseCycle: build.releaseCycle,
      bytes: await dirSize(build.path)
    }))
  )
  installs.sort((a, b) => b.bytes - a.bytes)
  const installsBytes = installs.reduce((sum, entry) => sum + entry.bytes, 0)

  const assetsDir = getAssetsDir()
  const [downloadsBytes, libraryBytes, assetsBytes, backupsBytes, otherBytes] = await Promise.all([
    dirSize(downloadsDir),
    dirSize(libraryDir),
    dirSize(assetsDir),
    dirSize(backupsDir),
    otherDataRootSize(dataRoot, [installsDir, downloadsDir, libraryDir, assetsDir, backupsDir])
  ])

  const categories: StorageCategoryUsage[] = [
    { category: 'installs', path: installsDir, bytes: installsBytes, missing: !existsSync(installsDir) },
    { category: 'downloads', path: downloadsDir, bytes: downloadsBytes, missing: !existsSync(downloadsDir) },
    { category: 'library', path: libraryDir, bytes: libraryBytes, missing: !existsSync(libraryDir) },
    { category: 'assets', path: assetsDir, bytes: assetsBytes, missing: !existsSync(assetsDir) },
    { category: 'backups', path: backupsDir, bytes: backupsBytes, missing: !existsSync(backupsDir) },
    { category: 'other', path: dataRoot, bytes: otherBytes, missing: false }
  ]
  const totalBytes = categories.reduce((sum, category) => sum + category.bytes, 0)

  return { dataRoot, totalBytes, categories, installs }
}
