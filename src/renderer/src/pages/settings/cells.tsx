import { useState } from 'react'
import type { ReactNode } from 'react'
import { useTranslation } from '../../lib/i18n'
import { formatBytes } from '../../lib/format'
import type { StorageUsage } from '../../../../shared/types'
import { STORAGE_META, secondaryButtonClass } from './constants'


export function SectionCard({
  title,
  hint,
  children,
  control,
  anchorId,
  highlighted
}: {
  title: string
  hint: string
  children?: ReactNode
  /** single control shown level with the title/hint (e.g. a dropdown or a lone button) — same row-based layout as the tray toggles below */
  control?: ReactNode
  anchorId?: string
  highlighted?: boolean
}) {
  return (
    <section
      id={anchorId}
      className={`rounded-xl border bg-[#181818] p-4 transition-colors ${
        highlighted ? 'border-blender/60' : 'border-white/5'
      }`}
    >
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-zinc-100">{title}</h2>
          <p className="mt-1 text-xs text-zinc-500">{hint}</p>
        </div>
        {control && <div className="shrink-0">{control}</div>}
      </div>
      {children && <div className="mt-3">{children}</div>}
    </section>
  )
}

export function BehaviorToggle({
  value,
  options,
  onChange,
  disabled,
  title
}: {
  value: string
  options: { id: string; label: string }[]
  onChange: (id: string) => void
  disabled?: boolean
  title?: string
}) {
  return (
    <div
      title={title}
      className={`inline-flex shrink-0 rounded-lg border border-white/10 bg-[#111111] p-0.5 ${
        disabled ? 'opacity-40' : ''
      }`}
    >
      {options.map((option) => (
        <button
          key={option.id}
          onClick={() => onChange(option.id)}
          disabled={disabled}
          className={`rounded-md px-3 py-1 text-xs font-medium transition-colors disabled:cursor-not-allowed ${
            value === option.id ? 'bg-blender/15 text-blender' : 'text-zinc-400 hover:text-zinc-200'
          }`}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

export function StorageUsageCard({
  usage,
  loading,
  isDesktop,
  desktopOnlyTitle,
  onRecalculate
}: {
  usage: StorageUsage | null
  loading: boolean
  isDesktop: boolean
  desktopOnlyTitle?: string
  onRecalculate: () => void
}) {
  const { t } = useTranslation()
  const [buildsOpen, setBuildsOpen] = useState(false)

  const total = usage?.totalBytes ?? 0
  const shown = (usage?.categories ?? []).filter((category) => category.bytes > 0)
  const builds = usage?.installs ?? []

  const recalcButton = (
    <button
      onClick={onRecalculate}
      disabled={!isDesktop || loading}
      title={desktopOnlyTitle}
      className={`${secondaryButtonClass} disabled:cursor-not-allowed disabled:opacity-40`}
    >
      {loading ? t('settings.storageCalculating') : t('settings.storageRecalculate')}
    </button>
  )

  return (
    <SectionCard title={t('settings.storage')} hint={t('settings.storageHint')}>
      {loading && !usage ? (
        <p className="text-xs text-zinc-500">{t('settings.storageCalculating')}</p>
      ) : total <= 0 ? (
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs text-zinc-500">{t('settings.storageEmpty')}</p>
          {recalcButton}
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <div className="flex items-baseline justify-between">
            <span className="text-xs text-zinc-500">{t('settings.storageTotal')}</span>
            <span className="text-lg font-semibold text-zinc-100">{formatBytes(total)}</span>
          </div>

          <div className="flex h-2 w-full overflow-hidden rounded-full bg-white/5">
            {shown.map((category) => (
              <div
                key={category.category}
                className={STORAGE_META[category.category].color}
                style={{ width: `${(category.bytes / total) * 100}%` }}
                title={`${t(STORAGE_META[category.category].labelKey)} — ${formatBytes(category.bytes)}`}
              />
            ))}
          </div>

          <ul className="flex flex-col gap-1.5">
            {shown.map((category) => {
              const meta = STORAGE_META[category.category]
              const expandable = category.category === 'installs' && builds.length > 0
              return (
                <li key={category.category} className="flex flex-col">
                  <div className="flex items-center gap-2 text-xs">
                    <span className={`h-2 w-2 shrink-0 rounded-full ${meta.color}`} />
                    <span className="text-zinc-300">{t(meta.labelKey)}</span>
                    {expandable && (
                      <button
                        onClick={() => setBuildsOpen((prev) => !prev)}
                        className="text-[11px] text-zinc-500 underline transition-colors hover:text-zinc-300"
                      >
                        {buildsOpen ? t('settings.storageHideBuilds') : t('settings.storageShowBuilds')}
                      </button>
                    )}
                    <span className="ml-auto tabular-nums text-zinc-400">{formatBytes(category.bytes)}</span>
                    <span className="w-9 text-right tabular-nums text-zinc-600">
                      {Math.round((category.bytes / total) * 100)}%
                    </span>
                  </div>
                  {expandable && buildsOpen && (
                    <ul className="mt-1.5 flex flex-col gap-1 border-l border-white/10 pl-4">
                      {builds.map((build) => (
                        <li key={build.id} className="flex items-center gap-2 text-[11px] text-zinc-500">
                          <span className="truncate" title={build.id}>
                            {build.version}
                            {build.releaseCycle && build.releaseCycle !== 'stable'
                              ? ` · ${build.releaseCycle}`
                              : ''}
                          </span>
                          <span className="ml-auto shrink-0 tabular-nums">{formatBytes(build.bytes)}</span>
                        </li>
                      ))}
                    </ul>
                  )}
                </li>
              )
            })}
          </ul>

          <div className="flex items-center justify-between gap-3">
            <p className="min-w-0 truncate text-[11px] text-zinc-600" title={usage?.dataRoot}>
              {usage?.dataRoot}
            </p>
            {recalcButton}
          </div>
        </div>
      )}
    </SectionCard>
  )
}
