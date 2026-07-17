import { app, shell, BrowserWindow } from 'electron'
import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import icon from '../../resources/icon.png?asset'
import { registerBlenderIpc } from './blender/ipc'
import { registerProjectsIpc } from './projects/ipc'
import { registerAddonsIpc } from './addons/ipc'
import { registerSettingsSyncIpc } from './sync/ipc'
import { registerStorageIpc } from './storage/ipc'
import { registerUpdatesIpc } from './updates/ipc'
import { registerUiStateIpc } from './ui-state'
import { attachTrayWindowBehavior, revealMainWindow, setupTray } from './tray'
import { migrateLegacyDataDir } from './paths'

function createWindow(): void {
  // Application Security Requirement: renderer is isolated (contextIsolation + OS sandbox,
  // no Node integration) and window.open targets are denied — external https links are
  // handed to the system browser instead of opening privileged windows.
  const mainWindow = new BrowserWindow({
    width: 1160,
    height: 740,
    minWidth: 920,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#0d0d0d',
    icon,
    title: 'Blender Hub', // used for the taskbar/Alt-Tab only — no caption text is drawn (see titleBarStyle below)
    // hides the native OS caption (title text) while keeping real, OS-drawn
    // minimize/maximize/close buttons as an overlay; renderer draws its own
    // wide top bar underneath/around them (App.tsx: TitleBar component) and
    // must leave the top-right corner clear — height here must match its CSS height
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#181818',
      symbolColor: '#e5e7eb',
      height: 40
    },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  attachTrayWindowBehavior(mainWindow)

  mainWindow.webContents.setWindowOpenHandler((details) => {
    if (details.url.startsWith('https://')) {
      shell.openExternal(details.url)
    }
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

// a portable exe is double-launched easily (no pinned shortcut), and two processes
// would interleave read-modify-write on the same config.json — the write queue only
// serializes within one process. Hand a second launch over to the running instance.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    // also un-hides a window parked in the tray
    revealMainWindow()
  })

  app.whenReady().then(() => {
    electronApp.setAppUserModelId('com.rusturch.blender-hub')

    // must happen before any IPC handler reads config.json from the data root
    migrateLegacyDataDir()

    registerUiStateIpc()
    registerBlenderIpc()
    registerProjectsIpc()
    registerAddonsIpc()
    registerSettingsSyncIpc()
    registerStorageIpc()
    registerUpdatesIpc()
    setupTray()

    app.on('browser-window-created', (_, window) => {
      optimizer.watchWindowShortcuts(window)
    })

    createWindow()

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
      else revealMainWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit()
    }
  })
}
