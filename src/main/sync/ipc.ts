import { BrowserWindow, ipcMain } from 'electron'
import { requireString } from '../ipc-util'
import { withExclusiveOp } from '../op-lock'
import { invalidateAddonsCache } from '../addons/ipc'
import { scheduleAssetLibraryReconcile } from '../asset-library/service'
import { HIDDEN_SYNC_COMPONENT_IDS, SYNC_COMPONENT_IDS } from '../../shared/types'
import type { SettingsSyncRequest, SyncComponentId, SyncLinks, SyncScanResult } from '../../shared/types'
import { scanSettings } from './scan'
import { applySettingsSync, inheritBaselines, recordSyncPoint, restoreSettingsBackup } from './apply'
import { deleteBackup, listBackups, revealBackup } from './backups'
import { deleteSettingsFolder } from './config-dir'
import { updateSyncState } from './state'

// Application Security Requirement: the renderer sends only minors, component ids and
// backup ids — never a path. Bases are resolved in main from installed builds and the
// OS config root; a backup id resolves strictly through our own meta.json listing.

let cache: SyncScanResult | null = null

const MINOR_RE = /^\d+\.\d+$/
const BACKUP_ID_RE = /^[A-Za-z0-9-]{1,80}$/

function broadcast(channel: string, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send(channel, payload)
  }
}

function requireMinor(value: unknown): string {
  const minor = requireString(value, 'blender version')
  if (!MINOR_RE.test(minor)) throw new Error('Invalid blender version')
  return minor
}

function requireComponent(value: unknown): SyncComponentId {
  const id = requireString(value, 'component id')
  if (!(SYNC_COMPONENT_IDS as readonly string[]).includes(id)) throw new Error('Invalid component id')
  return id as SyncComponentId
}

function parseLinks(raw: unknown): SyncLinks {
  const { sourceMinor, cells } = (raw ?? {}) as Record<string, unknown>
  const source = sourceMinor === null || sourceMinor === undefined ? null : requireMinor(sourceMinor)
  if (cells === undefined || cells === null || typeof cells !== 'object' || Array.isArray(cells)) {
    throw new Error('Invalid links payload')
  }
  const entries = Object.entries(cells as Record<string, unknown>)
  if (entries.length > 64) throw new Error('Invalid links payload')
  const parsed: Record<string, SyncComponentId[]> = {}
  for (const [minor, value] of entries) {
    if (!MINOR_RE.test(minor)) throw new Error('Invalid blender version')
    if (!Array.isArray(value) || value.length > SYNC_COMPONENT_IDS.length) throw new Error('Invalid links payload')
    const components = [...new Set(value.map(requireComponent))]
    if (components.length > 0) parsed[minor] = components
  }
  return { sourceMinor: source, cells: parsed }
}

function requireBackupId(value: unknown): string {
  const id = requireString(value, 'backup id')
  if (!BACKUP_ID_RE.test(id)) throw new Error('Invalid backup id')
  return id
}

function parseSyncRequest(raw: unknown): SettingsSyncRequest {
  const { sourceMinor, targets } = (raw ?? {}) as Record<string, unknown>
  const source = requireMinor(sourceMinor)
  if (!Array.isArray(targets) || targets.length === 0 || targets.length > 32) {
    throw new Error('Invalid sync payload')
  }
  const seen = new Set<string>()
  const parsedTargets = targets.map((item) => {
    const { minor, components } = (item ?? {}) as Record<string, unknown>
    const minorStr = requireMinor(minor)
    if (minorStr === source) throw new Error('A version cannot sync onto itself')
    if (seen.has(minorStr)) throw new Error('Invalid sync payload')
    seen.add(minorStr)
    if (!Array.isArray(components) || components.length === 0 || components.length > SYNC_COMPONENT_IDS.length) {
      throw new Error('Invalid sync payload')
    }
    const parsed = [
      ...new Set(
        components.map((value) => {
          const id = requireString(value, 'component id')
          if (!(SYNC_COMPONENT_IDS as readonly string[]).includes(id)) throw new Error('Invalid component id')
          return id as SyncComponentId
        })
      )
      // parked components are dropped silently — stale persisted links must not act
    ].filter((id) => !HIDDEN_SYNC_COMPONENT_IDS.includes(id))
    return { minor: minorStr, components: parsed }
  })
  // a target left with nothing to copy (only parked components) is dropped too
  const withWork = parsedTargets.filter((target) => target.components.length > 0)
  if (withWork.length === 0) throw new Error('Invalid sync payload')
  return { sourceMinor: source, targets: withWork }
}

export function registerSettingsSyncIpc(): void {
  ipcMain.handle('sync:get-cached', () => cache)

  ipcMain.handle('sync:scan', () =>
    withExclusiveOp('settings sync', async () => {
      cache = await scanSettings()
      return cache
    })
  )

  ipcMain.handle('sync:apply', (_event, raw: unknown) =>
    withExclusiveOp('settings sync', async () => {
      const request = parseSyncRequest(raw)
      const outcome = await applySettingsSync(request, (progress) => broadcast('sync:apply-progress', progress))
      cache = outcome.data
      // copied preferences rewrote enabled-add-on flags the Add-ons matrix may have cached
      if (request.targets.some((target) => target.components.includes('preferences'))) invalidateAddonsCache()
      return outcome
    })
  )

  ipcMain.handle('sync:set-links', async (_event, raw: unknown) => {
    const links = parseLinks(raw)
    // Baselines are kept per source and unlinking never deletes them — so switching
    // the source (or a stray unlink+relink) loses nothing; switching back restores
    // that source's in-sync states as they were.
    await updateSyncState((state) => ({ ...state, links }))
  })

  ipcMain.handle('sync:record-sync-point', (_event, rawMinor: unknown, rawComponent: unknown) =>
    withExclusiveOp('settings sync', async () => {
      const fresh = await recordSyncPoint(requireMinor(rawMinor), requireComponent(rawComponent))
      cache = fresh
      return fresh
    })
  )

  // bookkeeping only — carries provably-valid sync points to a newly picked source
  ipcMain.handle('sync:inherit-baselines', (_event, rawFrom: unknown, rawTo: unknown) =>
    withExclusiveOp('settings sync', () => inheritBaselines(requireMinor(rawFrom), requireMinor(rawTo)))
  )

  // leftover settings of an uninstalled version — main resolves the path itself and
  // refuses anything that still has a build (see deleteSettingsFolder)
  ipcMain.handle('sync:delete-settings-folder', (_event, rawMinor: unknown) =>
    withExclusiveOp('settings sync', async () => {
      cache = await deleteSettingsFolder(requireMinor(rawMinor))
      return cache
    })
  )

  ipcMain.handle('sync:list-backups', () => listBackups())

  ipcMain.handle('sync:restore-backup', (_event, rawId: unknown) =>
    withExclusiveOp('settings sync', async () => {
      const outcome = await restoreSettingsBackup(requireBackupId(rawId), (progress) =>
        broadcast('sync:apply-progress', progress)
      )
      cache = outcome.data
      invalidateAddonsCache()
      // restore puts exact old bytes back — a pre-registration userpref.blend loses
      // the launcher asset library entry until the deferred reconcile re-adds it
      scheduleAssetLibraryReconcile()
      return outcome
    })
  )

  ipcMain.handle('sync:delete-backup', (_event, rawId: unknown) =>
    withExclusiveOp('settings sync', () => deleteBackup(requireBackupId(rawId)))
  )

  ipcMain.handle('sync:reveal-backup', (_event, rawId: unknown) => revealBackup(requireBackupId(rawId)))
}
