import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { mkdir } from 'fs/promises'
import { fetchAllBuilds } from './builds-api'
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
import { requireString } from '../ipc-util'
import type { InstallProgress, RemoteBuild } from '../../shared/types'

// Application Security Requirement: the renderer only passes opaque ids over IPC;
// download URLs and filesystem paths are resolved in the main process against state
// it fetched itself, so a compromised page cannot target arbitrary URLs or paths.

let remoteCache: { fetchedAt: number; builds: RemoteBuild[] } | null = null
const REMOTE_CACHE_TTL_MS = 10 * 60 * 1000
const installsInFlight = new Set<string>()

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

async function refreshRemoteCache(): Promise<RemoteBuild[]> {
  const builds = await fetchAllBuilds()
  remoteCache = { fetchedAt: Date.now(), builds }
  return builds
}

export function registerBlenderIpc(): void {
  // warm the cache so the Installs page opens instantly
  void refreshRemoteCache().catch((error) => console.warn('[builds] prefetch failed:', error))

  ipcMain.handle('builds:list-remote', async (_event, refresh: unknown) => {
    console.log('[ipc] builds:list-remote requested by renderer')
    const cached = remoteCache
    if (!cached || refresh === true || Date.now() - cached.fetchedAt > REMOTE_CACHE_TTL_MS) {
      return refreshRemoteCache()
    }
    return cached.builds
  })

  ipcMain.handle('builds:list-installed', () => listInstalled())

  ipcMain.handle('builds:install', async (_event, rawId: unknown) => {
    const buildId = requireString(rawId, 'build id')
    const build = remoteCache?.builds.find((candidate) => candidate.id === buildId)
    if (!build) throw new Error('Unknown build — refresh the list and try again')
    if (installsInFlight.has(buildId)) throw new Error('This build is already being installed')
    installsInFlight.add(buildId)
    try {
      return await installBuild(build, (progress) => broadcast('builds:install-progress', progress))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      broadcast('builds:install-progress', { buildId, phase: 'error', error: message } satisfies InstallProgress)
      throw error
    } finally {
      installsInFlight.delete(buildId)
    }
  })

  ipcMain.handle('builds:locate', async () => {
    const picked = await dialog.showOpenDialog({
      title: 'Locate existing Blender installations',
      message: 'Pick a folder — every Blender build inside will be added',
      properties: ['openDirectory']
    })
    if (picked.canceled || !picked.filePaths[0]) return null
    return locateInstalls(picked.filePaths[0], await getInstallsDir())
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
