import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import ScrollToTop from '../../components/ScrollToTop'
import { useTranslation } from '../../lib/i18n'
import { getLauncherApi } from '../../lib/preview-fallback'
import { useBackdropClose } from '../../lib/use-backdrop-close'
import { XIcon } from './icons'
import { SETTINGS_SECTIONS, type SettingsSection } from './sections'

/**
 * Modal frame of the settings window: header with the launcher version, section list on
 * the left, the selected section's cards on the right. The cards themselves (and all the
 * state behind them) stay in pages/Settings.tsx and arrive as children.
 */
export function SettingsWindow({
  section,
  onSectionChange,
  onClose,
  banner,
  children
}: {
  section: SettingsSection
  onSectionChange: (section: SettingsSection) => void
  onClose: () => void
  /** full-width strip under the header, shown on every section (the launcher update notice) */
  banner?: ReactNode
  children: ReactNode
}) {
  const { t } = useTranslation()
  const [version, setVersion] = useState('')
  const contentRef = useRef<HTMLDivElement>(null)
  const backdrop = useBackdropClose(onClose)

  useEffect(() => {
    let alive = true
    getLauncherApi()
      .api.updates.getVersion()
      .then((value) => alive && setVersion(value))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])

  // Escape closes the window — unless something layered on top owns the key: an open
  // dropdown consumes it before it gets here, a confirm/alert dialog may be waiting on an
  // answer, and in a text field Escape means "leave the field", not "discard the window".
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      if (document.querySelector('[data-modal-overlay]')) return
      const target = event.target
      if (target instanceof Element && target.closest('input, textarea, select, [contenteditable="true"]')) return
      onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  // each section opens at its top, not wherever the previous one was scrolled to
  useEffect(() => {
    contentRef.current?.scrollTo({ top: 0 })
  }, [section])

  const current = SETTINGS_SECTIONS.find((entry) => entry.id === section) ?? SETTINGS_SECTIONS[0]

  return (
    // starts below the title bar, like the drop overlay: the window stays draggable and
    // the OS caption buttons stay clear while settings are open
    <div
      className="fixed inset-x-0 bottom-0 top-10 z-40 flex items-center justify-center bg-black/60 p-6"
      {...backdrop}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={t('nav.settings')}
        className="flex h-full max-h-[860px] w-full max-w-5xl flex-col overflow-hidden rounded-xl border border-white/10 bg-surface-panel shadow-2xl shadow-black/60"
      >
        <header className="flex h-16 shrink-0 items-center gap-3 border-b border-white/5 px-6">
          <h1 className="text-xl font-semibold text-zinc-100">{t('nav.settings')}</h1>
          {version && (
            <span className="rounded-md bg-white/10 px-2 py-0.5 text-xs font-medium text-zinc-300">
              Blender Hub {version}
            </span>
          )}
          <button
            type="button"
            onClick={onClose}
            title={t('common.close')}
            className="-mr-2 ml-auto flex h-8 w-8 items-center justify-center rounded-md text-icon transition-colors hover:bg-white/10 hover:text-icon-hover"
          >
            <XIcon className="h-4 w-4" />
          </button>
        </header>
        {banner}
        <div className="flex min-h-0 flex-1">
          <nav className="flex w-52 shrink-0 flex-col gap-0.5 overflow-y-auto border-r border-white/5 p-2">
            {SETTINGS_SECTIONS.map((entry) => (
              <button
                key={entry.id}
                type="button"
                onClick={() => onSectionChange(entry.id)}
                className={`rounded-lg px-3 py-2 text-left text-sm font-medium transition-colors ${
                  entry.id === section
                    ? 'bg-selection text-selection-text'
                    : 'text-zinc-400 hover:bg-white/10 hover:text-zinc-100'
                }`}
              >
                {t(entry.labelKey)}
              </button>
            ))}
          </nav>
          {/* the content keeps the main window's look — panel-coloured cards on the dark
              page background — so moving the cards in here changes nothing about them */}
          <div className="relative min-w-0 flex-1 bg-background">
            {/* right padding is 24px minus the 10px scrollbar gutter, so both sides read
                equal — same arithmetic as PageLayout */}
            <div
              ref={contentRef}
              className="h-full overflow-y-auto pb-6 pl-6 pr-3.5 pt-5 [scrollbar-gutter:stable]"
            >
              <h2 className="mb-4 text-xl font-semibold text-zinc-100">{t(current.labelKey)}</h2>
              <div className="flex flex-col gap-4">{children}</div>
            </div>
            <ScrollToTop targetRef={contentRef} />
          </div>
        </div>
      </div>
    </div>
  )
}
