import { useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { useTranslation } from '../lib/i18n'
import { getLauncherApi } from '../lib/preview-fallback'
import logo from '../assets/icon.png'
import { DISCORD_INVITE_URL, SHOW_ACTIVITY, SHOW_COMMUNITY_LINKS, SUPPORT_URL } from '../../../shared/app-config'
import type { Page } from '../../../shared/types'

export type { Page }

interface IconProps {
  className?: string
}

export function FolderIcon({ className = 'h-5 w-5' }: IconProps) {
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
      <path d="M4 5h5l2 2h9a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1Z" />
    </svg>
  )
}

export function DownloadIcon({ className = 'h-5 w-5' }: IconProps) {
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
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="7 10 12 15 17 10" />
      <line x1="12" x2="12" y1="3" y2="15" />
    </svg>
  )
}

export function BlocksIcon({ className = 'h-5 w-5' }: IconProps) {
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
      <rect x="3" y="3" width="8" height="8" rx="1.5" />
      <rect x="13" y="3" width="8" height="8" rx="1.5" />
      <rect x="3" y="13" width="8" height="8" rx="1.5" />
      <rect x="13" y="13" width="8" height="8" rx="1.5" />
    </svg>
  )
}

export function SlidersIcon({ className = 'h-5 w-5' }: IconProps) {
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
      <line x1="21" x2="14" y1="4" y2="4" />
      <line x1="10" x2="3" y1="4" y2="4" />
      <line x1="21" x2="12" y1="12" y2="12" />
      <line x1="8" x2="3" y1="12" y2="12" />
      <line x1="21" x2="16" y1="20" y2="20" />
      <line x1="12" x2="3" y1="20" y2="20" />
      <line x1="14" x2="14" y1="2" y2="6" />
      <line x1="8" x2="8" y1="10" y2="14" />
      <line x1="16" x2="16" y1="18" y2="22" />
    </svg>
  )
}

export function SyncIcon({ className = 'h-5 w-5' }: IconProps) {
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
      <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" />
      <path d="M21 3v5h-5" />
      <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" />
      <path d="M8 16H3v5" />
    </svg>
  )
}

export function ActivityIcon({ className = 'h-5 w-5' }: IconProps) {
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
      <path d="M3 12h4l3 8 4-16 3 8h4" />
    </svg>
  )
}

function ChatIcon({ className = 'h-5 w-5' }: IconProps) {
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
      <path d="M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z" />
    </svg>
  )
}

function HeartIcon({ className = 'h-5 w-5' }: IconProps) {
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
      <path d="M20.8 4.6a5.5 5.5 0 0 0-7.8 0L12 5.6l-1-1a5.5 5.5 0 0 0-7.8 7.8l1 1L12 21l7.8-7.6 1-1a5.5 5.5 0 0 0 0-7.8Z" />
    </svg>
  )
}

const MAIN_NAV_ITEMS: { id: Page; labelKey: string; icon: ReactNode }[] = [
  { id: 'projects', labelKey: 'nav.projects', icon: <FolderIcon className="h-5 w-5 shrink-0" /> },
  { id: 'installs', labelKey: 'nav.installs', icon: <DownloadIcon className="h-5 w-5 shrink-0" /> },
  { id: 'addons', labelKey: 'nav.addons', icon: <BlocksIcon className="h-5 w-5 shrink-0" /> },
  { id: 'sync', labelKey: 'nav.sync', icon: <SyncIcon className="h-5 w-5 shrink-0" /> }
]

interface SidebarProps {
  current: Page
  onNavigate: (page: Page) => void
  onUpdateClick: () => void
  /** owned by App — the toggle for it lives in the title bar */
  collapsed: boolean
}

export default function Sidebar({ current, onNavigate, onUpdateClick, collapsed }: SidebarProps) {
  const { t } = useTranslation()
  const [version, setVersion] = useState('')
  const [updateAvailable, setUpdateAvailable] = useState(false)

  useEffect(() => {
    const { api } = getLauncherApi()
    let alive = true
    api.updates
      .getVersion()
      .then((value) => alive && setVersion(value))
      .catch(() => {})
    api.updates
      .check()
      .then((result) => alive && setUpdateAvailable(result.updateAvailable))
      .catch(() => {})
    // later checks (manual re-check in Settings, download completion) push here too
    const unsubscribe = api.updates.onStateChanged((state) => setUpdateAvailable(state.updateAvailable))
    return () => {
      alive = false
      unsubscribe()
    }
  }, [])

  // the icon is the button's only svg child — coloring it from here keeps the
  // three states in one place instead of on every icon element
  const navButtonClass = (active: boolean): string =>
    `flex items-center gap-3 overflow-hidden whitespace-nowrap rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
      active
        ? 'bg-selection text-selection-text [&>svg]:text-icon-selected'
        : 'text-zinc-400 hover:bg-white/10 hover:text-zinc-100 [&>svg]:text-icon hover:[&>svg]:text-icon-hover'
    }`

  return (
    <aside
      // no border-r: the content area draws that hairline on its own left edge, so it
      // stays identical to the one along its top and curves with the corner between them
      className={`flex ${collapsed ? 'w-16' : 'w-56'} shrink-0 flex-col bg-surface-panel transition-[width] duration-150`}
    >
      <div className="flex h-[68px] shrink-0 items-center gap-2.5 px-4">
        {/* max-w-none overrides Tailwind's preflight `img { max-width: 100% }`: collapsed,
            this column leaves exactly 32px between its paddings, so any pixel taken off
            that width clamps this fixed-size logo and squashes it against its own height */}
        <img src={logo} alt="" className="h-8 w-8 max-w-none shrink-0" />
        {!collapsed && (
          <div className="min-w-0 leading-tight">
            <p className="truncate font-logo text-sm font-bold text-zinc-100">
              Blender <span className="text-[var(--blender-brand)]">Hub</span>
            </p>
            {version && <p className="text-[11px] text-zinc-500">v{version}</p>}
          </div>
        )}
      </div>
      <nav className="flex flex-col gap-1 px-2">
        {MAIN_NAV_ITEMS.map((item) => (
          <button
            key={item.id}
            title={collapsed ? t(item.labelKey) : undefined}
            onClick={() => onNavigate(item.id)}
            className={navButtonClass(item.id === current)}
          >
            {item.icon}
            {!collapsed && t(item.labelKey)}
          </button>
        ))}
      </nav>
      <div className="flex-1" />
      {/* pb matches px: the last button sits as far from the bottom edge as from the sides */}
      <nav className="flex flex-col gap-1 px-2 pb-2">
        {updateAvailable && (
          <button
            title={collapsed ? t('nav.updateAvailable') : undefined}
            onClick={onUpdateClick}
            className="flex items-center gap-3 overflow-hidden whitespace-nowrap rounded-lg bg-blender/10 px-3 py-2 text-sm font-medium text-blender transition-colors hover:bg-blender/15"
          >
            <DownloadIcon className="h-5 w-5 shrink-0" />
            {!collapsed && t('nav.updateAvailable')}
          </button>
        )}
        {SHOW_ACTIVITY && (
          <button
            title={collapsed ? t('nav.activity') : undefined}
            onClick={() => onNavigate('activity')}
            className={navButtonClass(current === 'activity')}
          >
            <ActivityIcon className="h-5 w-5 shrink-0" />
            {!collapsed && t('nav.activity')}
          </button>
        )}
        {SHOW_COMMUNITY_LINKS && (
          <>
            {DISCORD_INVITE_URL ? (
              <button
                title={collapsed ? t('nav.joinDiscord') : undefined}
                onClick={() => window.open(DISCORD_INVITE_URL, '_blank', 'noopener')}
                className={navButtonClass(false)}
              >
                <ChatIcon className="h-5 w-5 shrink-0" />
                {!collapsed && t('nav.joinDiscord')}
              </button>
            ) : (
              <button
                title={t('nav.comingSoon')}
                disabled
                className="flex cursor-not-allowed items-center gap-3 overflow-hidden whitespace-nowrap rounded-lg px-3 py-2 text-sm font-medium text-zinc-600 opacity-60"
              >
                <ChatIcon className="h-5 w-5 shrink-0" />
                {!collapsed && t('nav.joinDiscord')}
              </button>
            )}
            {SUPPORT_URL ? (
              <button
                title={collapsed ? t('nav.supportUs') : undefined}
                onClick={() => window.open(SUPPORT_URL, '_blank', 'noopener')}
                className={navButtonClass(false)}
              >
                <HeartIcon className="h-5 w-5 shrink-0" />
                {!collapsed && t('nav.supportUs')}
              </button>
            ) : (
              <button
                title={t('nav.comingSoon')}
                disabled
                className="flex cursor-not-allowed items-center gap-3 overflow-hidden whitespace-nowrap rounded-lg px-3 py-2 text-sm font-medium text-zinc-600 opacity-60"
              >
                <HeartIcon className="h-5 w-5 shrink-0" />
                {!collapsed && t('nav.supportUs')}
              </button>
            )}
          </>
        )}
        {/* only a separator when something actually sits above it — with the update
            banner absent and Activity/community links hidden, Settings is alone here */}
        {(updateAvailable || SHOW_ACTIVITY || SHOW_COMMUNITY_LINKS) && (
          <div className="my-1 border-t border-white/5" />
        )}
        <button
          title={collapsed ? t('nav.settings') : undefined}
          onClick={() => onNavigate('settings')}
          className={navButtonClass(current === 'settings')}
        >
          <SlidersIcon className="h-5 w-5 shrink-0" />
          {!collapsed && t('nav.settings')}
        </button>
      </nav>
    </aside>
  )
}
