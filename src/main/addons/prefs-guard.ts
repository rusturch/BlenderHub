import { copyFile, rm, stat } from 'fs/promises'
import { resolveUserDirs } from './blender-paths'
import { parseUserpref } from './userpref-parser'

// Headless Blender can die mid-run: an add-on with native wheels built for another Python
// crashes the interpreter, and a crash landing inside wm.save_userpref() would leave the
// version's preferences truncated — every enabled add-on, theme and keymap gone, with no undo.
// So each batch run brackets itself: copy userpref.blend aside first, and if the file no longer
// parses afterwards, put the copy back. The check is the same DNA parser the direct scan uses,
// so "still valid" means genuinely readable, not merely non-empty.

/** temp copy next to the original — same volume, so the restore is an atomic-ish local copy */
const backupPathFor = (userprefPath: string): string => `${userprefPath}.blh-guard`

async function isReadable(path: string): Promise<boolean> {
  try {
    const info = await stat(path)
    if (info.size === 0) return false
    await parseUserpref(path)
    return true
  } catch {
    return false
  }
}

export interface PrefsGuard {
  /** call once the run is over — restores the copy if the live file went bad, then cleans up */
  finish: () => Promise<'intact' | 'restored' | 'unprotected'>
}

/**
 * Take a restore point for one Blender version's preferences. Never throws: a version that has
 * never been launched has no userpref.blend at all, and failing to guard must not fail the apply.
 */
export async function guardPrefs(executable: string, minor: string): Promise<PrefsGuard> {
  let userprefPath: string
  try {
    userprefPath = resolveUserDirs(executable, minor).userprefPath
  } catch {
    return { finish: async () => 'unprotected' }
  }
  const backupPath = backupPathFor(userprefPath)
  let guarded = false
  try {
    // only guard what already parses — copying an unreadable file forward would be pointless,
    // and a missing one means Blender is about to write its first prefs (nothing to lose yet)
    if (await isReadable(userprefPath)) {
      await copyFile(userprefPath, backupPath)
      guarded = true
    }
  } catch {
    guarded = false
  }

  return {
    finish: async () => {
      if (!guarded) return 'unprotected'
      try {
        if (await isReadable(userprefPath)) {
          await rm(backupPath, { force: true }).catch(() => {})
          return 'intact'
        }
        await copyFile(backupPath, userprefPath)
        await rm(backupPath, { force: true }).catch(() => {})
        return 'restored'
      } catch {
        // leave the copy on disk: it is the only surviving good version of the file
        return 'unprotected'
      }
    }
  }
}
