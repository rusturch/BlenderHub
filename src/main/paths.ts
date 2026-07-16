import { app } from 'electron'
import { homedir, tmpdir } from 'os'
import { dirname, join } from 'path'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmdirSync,
  rmSync,
  unlinkSync,
  writeFileSync
} from 'fs'

// Blender Hub is portable: everything it persists (config.json, ui-state.json,
// installed Blender builds, the add-on library, settings backups) lives in a
// `data/` folder next to the app, so moving that folder to another machine or
// into a cloud-synced directory carries the whole state.

const DATA_DIR_NAME = 'data'
const FALLBACK_DIR_NAME = 'BlenderHub'
// pre-portable versions kept data in a per-user OS directory; old app name last
const LEGACY_DIR_NAMES = ['BlenderHub', 'BlenderLauncher']

function appRootDir(): string {
  // electron-builder's portable target runs the exe from a temp unpack dir;
  // this env var points at the folder the user actually launched from
  const portableDir = process.env['PORTABLE_EXECUTABLE_DIR']
  if (portableDir) return portableDir
  if (app.isPackaged) return dirname(app.getPath('exe'))
  return app.getAppPath() // dev: the project root
}

function standardDataRoot(name: string): string {
  if (process.platform === 'win32') {
    return join(process.env['LOCALAPPDATA'] ?? join(homedir(), 'AppData', 'Local'), name)
  }
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', name)
  }
  return join(process.env['XDG_DATA_HOME'] ?? join(homedir(), '.local', 'share'), name)
}

function isWritableDir(dir: string): boolean {
  // fs.access() is unreliable for directories on Windows — probe with a real write
  const probe = join(dir, `.write-probe-${process.pid}`)
  try {
    mkdirSync(dir, { recursive: true })
    writeFileSync(probe, '')
    unlinkSync(probe)
    return true
  } catch {
    return false
  }
}

let cachedDataRoot: string | null = null

export function getDataRoot(): string {
  if (!cachedDataRoot) {
    const portable = join(appRootDir(), DATA_DIR_NAME)
    if (isWritableDir(portable)) {
      cachedDataRoot = portable
    } else {
      // read-only app location (mounted .dmg, Program Files) — the app still
      // works from the per-user directory, it just is not portable there
      cachedDataRoot = standardDataRoot(FALLBACK_DIR_NAME)
      console.warn(`[data] app folder is not writable, using ${cachedDataRoot}`)
    }
  }
  return cachedDataRoot
}

/**
 * Per-machine scratch dir for transient helper files (headless python scripts,
 * batch/fixup payloads). Deliberately OUTSIDE the portable data folder: these
 * regenerate in milliseconds, and in a cloud-synced data/ they would only cause
 * upload churn and same-name conflicts between machines.
 */
export function getRuntimeRoot(): string {
  return join(tmpdir(), 'BlenderHub')
}

/**
 * One-time move of a pre-portable data dir (%LOCALAPPDATA%/BlenderLauncher and
 * friends) into the current data root. Must run before anything reads the config.
 * An already-populated data root always wins — nothing is merged or overwritten,
 * so a folder carried over from another machine is never clobbered by local leftovers.
 */
export function migrateLegacyDataDir(): void {
  const target = getDataRoot()
  if (existsSync(target) && readdirSync(target).length > 0) return
  const legacy = LEGACY_DIR_NAMES.map(standardDataRoot).find(
    (dir) => dir !== target && existsSync(dir) && readdirSync(dir).length > 0
  )
  if (!legacy) return
  console.log(`[data] migrating ${legacy} -> ${target}`)
  try {
    if (existsSync(target)) rmdirSync(target) // rename wants the destination gone
    try {
      renameSync(legacy, target) // same volume: instant
    } catch {
      // cross volume: copy into a staging dir first so an interrupted copy never
      // looks like a complete data root on the next start
      const staging = `${target}.migrating`
      rmSync(staging, { recursive: true, force: true })
      cpSync(legacy, staging, { recursive: true })
      renameSync(staging, target)
      rmSync(legacy, { recursive: true, force: true })
    }
    console.log('[data] migration done')
  } catch (error) {
    console.error('[data] migration failed, keeping the old location intact', error)
  }
}
