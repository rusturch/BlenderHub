import { shell } from 'electron'
import { resolve, sep } from 'path'
import { userBaseRoot } from '../addons/blender-paths'
import type { SyncScanResult } from '../../shared/types'
import { resolveColumns, scanSettings } from './scan'
import { readSyncState, updateSyncState } from './state'

// Uninstalling Blender never removes its settings — neither Blender's own uninstaller
// nor this launcher (it only trashes the build folder). The leftovers keep showing up
// as "config only" columns, so the page offers to clear them out. Deliberately limited
// to versions with NO installed build: wiping a live version's settings from a sync
// matrix would be a foot-gun, and Blender itself is the place to reset those.

export async function deleteSettingsFolder(minor: string): Promise<SyncScanResult> {
  const state = await readSyncState()
  if (state.links.sourceMinor === minor) {
    throw new Error('This version is the current sync source — pick another source first')
  }
  const entry = (await resolveColumns()).find((candidate) => candidate.column.minor === minor)
  if (!entry) throw new Error(`No settings found for Blender ${minor}`)
  if (entry.column.installed) {
    throw new Error(`Blender ${minor} is installed — only leftover settings of removed versions can be deleted`)
  }
  // defense in depth: the path is main's own (standardUserBase for non-installed
  // columns), but never delete anything outside the Blender settings root
  const target = resolve(entry.base)
  const root = resolve(userBaseRoot())
  if (!target.startsWith(root + sep)) {
    throw new Error('Refusing to delete a folder outside the Blender settings directory')
  }
  // user data goes to the OS trash — never an unrecoverable rm, unlike our own backups
  await shell.trashItem(target)

  // the version is gone from the matrix: drop its links and every sync point that
  // mentions it, both as a source of its own and as a target of other sources
  await updateSyncState((current) => {
    const cells = { ...current.links.cells }
    delete cells[minor]
    const baselines: typeof current.baselines = {}
    for (const [source, entries] of Object.entries(current.baselines)) {
      if (source === minor) continue
      const kept = Object.fromEntries(
        Object.entries(entries).filter(([key]) => !key.startsWith(`${minor}:`))
      )
      if (Object.keys(kept).length > 0) baselines[source] = kept
    }
    return { links: { ...current.links, cells }, baselines }
  })
  return scanSettings()
}
