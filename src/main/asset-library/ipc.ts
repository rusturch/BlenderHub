import { BrowserWindow, ipcMain, shell } from 'electron'
import { withExclusiveOp } from '../op-lock'
import type { AssetLibraryProgress } from '../../shared/types'
import {
  ensureAssetsDirBootstrap,
  getAssetsDir,
  readAssetLibraryStatus,
  reconcileAssetLibraries,
  unregisterAssetLibraries,
  yieldBackgroundReconcile
} from './service'

function broadcast(progress: AssetLibraryProgress): void {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send('assetlib:progress', progress)
  }
}

export function registerAssetLibraryIpc(): void {
  ipcMain.handle('assetlib:status', () => readAssetLibraryStatus())

  // explicit user actions (enable toggle, Fix button): force re-adds entries the
  // user deleted inside Blender — the click IS the consent; a busy op-lock error
  // surfaces honestly here, same as the add-ons Apply. The silent safety-net run
  // is absorbed first so it cannot be the thing holding the lock.
  ipcMain.handle('assetlib:reconcile', async () => {
    await yieldBackgroundReconcile()
    return withExclusiveOp('asset library', () =>
      reconcileAssetLibraries({ force: true, onProgress: broadcast })
    )
  })

  ipcMain.handle('assetlib:unregister', async () => {
    await yieldBackgroundReconcile()
    return withExclusiveOp('asset library', () => unregisterAssetLibraries(broadcast))
  })

  ipcMain.handle('assetlib:open-dir', async () => {
    await ensureAssetsDirBootstrap()
    await shell.openPath(getAssetsDir())
  })
}
