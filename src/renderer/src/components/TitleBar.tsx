import { useEffect, useState } from 'react'
import { useTranslation } from '../lib/i18n'
import { isMac } from '../lib/platform'
import { getLauncherApi } from '../lib/preview-fallback'
import Dropdown from './Dropdown'

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

interface TitleBarProps {
  onUpdateClick: () => void
}

export default function TitleBar({ onUpdateClick }: TitleBarProps) {
  const { t } = useTranslation()
  const mac = isMac()
  const [menuOpen, setMenuOpen] = useState(false)
  const [updateAvailable, setUpdateAvailable] = useState(false)
  const [latestVersion, setLatestVersion] = useState<string | null>(null)

  useEffect(() => {
    const { api } = getLauncherApi()
    let alive = true
    api.updates
      .check()
      .then((result) => {
        if (!alive) return
        setUpdateAvailable(result.updateAvailable)
        setLatestVersion(result.latestVersion)
      })
      .catch(() => {})
    // Settings' manual re-check / a finished download push their result here too
    const unsubscribe = api.updates.onStateChanged((state) => {
      setUpdateAvailable(state.updateAvailable)
      setLatestVersion(state.latestVersion)
    })
    return () => {
      alive = false
      unsubscribe()
    }
  }, [])

  return (
    <div
      className="flex h-10 shrink-0 items-center justify-end gap-1 border-b border-white/5 bg-surface-panel [-webkit-app-region:drag]"
      style={{
        paddingLeft: mac ? MAC_TRAFFIC_LIGHTS_WIDTH : EDGE_PADDING,
        paddingRight: mac ? EDGE_PADDING : WINDOWS_OVERLAY_WIDTH
      }}
    >
      <Dropdown
        open={menuOpen}
        onClose={() => setMenuOpen(false)}
        align="right"
        menuClassName="w-64 rounded-lg border border-white/10 bg-surface-dialog p-1 shadow-xl"
        trigger={
          <button
            onClick={() => setMenuOpen((open) => !open)}
            title={t('titlebar.notifications')}
            className="relative flex h-7 w-7 items-center justify-center rounded-md text-zinc-400 transition-colors hover:bg-white/10 hover:text-zinc-200 [-webkit-app-region:no-drag]"
          >
            <BellIcon className="h-[18px] w-[18px]" />
            {updateAvailable && (
              <span className="absolute right-1 top-1 h-1.5 w-1.5 rounded-full bg-blender" />
            )}
          </button>
        }
      >
        {updateAvailable ? (
          <button
            onClick={() => {
              setMenuOpen(false)
              onUpdateClick()
            }}
            className="flex w-full flex-col items-start gap-0.5 rounded-md px-3 py-2 text-left transition-colors hover:bg-white/10"
          >
            <span className="text-sm font-medium text-zinc-100">{t('nav.updateAvailable')}</span>
            <span className="text-xs text-zinc-500">
              {t('settings.updatesAvailable', { version: latestVersion ?? '' })}
            </span>
          </button>
        ) : (
          <p className="px-3 py-2 text-xs text-zinc-500">{t('titlebar.noNotifications')}</p>
        )}
      </Dropdown>
    </div>
  )
}
