import { spawn } from 'child_process'
import { existsSync } from 'fs'
import { basename } from 'path'
import { app, BrowserWindow, Menu, nativeImage, Notification, Tray } from 'electron'
import type { MenuItemConstructorOptions } from 'electron'
import { onUiStateSet, readUiState } from './ui-state'
import { readBlendInfo } from './blender/blend-parser'
import { listInstalled } from './blender/installs'
import { getOverrides, getRecentlyOpened, recordProjectOpened } from './projects/store'
import type { Page } from '../shared/types'

// Optional stay-in-tray behavior: the close and minimize buttons can hide the
// window instead. Both preferences live in ui-state.json (renderer writes them
// from Settings via the existing ui:set-state channel — no extra IPC needed).

export const CLOSE_BEHAVIOR_KEY = 'window.closeBehavior' // 'quit' (default) | 'tray'
export const MINIMIZE_BEHAVIOR_KEY = 'window.minimizeBehavior' // 'taskbar' (default) | 'tray'

// 32x32 orange rounded square with a white "B" (matches the sidebar logo);
// embedded as a data URL because the repo ships no icon assets yet
const TRAY_ICON_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAGkSURBVFhHxZexS8QwFMYziiaeo6OL4Kibi+Ao/gOuNzoKLnKXUMVBcHK7TXFwFkS4wcFNJ1cnoS5eWvU8ULAiwulrSWhfsLWxzT34LV/y+r6+PEpDSE6ErfF5yVlTCrZtDWdNeA5+9q/x4NG5ULDTQLBh9dBu0GKLuKYOcBtwFpmJFcPZnu+RsUzxnqDrxsYaCTnr6OLQdidvjpDtieXYQCDYJV50Aqc+gbMwFhxCYCqx6BJo/wYWXULgY4FFl5Qy8HaxM/y4PTMA/XF/1tj/F0oZgGJ58XK4auQUYW2g31mKeb851hqs45wirA2k9ZEaeDpY0Nrr+aaRU4S1ATWA/ykOWBvA8Xl/FXcD5xRhbUAN4eBkLWMk3J028vKwNpDWof0qwBTOy6MSA7gzOC8PawNqCL+e77QGc4BzirA2gAPWyp4/UMoATLkavjQ2hRWlDNQBkYJuYdElpNeeXMGiS8jAa0xh0SXJXzGnPl5wAmdRcikZ0THA/OnLSSDoEd5QJ1LQa10cIpkF2sUb6wCKS68xkzGgIrmg0gFOqgTOokzbf+IbuLCsi0svJaUAAAAASUVORK5CYII='

// the tray is native OS chrome, out of reach of the renderer's i18n context — a tiny,
// static lookup mirrors the couple of dictionaries that matter (kept in sync by hand;
// see renderer/src/locales/*.json for the source of truth on wording)
type TrayLang = 'en' | 'ru'
const TRAY_LABELS: Record<
  TrayLang,
  { openHub: string; quit: string; recentProjects: string; noRecentProjects: string; nav: Record<Page, string> }
> = {
  en: {
    openHub: 'Open Blender Hub',
    quit: 'Quit',
    recentProjects: 'Recent Projects',
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
    recentProjects: 'Последние проекты',
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

const NAV_PAGES: Page[] = ['projects', 'installs', 'addons', 'sync', 'activity', 'settings']
const RECENT_PROJECTS_LIMIT = 5

let closeToTray = false
let minimizeToTray = false
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
  const native = version && builds.find((b) => b.version === version || b.version.startsWith(`${version}.`))
  return native || builds[0]
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
  const child = spawn(build.executable, [filePath], { cwd: build.path, detached: true, stdio: 'ignore' })
  child.unref()
  recordProjectOpened(filePath)
    .then(() => refreshTrayMenu())
    .catch(() => {})
}

async function recentProjectItems(lang: TrayLang): Promise<MenuItemConstructorOptions[]> {
  // a couple extra beyond what's shown may point at since-deleted files — filter, then cap
  const recents = (await getRecentlyOpened(RECENT_PROJECTS_LIMIT + 10)).filter((entry) =>
    existsSync(entry.path)
  )
  if (recents.length === 0) {
    return [{ label: TRAY_LABELS[lang].noRecentProjects, enabled: false }]
  }
  const overrides = await getOverrides()
  return recents.slice(0, RECENT_PROJECTS_LIMIT).map(({ path }) => ({
    label: overrides[path]?.displayName ?? basename(path),
    click: () => void openProjectFromTray(path, lang)
  }))
}

async function buildTrayMenu(): Promise<Menu> {
  const state = await readUiState()
  const lang: TrayLang = state['launcher.language'] === 'ru' ? 'ru' : 'en'
  const labels = TRAY_LABELS[lang]
  return Menu.buildFromTemplate([
    { label: labels.openHub, click: showWindow },
    { type: 'separator' },
    ...NAV_PAGES.map((page): MenuItemConstructorOptions => ({ label: labels.nav[page], click: () => navigateTo(page) })),
    { type: 'separator' },
    { label: labels.recentProjects, submenu: await recentProjectItems(lang) },
    { type: 'separator' },
    { label: labels.quit, click: () => app.quit() }
  ])
}

/** rebuild and reassign the tray's menu — call after anything that changes its contents
 * (a project opened, the display language changed) so the next open shows it fresh */
export function refreshTrayMenu(): void {
  if (!tray) return
  void buildTrayMenu().then((menu) => tray?.setContextMenu(menu))
}

function ensureTray(): void {
  if (tray) return
  tray = new Tray(nativeImage.createFromDataURL(TRAY_ICON_DATA_URL))
  tray.setToolTip('Blender Hub')
  refreshTrayMenu()
  tray.on('click', showWindow)
}

// the tray icon exists exactly while at least one behavior can hide the window,
// so a hidden window is never unreachable and an unused icon never lingers
function syncTray(): void {
  if (closeToTray || minimizeToTray) {
    ensureTray()
  } else {
    tray?.destroy()
    tray = null
  }
}

export function setupTray(): void {
  void readUiState().then((state) => {
    closeToTray = state[CLOSE_BEHAVIOR_KEY] === 'tray'
    minimizeToTray = state[MINIMIZE_BEHAVIOR_KEY] === 'tray'
    syncTray()
  })
  onUiStateSet((key, value) => {
    if (key === CLOSE_BEHAVIOR_KEY) {
      closeToTray = value === 'tray'
      syncTray()
    } else if (key === MINIMIZE_BEHAVIOR_KEY) {
      minimizeToTray = value === 'tray'
      syncTray()
    } else if (key === 'launcher.language') {
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
}

/** Bring back a window that may be hidden in the tray (second launch, dock click). */
export function revealMainWindow(): void {
  showWindow()
}
