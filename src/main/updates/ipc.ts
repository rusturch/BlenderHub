import { app, BrowserWindow, ipcMain, shell } from 'electron'
import {
  checkForUpdate,
  cleanupAfterUpdate,
  downloadUpdate,
  getReleasePageUrl,
  installUpdateAndRestart
} from './updates'
import { applyLauncherUpdateState } from '../notifications/service'
import type { UpdateCheckResult, UpdateDownloadProgress } from '../../shared/types'

// Application Security Requirement: the renderer never passes URLs or paths —
// the release location is a compile-time constant and every path derives from
// the app's own install folder, both resolved in the main process.

function broadcast(channel: string, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send(channel, payload)
  }
}

export function registerUpdatesIpc(): void {
  cleanupAfterUpdate()
  // every completed check/download pushes the fresh state to all windows, so the
  // sidebar badge tracks results no matter which page triggered them — and the
  // notification bell mirrors the same state
  const emitState = (state: UpdateCheckResult): void => {
    broadcast('updates:state', state)
    applyLauncherUpdateState(state)
  }
  // warm the check so the sidebar badge shows up shortly after launch
  void checkForUpdate(false).then(emitState)

  ipcMain.handle('updates:get-version', () => app.getVersion())

  ipcMain.handle('updates:check', async (_event, refresh: unknown) => {
    const result = await checkForUpdate(refresh === true)
    emitState(result)
    return result
  })

  ipcMain.handle('updates:download', async () => {
    try {
      const result = await downloadUpdate((progress) => broadcast('updates:download-progress', progress))
      emitState(result)
      return result
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      broadcast('updates:download-progress', { phase: 'error', error: message } satisfies UpdateDownloadProgress)
      throw error
    }
  })

  ipcMain.handle('updates:install-restart', () => installUpdateAndRestart())

  ipcMain.handle('updates:open-release-page', async () => {
    await shell.openExternal(getReleasePageUrl())
  })
}
