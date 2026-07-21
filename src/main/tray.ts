import { execFile, spawn } from 'child_process'
import { existsSync } from 'fs'
import { basename } from 'path'
import { promisify } from 'util'
import { app, BrowserWindow, Menu, nativeImage, nativeTheme, Notification, screen, Tray } from 'electron'
import type { MenuItemConstructorOptions, NativeImage } from 'electron'
import { onUiStateSet, readUiState } from './ui-state'
import { readBlendInfo } from './blender/blend-parser'
import { listInstalled } from './blender/installs'
import { getHiddenFiles, getProjectFiles, getProjectFolders, recordProjectOpened } from './projects/store'
import { listRecentProjectFiles } from './projects/service'
import { TRAY_PAGES_KEY, parseTrayPages } from '../shared/tray-menu'
import { pickNativeInstall } from '../shared/blender-builds'
import trayBlack from '../../resources/tray-black.png?asset'
import trayWhite from '../../resources/tray-white.png?asset'
import type { Page } from '../shared/types'

// Optional stay-in-tray behavior: the close and minimize buttons can hide the
// window instead. Both preferences live in ui-state.json (renderer writes them
// from Settings via the existing ui:set-state channel — no extra IPC needed).

export const CLOSE_BEHAVIOR_KEY = 'window.closeBehavior' // 'tray' (default) | 'quit'
export const MINIMIZE_BEHAVIOR_KEY = 'window.minimizeBehavior' // 'taskbar' (default) | 'tray'

const execFileAsync = promisify(execFile)

// The icon is a plain silhouette, so it has to match the surface behind it or it
// disappears. On Windows that surface is the taskbar, whose light/dark setting is a
// separate registry value from the app theme nativeTheme reports — elsewhere the app
// theme is the closest thing to the panel's own.
const WINDOWS_THEME_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Themes\\Personalize'
const TRAY_ICON_BASE_SIZE = 16
// macOS measures the menu bar in points, not pixels: 18 leaves the usual margin
// inside a 24pt bar, and the @2x buffer below keeps it sharp on retina displays
const MAC_TRAY_ICON_SIZE = 18

let lightBackground = false

// the tray is native OS chrome, out of reach of the renderer's i18n context — a tiny,
// static lookup mirrors the couple of dictionaries that matter (kept in sync by hand;
// see renderer/src/locales/*.json for the source of truth on wording)
type TrayLang = 'en' | 'ru'
const TRAY_LABELS: Record<
  TrayLang,
  { openHub: string; quit: string; noRecentProjects: string; nav: Record<Page, string> }
> = {
  en: {
    openHub: 'Open Blender Hub',
    quit: 'Quit',
    noRecentProjects: 'No recent projects',
    nav: {
      projects: 'Projects',
      installs: 'Installs',
      addons: 'Add-ons',
      sync: 'Sync',
      activity: 'Activity',
      settings: 'Settings'
    }
  },
  ru: {
    openHub: 'Открыть Blender Hub',
    quit: 'Выход',
    noRecentProjects: 'Нет недавних проектов',
    nav: {
      projects: 'Проекты',
      installs: 'Установка',
      addons: 'Аддоны',
      sync: 'Синхронизация',
      activity: 'Активность',
      settings: 'Настройки'
    }
  }
}

const RECENT_PROJECTS_LIMIT = 5

let closeToTray = false
let minimizeToTray = false
let hiddenStartup = false
let tray: Tray | null = null
let quitting = false

function showWindow(): void {
  const win = BrowserWindow.getAllWindows()[0]
  if (!win) return
  win.show()
  if (win.isMinimized()) win.restore()
  win.focus()
}

/** brings the window to front and tells it which tab to land on */
function navigateTo(page: Page): void {
  showWindow()
  for (const window of BrowserWindow.getAllWindows()) window.webContents.send('tray:navigate', page)
}

function notify(body: string): void {
  if (Notification.isSupported()) new Notification({ title: 'Blender Hub', body }).show()
}

/** same "native version" match Projects.tsx uses, so a tray quick-open behaves identically */
async function resolveInstallFor(filePath: string): Promise<{ executable: string; path: string } | null> {
  const [{ version }, builds] = await Promise.all([
    readBlendInfo(filePath).catch(() => ({ versionCode: null, version: null, thumbnail: null })),
    listInstalled()
  ])
  if (builds.length === 0) return null
  return pickNativeInstall(builds, version) ?? builds[0]
}

async function openProjectFromTray(filePath: string, lang: TrayLang): Promise<void> {
  if (!existsSync(filePath)) {
    notify(`${basename(filePath)}: ${lang === 'ru' ? 'файл больше не найден' : 'file no longer found'}`)
    return
  }
  const build = await resolveInstallFor(filePath)
  if (!build) {
    notify(lang === 'ru' ? 'Нет установленной версии Blender' : 'No installed Blender version found')
    return
  }
  // windowsHide: blender.exe is a console-subsystem app; detached without it makes
  // Windows spawn a fresh (visible) console for it. CREATE_NO_WINDOW keeps it hidden.
  const child = spawn(build.executable, [filePath], {
    cwd: build.path,
    detached: true,
    stdio: 'ignore',
    windowsHide: true
  })
  child.unref()
  recordProjectOpened(filePath)
    .then(() => refreshTrayMenu())
    .catch(() => {})
}

// flat top-level items (no "Recent Projects" submenu to drill into), sourced from
// the same folders/files the Projects page scans — most recently MODIFIED on disk,
// not most recently opened through the launcher
async function recentProjectItems(lang: TrayLang): Promise<MenuItemConstructorOptions[]> {
  const [folders, individualFiles, hiddenFiles] = await Promise.all([
    getProjectFolders(),
    getProjectFiles(),
    getHiddenFiles()
  ])
  const recents = await listRecentProjectFiles(folders, individualFiles, hiddenFiles, RECENT_PROJECTS_LIMIT)
  if (recents.length === 0) {
    return [{ label: TRAY_LABELS[lang].noRecentProjects, enabled: false }]
  }
  return recents.map(({ path }) => ({
    // same as Projects.tsx cards: the filename with the .blend extension dropped
    // (a label doesn't need to repeat "it's a .blend")
    label: basename(path).replace(/\.blend$/i, ''),
    click: () => void openProjectFromTray(path, lang)
  }))
}

async function buildTrayMenu(): Promise<Menu> {
  const state = await readUiState()
  const lang: TrayLang = state['launcher.language'] === 'ru' ? 'ru' : 'en'
  const labels = TRAY_LABELS[lang]
  // which tabs to offer is a user setting (Settings → Window & tray); with none
  // enabled the whole section — its separator included — drops out
  const navPages = parseTrayPages(state[TRAY_PAGES_KEY])
  const navSection: MenuItemConstructorOptions[] =
    navPages.length === 0
      ? []
      : [
          ...navPages.map(
            (page): MenuItemConstructorOptions => ({ label: labels.nav[page], click: () => navigateTo(page) })
          ),
          { type: 'separator' }
        ]
  return Menu.buildFromTemplate([
    ...(await recentProjectItems(lang)),
    { type: 'separator' },
    ...navSection,
    { label: labels.openHub, click: showWindow },
    { label: labels.quit, click: () => app.quit() }
  ])
}

/** rebuild and reassign the tray's menu — call after anything that changes its contents
 * (a project opened, the display language changed) so the next open shows it fresh */
export function refreshTrayMenu(): void {
  if (!tray) return
  void buildTrayMenu().then((menu) => tray?.setContextMenu(menu))
}

async function readLightBackground(): Promise<boolean> {
  if (process.platform !== 'win32') return !nativeTheme.shouldUseDarkColors
  try {
    const { stdout } = await execFileAsync('reg', [
      'query',
      WINDOWS_THEME_KEY,
      '/v',
      'SystemUsesLightTheme'
    ])
    const value = /SystemUsesLightTheme\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(stdout)
    return value ? parseInt(value[1], 16) === 1 : false
  } catch {
    return !nativeTheme.shouldUseDarkColors
  }
}

/** The tray asks for a 16px icon scaled by the display. Handing it that exact size keeps
 * the resize in Skia's hands — Windows stretches a mismatched bitmap far more crudely.
 * macOS is the opposite: sizes there are points, so multiplying by the scale factor
 * hands it an icon twice the height of the menu bar. It also re-tints template images
 * itself — including the inverted look while the menu is open — so the light/dark
 * silhouette pick is the system's job there, not ours. */
function trayIcon(): NativeImage {
  if (process.platform === 'darwin') {
    const source = nativeImage.createFromPath(trayBlack)
    const scaled = source.resize({
      width: MAC_TRAY_ICON_SIZE * 2,
      height: MAC_TRAY_ICON_SIZE * 2,
      quality: 'best'
    })
    // tagging the buffer as @2x makes those pixels a retina representation of an
    // 18pt icon rather than a 36pt one
    const icon = nativeImage.createFromBuffer(scaled.toPNG(), { scaleFactor: 2 })
    icon.setTemplateImage(true)
    return icon
  }
  const size = Math.round(TRAY_ICON_BASE_SIZE * screen.getPrimaryDisplay().scaleFactor)
  return nativeImage
    .createFromPath(lightBackground ? trayBlack : trayWhite)
    .resize({ width: size, height: size, quality: 'best' })
}

async function refreshTrayIcon(): Promise<void> {
  lightBackground = await readLightBackground()
  tray?.setImage(trayIcon())
}

function ensureTray(): void {
  if (tray) return
  tray = new Tray(trayIcon())
  tray.setToolTip('Blender Hub')
  refreshTrayMenu()
  tray.on('click', showWindow)
}

// the tray icon exists exactly while at least one behavior can hide the window,
// so a hidden window is never unreachable and an unused icon never lingers
function syncTray(): void {
  if (closeToTray || minimizeToTray || hiddenStartup) {
    ensureTray()
  } else {
    tray?.destroy()
    tray = null
  }
}

/** An autostarted launch that skips showing the window must be reachable from the
 * tray even when neither hide behavior is enabled; the icon is kept until the
 * window first shows, after which the regular behaviors decide its fate. */
export function ensureTrayForHiddenStartup(): void {
  hiddenStartup = true
  ensureTray()
}

export function setupTray(): void {
  // the theme is read before the tray exists so the first icon it gets already matches
  void Promise.all([readUiState(), readLightBackground()]).then(([state, light]) => {
    lightBackground = light
    closeToTray = state[CLOSE_BEHAVIOR_KEY] !== 'quit'
    minimizeToTray = state[MINIMIZE_BEHAVIOR_KEY] === 'tray'
    syncTray()
    // a hidden-startup tray may have been created before this read finished,
    // with the default (dark-taskbar) silhouette — recolor it now
    tray?.setImage(trayIcon())
  })
  nativeTheme.on('updated', () => void refreshTrayIcon())
  onUiStateSet((key, value) => {
    if (key === CLOSE_BEHAVIOR_KEY) {
      closeToTray = value === 'tray'
      syncTray()
    } else if (key === MINIMIZE_BEHAVIOR_KEY) {
      minimizeToTray = value === 'tray'
      syncTray()
    } else if (key === 'launcher.language' || key === TRAY_PAGES_KEY) {
      refreshTrayMenu()
    }
  })
  // quitting must always win over close-to-tray (tray menu Quit, updater restart)
  app.on('before-quit', () => {
    quitting = true
  })
}

export function attachTrayWindowBehavior(win: BrowserWindow): void {
  win.on('close', (event) => {
    if (quitting || !closeToTray) return
    event.preventDefault()
    win.hide()
  })
  // electron's typings declare 'minimize' without the event argument, but the
  // runtime passes one and preventDefault() does cancel the minimize
  const onMinimize = (event: Electron.Event): void => {
    if (!minimizeToTray) return
    event.preventDefault()
    win.hide()
  }
  win.on('minimize', onMinimize as unknown as () => void)
  // the first reveal ends the hidden-startup grace period for the tray icon
  win.on('show', () => {
    if (!hiddenStartup) return
    hiddenStartup = false
    syncTray()
  })
}

/** Bring back a window that may be hidden in the tray (second launch, dock click). */
export function revealMainWindow(): void {
  showWindow()
}
