import { BrowserWindow, shell } from 'electron'
import { join } from 'path'
import { is } from '@electron-toolkit/utils'
import icon from '../../../resources/icon.png?asset'
import { currentWindowChrome } from './window-chrome'

// A small companion window carrying just the theme editor (#theme-editor route),
// so colors can be tweaked live while flipping through the main window's tabs.
// Single instance: reopening focuses the existing window.

let editorWindow: BrowserWindow | null = null

/** the editor must not outlive the main window — an orphan would block window-all-closed */
export function closeThemeEditorWindow(): void {
  if (editorWindow && !editorWindow.isDestroyed()) editorWindow.close()
}

export function openThemeEditorWindow(): void {
  if (editorWindow && !editorWindow.isDestroyed()) {
    if (editorWindow.isMinimized()) editorWindow.restore()
    editorWindow.focus()
    return
  }
  const window = new BrowserWindow({
    width: 480,
    height: 760,
    minWidth: 420,
    minHeight: 480,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: currentWindowChrome().background,
    icon,
    title: 'Blender Hub',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  })
  editorWindow = window

  window.on('ready-to-show', () => {
    window.show()
  })
  window.on('closed', () => {
    if (editorWindow === window) editorWindow = null
  })

  // same policy as the main window: external https to the browser, no child windows
  window.webContents.setWindowOpenHandler((details) => {
    if (details.url.startsWith('https://')) {
      shell.openExternal(details.url)
    }
    return { action: 'deny' }
  })

  // same backstop as the main window: a file dropped on this window (which has no
  // drop UI of its own) must not navigate it to file://
  window.webContents.on('will-navigate', (event, url) => {
    if (url !== window.webContents.getURL()) event.preventDefault()
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    window.loadURL(`${process.env['ELECTRON_RENDERER_URL']}#theme-editor`)
  } else {
    window.loadFile(join(__dirname, '../renderer/index.html'), { hash: 'theme-editor' })
  }
}
