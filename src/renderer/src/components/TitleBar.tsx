import { useEffect, useState } from 'react'
import { useTranslation } from '../lib/i18n'
import { isMac } from '../lib/platform'
import { getLauncherApi } from '../lib/preview-fallback'
import {
  applyThemeSelection,
  BUILTIN_THEMES,
  DEFAULT_PRESET_ID,
  DEFAULT_THEME_COLORS,
  onThemeSelectionChanged
} from '../lib/theme'
import { onUiChanged, uiGet } from '../lib/ui-store'
import { sanitizeThemeColors, THEME_SELECTED_UI_KEY } from '../../../shared/theme'
import type { ThemeColors } from '../../../shared/theme'
import { isReleasedCycle } from '../../../shared/blender-builds'
import type { HubNotification } from '../../../shared/types'
import Dropdown from './Dropdown'
// category icons mirror the sidebar tabs each notification navigates to
import { BlocksIcon, DownloadIcon, SyncIcon } from './Sidebar'

// Both platforms let the OS draw its window buttons on top of this bar, just in
// opposite corners, so the side they land on has to stay empty. Windows puts the
// minimize/maximize/close overlay on the right (BrowserWindow's titleBarOverlay);
// macOS keeps its traffic lights on the left, at the offset main/index.ts pins
// them to. Widths cover the button cluster plus a little breathing room.
const WINDOWS_OVERLAY_WIDTH = 140
const MAC_TRAFFIC_LIGHTS_WIDTH = 82
const EDGE_PADDING = 12

function BellIcon({ className = 'h-5 w-5' }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M6 8a6 6 0 0 1 12 0c0 4 1.5 5.5 2 6H4c.5-.5 2-2 2-6Z" />
      <path d="M9.5 18a2.5 2.5 0 0 0 5 0" />
    </svg>
  )
}

function UpdateIcon({ className = 'h-4 w-4' }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="9" />
      <path d="m8 12 4-4 4 4" />
      <path d="M12 16V8" />
    </svg>
  )
}

function AlertIcon({ className = 'h-4 w-4' }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M10.3 3.9 1.8 18.1a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />
      <path d="M12 9v4" />
      <path d="M12 17h.01" />
    </svg>
  )
}

function GearIcon({ className = 'h-4 w-4' }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1Z" />
    </svg>
  )
}

function XIcon({ className = 'h-3 w-3' }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
    >
      <path d="m6 6 12 12M18 6 6 18" />
    </svg>
  )
}

function PaletteIcon({ className = 'h-5 w-5' }: { className?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M12 3a9 9 0 1 0 0 18h1.4a2.1 2.1 0 0 0 1.5-3.6 2.1 2.1 0 0 1 1.5-3.6H19a2 2 0 0 0 2-2A9 9 0 0 0 12 3Z" />
      <circle cx="7.6" cy="12.4" r="0.4" />
      <circle cx="9" cy="8.2" r="0.4" />
      <circle cx="13.2" cy="6.8" r="0.4" />
      <circle cx="16.8" cy="9" r="0.4" />
    </svg>
  )
}

interface ThemeEntry {
  selectionId: string
  name: string
  colors: ThemeColors
}

// Quick theme switcher — the same list as the Settings dropdown, applied through
// the shared helper so both pickers (and other windows) stay in sync
function ThemeMenu({ onOpenSettings }: { onOpenSettings: () => void }) {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [userThemes, setUserThemes] = useState<ThemeEntry[]>([])
  const [selection, setSelection] = useState(
    () => uiGet(THEME_SELECTED_UI_KEY) ?? `builtin:${DEFAULT_PRESET_ID}`
  )

  useEffect(() => {
    const readSelection = (): void => {
      setSelection(uiGet(THEME_SELECTED_UI_KEY) ?? `builtin:${DEFAULT_PRESET_ID}`)
    }
    const offLocal = onThemeSelectionChanged(readSelection)
    const offForeign = onUiChanged((key) => {
      if (key === THEME_SELECTED_UI_KEY) readSelection()
    })
    return () => {
      offLocal()
      offForeign()
    }
  }, [])

  const toggle = (): void => {
    const next = !open
    setOpen(next)
    if (next) {
      // list fresh on open — themes may have been saved/deleted in Settings
      const { api } = getLauncherApi()
      api.themes
        .list()
        .then((list) =>
          setUserThemes(
            list.map((theme) => ({
              selectionId: `user:${theme.id}`,
              name: theme.name,
              colors: sanitizeThemeColors(theme.colors)
            }))
          )
        )
        .catch(() => setUserThemes([])) // browser preview: built-ins only
    }
  }

  const entries: ThemeEntry[] = [
    ...BUILTIN_THEMES.map((preset) => ({
      selectionId: `builtin:${preset.id}`,
      name: preset.name,
      colors: preset.colors
    })),
    ...userThemes
  ]

  return (
    <Dropdown
      open={open}
      onClose={() => setOpen(false)}
      align="right"
      menuClassName="max-h-64 w-56 overflow-auto rounded-lg border border-white/10 bg-surface-menu p-1 shadow-xl"
      trigger={
        <button
          onClick={toggle}
          title={t('titlebar.theme')}
          className="flex h-7 w-7 items-center justify-center rounded-md text-icon transition-colors hover:bg-white/10 hover:text-icon-hover [-webkit-app-region:no-drag]"
        >
          <PaletteIcon className="h-[18px] w-[18px]" />
        </button>
      }
    >
      <div className="flex items-center justify-between gap-2 px-3 py-1.5">
        <span className="text-xs font-semibold text-zinc-400">{t('titlebar.theme')}</span>
        <button
          onClick={() => {
            setOpen(false)
            onOpenSettings()
          }}
          title={t('titlebar.themeSettings')}
          className="flex h-6 w-6 items-center justify-center rounded text-icon transition-colors hover:bg-white/10 hover:text-icon-hover"
        >
          <GearIcon className="h-3.5 w-3.5" />
        </button>
      </div>
      <div className="mb-1 border-t border-white/5" />
      {entries.map((entry) => (
        <button
          key={entry.selectionId}
          onClick={() => {
            setOpen(false)
            applyThemeSelection(entry.selectionId, entry.colors)
          }}
          className={`flex w-full items-center rounded-md px-3 py-1.5 text-left text-sm transition-colors ${
            selection === entry.selectionId
              ? 'bg-selection text-selection-text'
              : 'text-zinc-300 hover:bg-white/10'
          }`}
        >
          <span className="truncate">{entry.name}</span>
          <span className="ml-auto flex shrink-0 items-center gap-1 pl-3">
            {(['background', 'accent'] as const).map((key) => (
              <span
                key={key}
                className="h-3 w-3 rounded-full border border-white/20"
                style={{ backgroundColor: entry.colors[key] ?? DEFAULT_THEME_COLORS[key] }}
              />
            ))}
          </span>
        </button>
      ))}
    </Dropdown>
  )
}

/** "4.5.12" for released builds, "5.3.0 alpha" otherwise — cycle words are badges, never translated */
const buildLabel = (version: string, cycle: string): string =>
  isReleasedCycle(cycle) || !cycle ? version : `${version} ${cycle}`

/** localized title/detail for one notification — records carry data, text is built here */
function notificationTexts(
  notification: HubNotification,
  t: (key: string, params?: Record<string, string | number>) => string
): { title: string; detail: string | null } {
  switch (notification.category) {
    case 'launcher-update':
      return {
        title: t('nav.updateAvailable'),
        detail: t('settings.updatesAvailable', { version: notification.payload.version })
      }
    case 'blender-update': {
      const { installedVersion, installedCycle, targetVersion, targetCycle } = notification.payload
      return {
        title: t('notifications.blenderUpdate'),
        detail: `${buildLabel(installedVersion, installedCycle)} → ${buildLabel(targetVersion, targetCycle)}`
      }
    }
    case 'addon-update': {
      const { name, installedVersion, catalogVersion } = notification.payload
      return {
        title: t('notifications.addonUpdate'),
        detail: `${name}: ${installedVersion} → ${catalogVersion}`
      }
    }
    case 'operation': {
      const { result, version, releaseCycle, error } = notification.payload
      const label = buildLabel(version, releaseCycle)
      return result === 'done'
        ? { title: t('notifications.installDone', { version: label }), detail: null }
        : { title: t('notifications.installFailed', { version: label }), detail: error ?? null }
    }
    case 'sync-changes': {
      const { minors, conflicts } = notification.payload
      return {
        title: conflicts > 0 ? t('notifications.syncConflicts') : t('notifications.syncChanges'),
        detail: t('notifications.syncChangesDetail', { versions: minors.join(', ') })
      }
    }
    case 'superhive-auth':
      return {
        title: t('notifications.superhiveAuth'),
        detail: t('notifications.superhiveAuthDetail')
      }
  }
  // the store filters unknown categories out, but a record slipping through must
  // degrade to a label, never crash the render
  return { title: (notification as unknown as { category: string }).category, detail: null }
}

/** today → time of day, older → short date; plain Intl, no extra locale keys needed */
function notificationWhen(createdAt: number, language: string): string {
  const date = new Date(createdAt)
  const sameDay = new Date().toDateString() === date.toDateString()
  return sameDay
    ? date.toLocaleTimeString(language, { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleDateString(language, { day: 'numeric', month: 'short' })
}

interface TitleBarProps {
  onNotificationClick: (notification: HubNotification) => void
  /** the panel's gear — jumps to the notification toggles in Settings */
  onOpenNotificationSettings: () => void
  /** the theme menu's gear — jumps to the theme editor card in Settings */
  onOpenThemeSettings: () => void
}

export default function TitleBar({
  onNotificationClick,
  onOpenNotificationSettings,
  onOpenThemeSettings
}: TitleBarProps) {
  const { t, language } = useTranslation()
  const mac = isMac()
  const [menuOpen, setMenuOpen] = useState(false)
  const [items, setItems] = useState<HubNotification[]>([])

  useEffect(() => {
    const { api } = getLauncherApi()
    let alive = true
    api.notifications
      .list()
      .then((list) => {
        if (alive) setItems(list)
      })
      .catch(() => {})
    // background detections / read-dismiss actions in any window land here
    const unsubscribe = api.notifications.onChanged((list) => setItems(list))
    return () => {
      alive = false
      unsubscribe()
    }
  }, [])

  const unread = items.filter((item) => !item.read).length

  // closing the panel means "seen" — the badge clears, the entries stay until dismissed
  const closeMenu = (): void => {
    setMenuOpen(false)
    if (unread > 0) void getLauncherApi().api.notifications.markAllRead().catch(() => {})
  }

  return (
    <div
      // no border-b: the bar and the sidebar share a background and must read as one
      // panel. The content area draws that hairline on its own top edge instead.
      className="flex h-10 shrink-0 items-center justify-end gap-1 bg-surface-panel [-webkit-app-region:drag]"
      style={{
        paddingLeft: mac ? MAC_TRAFFIC_LIGHTS_WIDTH : EDGE_PADDING,
        paddingRight: mac ? EDGE_PADDING : WINDOWS_OVERLAY_WIDTH
      }}
    >
      <ThemeMenu onOpenSettings={onOpenThemeSettings} />
      <Dropdown
        open={menuOpen}
        onClose={closeMenu}
        align="right"
        menuClassName="max-h-96 w-80 overflow-auto rounded-lg border border-white/10 bg-surface-dialog p-1 shadow-xl"
        trigger={
          <button
            onClick={() => (menuOpen ? closeMenu() : setMenuOpen(true))}
            title={t('titlebar.notifications')}
            className="relative flex h-7 w-7 items-center justify-center rounded-md text-icon transition-colors hover:bg-white/10 hover:text-icon-hover [-webkit-app-region:no-drag]"
          >
            <BellIcon className="h-[18px] w-[18px]" />
            {unread > 0 && (
              <span className="absolute -right-0.5 -top-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-blender px-1 text-[9px] font-semibold leading-none text-on-accent">
                {unread > 9 ? '9+' : unread}
              </span>
            )}
          </button>
        }
      >
        <div className="flex items-center justify-between gap-2 px-3 py-1.5">
          <span className="text-xs font-semibold text-zinc-400">{t('titlebar.notifications')}</span>
          <button
            onClick={() => {
              closeMenu()
              onOpenNotificationSettings()
            }}
            title={t('notifications.settingsHint')}
            className="flex h-6 w-6 items-center justify-center rounded text-icon transition-colors hover:bg-white/10 hover:text-icon-hover"
          >
            <GearIcon className="h-3.5 w-3.5" />
          </button>
        </div>
        <div className="mb-1 border-t border-white/5" />
        {items.length === 0 ? (
          <p className="px-3 py-2 text-xs text-zinc-500">{t('titlebar.noNotifications')}</p>
        ) : (
          <>
            {items.map((item) => {
              const { title, detail } = notificationTexts(item, t)
              // the icon doubles as the unread indicator (accent), except where a
              // semantic tone matters more: a failed install, a settings conflict
              const Icon =
                item.category === 'launcher-update'
                  ? UpdateIcon
                  : item.category === 'addon-update'
                    ? BlocksIcon
                    : item.category === 'sync-changes'
                      ? SyncIcon
                      : item.category === 'superhive-auth'
                        ? AlertIcon
                        : DownloadIcon // blender-update and install operations — the Installs tab
              const tone =
                item.category === 'operation' && item.payload.result === 'error'
                  ? 'text-red-400'
                  : item.category === 'sync-changes' && item.payload.conflicts > 0
                    ? 'text-amber-400'
                    : item.read
                      ? 'text-zinc-500'
                      : 'text-blender'
              return (
                <div key={item.id} className="group relative">
                  <button
                    onClick={() => {
                      closeMenu()
                      onNotificationClick(item)
                    }}
                    className="flex w-full items-center gap-2.5 rounded-md px-3 py-2 pr-8 text-left transition-colors hover:bg-white/10"
                  >
                    <Icon className={`h-4 w-4 shrink-0 ${tone}`} />
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                      <span className="flex w-full min-w-0 items-center gap-2">
                        <span
                          className={`min-w-0 truncate text-sm ${
                            item.read ? 'text-zinc-300' : 'font-medium text-zinc-100'
                          }`}
                        >
                          {title}
                        </span>
                        <span className="ml-auto shrink-0 text-[10px] text-zinc-600">
                          {notificationWhen(item.createdAt, language)}
                        </span>
                      </span>
                      {detail && <span className="w-full truncate text-xs text-zinc-500">{detail}</span>}
                    </span>
                  </button>
                  <button
                    onClick={() => {
                      void getLauncherApi().api.notifications.dismiss(item.id).catch(() => {})
                    }}
                    title={t('notifications.dismiss')}
                    className="absolute right-1.5 top-1.5 hidden h-5 w-5 items-center justify-center rounded text-zinc-500 transition-colors hover:bg-white/10 hover:text-zinc-200 group-hover:flex"
                  >
                    <XIcon />
                  </button>
                </div>
              )
            })}
            <div className="mt-1 border-t border-white/5 pt-1">
              <button
                onClick={() => {
                  void getLauncherApi().api.notifications.dismissAll().catch(() => {})
                }}
                className="w-full rounded-md px-3 py-1.5 text-left text-xs text-zinc-500 transition-colors hover:bg-white/10 hover:text-zinc-300"
              >
                {t('notifications.clearAll')}
              </button>
            </div>
          </>
        )}
      </Dropdown>
    </div>
  )
}
