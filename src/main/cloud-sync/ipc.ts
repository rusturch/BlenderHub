import { ipcMain } from 'electron'
import { onUiStateSet, readUiState } from '../ui-state'
import { clearCloudToken, getCloudToken } from './token'
import { CLOUD_ENABLED_UI_KEY, isSharedUiKey } from '../../shared/cloud-sync'
import {
  connectCancel,
  connectStart,
  currentStatus,
  deleteCloud,
  disconnect,
  onSharedKeyChanged,
  openVerification,
  refreshAccount,
  resolveFirstLink,
  setEnabled,
  startEngine,
  syncNow
} from './engine'

// Cloud Sync IPC. The renderer sends only primitives; the Google tokens, API
// hosts and machine paths never cross this boundary — only a CloudSyncStatus
// does.

function cloudEnabledValue(raw: string | null | undefined): boolean {
  return raw === 'on' // default OFF
}

export function registerCloudSyncIpc(): void {
  ipcMain.handle('cloud-sync:status', () => currentStatus())
  ipcMain.handle('cloud-sync:connect-start', () => connectStart())
  ipcMain.handle('cloud-sync:connect-cancel', () => {
    connectCancel()
  })
  ipcMain.handle('cloud-sync:open-verification', () => {
    openVerification()
  })
  ipcMain.handle('cloud-sync:resolve-first-link', (_event, rawChoice: unknown) => {
    if (rawChoice !== 'cloud' && rawChoice !== 'local') throw new Error('Invalid choice')
    return resolveFirstLink(rawChoice)
  })
  ipcMain.handle('cloud-sync:disconnect', (_event, rawDelete: unknown) => disconnect(rawDelete === true))
  ipcMain.handle('cloud-sync:sync-now', () => syncNow())
  ipcMain.handle('cloud-sync:refresh-account', () => refreshAccount())
  ipcMain.handle('cloud-sync:delete-cloud-data', () => deleteCloud())
}

/** wired from index.ts after IPC registration; reads the toggle and subscribes. */
export async function setupCloudSync(): Promise<void> {
  // one-time migration: a token from the retired subscription backend ("bh_…")
  // cannot work against Google — drop it so the card honestly shows "not connected"
  const stale = await getCloudToken()
  if (stale?.startsWith('bh_')) await clearCloudToken()

  const ui = await readUiState()
  const enabled = cloudEnabledValue(ui[CLOUD_ENABLED_UI_KEY])
  startEngine(enabled)

  onUiStateSet((key, value) => {
    if (key === CLOUD_ENABLED_UI_KEY) {
      setEnabled(cloudEnabledValue(value))
    } else if (isSharedUiKey(key)) {
      onSharedKeyChanged()
    }
  })
}
