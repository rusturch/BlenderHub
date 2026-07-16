import { existsSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'
import { compareVersionsDesc } from '../../shared/blender-builds'

// Where a given Blender version keeps its user files, mirroring appdir.cc:
// one base dir per OS+version with config/scripts/extensions as siblings.
// Portable installs replace the whole base: 4.2+ uses ./portable next to the
// executable (no version subdir); ≤4.1 used <install>/<M.m>/config existing.
// Env overrides (BLENDER_USER_*) are NOT honored here — if the user relies on
// them, the direct scan may diverge and the deep (headless) scan is the truth.

export interface BlenderUserDirs {
  /** user base: config/, scripts/, extensions/ live under it */
  base: string
  userprefPath: string
  scriptsDir: string
  extensionsDir: string
  portable: boolean
}

const atLeast = (version: string, base: string): boolean => compareVersionsDesc(version, base) <= 0

/** the directory that contains the <M.m> versioned folder of an install */
export function resourcesDir(executable: string): string {
  if (process.platform === 'darwin') return join(dirname(executable), '..', 'Resources')
  return dirname(executable)
}

/** <install>/<M.m> — bundled scripts and system extensions live inside */
export const versionDir = (executable: string, minor: string): string =>
  join(resourcesDir(executable), minor)

/** OS root that holds every per-version standard user base (…/Blender Foundation/Blender) */
export function userBaseRoot(): string {
  if (process.platform === 'win32') {
    const appData = process.env['APPDATA'] ?? join(homedir(), 'AppData', 'Roaming')
    return join(appData, 'Blender Foundation', 'Blender')
  }
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'Blender')
  }
  return join(process.env['XDG_CONFIG_HOME'] ?? join(homedir(), '.config'), 'blender')
}

export function standardUserBase(minor: string): string {
  return join(userBaseRoot(), minor)
}

export function resolveUserDirs(executable: string, minor: string): BlenderUserDirs {
  let base: string | null = null
  let portable = false
  if (atLeast(minor, '4.2')) {
    const portableDir = join(resourcesDir(executable), 'portable')
    if (existsSync(portableDir)) {
      base = portableDir
      portable = true
    }
  } else {
    const localVersionDir = versionDir(executable, minor)
    if (existsSync(join(localVersionDir, 'config'))) {
      base = localVersionDir
      portable = true
    }
  }
  base ??= standardUserBase(minor)
  return {
    base,
    userprefPath: join(base, 'config', 'userpref.blend'),
    scriptsDir: join(base, 'scripts'),
    extensionsDir: join(base, 'extensions'),
    portable
  }
}
