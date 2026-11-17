import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { mkdir } from 'fs/promises'
import { findCachedRemoteBuild, getRemoteBuilds, refreshRemoteBuilds } from './remote-cache'
import {
  findInstalled,
  getDownloadsDir,
  getInstallsDir,
  installBuild,
  launchInstalled,
  listInstalled,
  resetDownloadsDir,
  resetInstallsDir,
  setDownloadsDir,
  setInstallsDir,
  uninstallBuild
} from './installs'
import { locateInstalls } from './locate'
import { listRunningBlenders, requestCloseBlenders } from './running'
import { scheduleAssetLibraryReconcile } from '../asset-library/service'
import { notifyBuildInstallResult } from '../notifications/service'
import { requireString } from '../ipc-util'
import type { InstallProgress } from '../../shared/types'

// Application Security Requirement: the renderer only passes opaque ids over IPC;
// download URLs and filesystem paths are resolved in the main process against state
// it fetched itself, so a compromised page cannot target arbitrary URLs or paths.

// one controller per install in flight — doubles as the "already running" guard
// and as the handle builds:cancel-install aborts
const installsInFlight = new Map<string, AbortController>()

const MINOR_RE = /^\d+\.\d+$/
function requireMinors(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length > 64) throw new Error('Invalid blender versions')
  return raw.map((item) => {
    const minor = requireString(item, 'blender version')
    if (!MINOR_RE.test(minor)) throw new Error('Invalid blender version')
    return minor
  })
}

function broadcast(channel: string, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send(channel, payload)
  }
}

export function registerBlenderIpc(): void {
  // warm the cache so the Installs page opens instantly
  void refreshRemoteBuilds().catch((error) => console.warn('[builds] prefetch failed:', error))

  ipcMain.handle('builds:list-remote', (_event, refresh: unknown) => {
    console.log('[ipc] builds:list-remote requested by renderer')
    return getRemoteBuilds(refresh === true)
  })

  ipcMain.handle('builds:list-installed', () => listInstalled())

  ipcMain.handle('builds:install', async (_event, rawId: unknown, rawKeepExisting: unknown) => {
    const buildId = requireString(rawId, 'build id')
    if (rawKeepExisting !== undefined && typeof rawKeepExisting !== 'boolean') {
      throw new Error('keepExisting must be a boolean')
    }
    const build = findCachedRemoteBuild(buildId)
    if (!build) throw new Error('Unknown build — refresh the list and try again')
    if (installsInFlight.has(buildId)) throw new Error('This build is already being installed')
    const controller = new AbortController()
    installsInFlight.set(buildId, controller)
    try {
      const installed = await installBuild(
        build,
        (progress) => broadcast('builds:install-progress', progress),
        rawKeepExisting === true,
        controller.signal
      )
      // a new version may need the launcher asset library registered (deferred
      // anyway until the version has run once and owns a userpref.blend)
      scheduleAssetLibraryReconcile()
      notifyBuildInstallResult(build)
      return installed
    } catch (error) {
      // a cancel is the user's own doing, not a failure to report as one
      const phase = controller.signal.aborted ? 'cancelled' : 'error'
      const message = error instanceof Error ? error.message : String(error)
      broadcast('builds:install-progress', {
        buildId,
        phase,
        ...(phase === 'error' ? { error: message } : {})
      } satisfies InstallProgress)
      if (phase === 'error') notifyBuildInstallResult(build, message)
      throw error
    } finally {
      installsInFlight.delete(buildId)
    }
  })

  ipcMain.handle('builds:cancel-install', (_event, rawId: unknown) => {
    const buildId = requireString(rawId, 'build id')
    // unknown or already-finished id: nothing to abort, and nothing to report
    installsInFlight.get(buildId)?.abort()
  })

  ipcMain.handle('builds:locate', async () => {
    const picked = await dialog.showOpenDialog({
      title: 'Locate existing Blender installations',
      message: 'Pick a folder — every Blender build inside will be added',
      properties: ['openDirectory']
    })
    if (picked.canceled || !picked.filePaths[0]) return null
    const located = await locateInstalls(picked.filePaths[0], await getInstallsDir())
    if (located.length > 0) scheduleAssetLibraryReconcile()
    return located
  })

  ipcMain.handle('builds:launch', (_event, rawId: unknown) => launchInstalled(requireString(rawId, 'install id')))

  // pids never cross IPC: the renderer names minors, main enumerates processes itself
  ipcMain.handle('builds:list-running', (_event, rawMinors: unknown) =>
    listRunningBlenders(requireMinors(rawMinors))
  )

  ipcMain.handle('builds:request-close', (_event, rawMinors: unknown) =>
    requestCloseBlenders(requireMinors(rawMinors))
  )

  ipcMain.handle('builds:uninstall', (_event, rawId: unknown) => uninstallBuild(requireString(rawId, 'install id')))

  ipcMain.handle('builds:open-folder', async (_event, rawId: unknown) => {
    const build = await findInstalled(requireString(rawId, 'install id'))
    shell.showItemInFolder(build.executable)
  })

  ipcMain.handle('builds:get-installs-dir', () => getInstallsDir())
  ipcMain.handle('builds:get-downloads-dir', () => getDownloadsDir())

  ipcMain.handle('builds:open-installs-dir', async () => {
    const dir = await getInstallsDir()
    await mkdir(dir, { recursive: true })
    await shell.openPath(dir)
  })
  ipcMain.handle('builds:open-downloads-dir', async () => {
    const dir = await getDownloadsDir()
    await mkdir(dir, { recursive: true })
    await shell.openPath(dir)
  })

  ipcMain.handle('builds:pick-installs-dir', async () => {
    const picked = await dialog.showOpenDialog({
      title: 'Choose a folder for installed Blender versions',
      properties: ['openDirectory', 'createDirectory']
    })
    if (picked.canceled || !picked.filePaths[0]) return null
    return setInstallsDir(picked.filePaths[0])
  })

  ipcMain.handle('builds:pick-downloads-dir', async () => {
    const picked = await dialog.showOpenDialog({
      title: 'Choose a folder for downloaded build archives',
      properties: ['openDirectory', 'createDirectory']
    })
    if (picked.canceled || !picked.filePaths[0]) return null
    return setDownloadsDir(picked.filePaths[0])
  })

  ipcMain.handle('builds:reset-installs-dir', () => resetInstallsDir())
  ipcMain.handle('builds:reset-downloads-dir', () => resetDownloadsDir())
}
