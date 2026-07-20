import { formatBytes } from '../../lib/format'
import { useTranslation } from '../../lib/i18n'
import type { InstallProgress } from '../../../../shared/types'
import { CYCLE_STYLES, LONGEST_CYCLE } from './constants'

export function CycleBadge({ cycle }: { cycle: string }) {
  return (
    <span
      className={`grid shrink-0 rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
        CYCLE_STYLES[cycle] ?? 'bg-white/10 text-zinc-400'
      }`}
    >
      <span className="invisible col-start-1 row-start-1">{LONGEST_CYCLE}</span>
      <span className="col-start-1 row-start-1 text-center">{cycle}</span>
    </span>
  )
}
// Two things move this label between rows: the digit count and the singular /
// plural form. Both worst cases ride along invisibly (with tabular figures, so
// any two-digit sample stands in for every count of that length), keeping the
// chip one width down the list; a three-digit count simply widens it a little.
export function ProjectCountLabel({ count }: { count: number }) {
  const { t } = useTranslation()
  const sample = 88
  return (
    <span className="grid tabular-nums">
      <span className="invisible col-start-1 row-start-1">
        {t('installs.projectCountOne', { count: sample })}
      </span>
      <span className="invisible col-start-1 row-start-1">
        {t('installs.projectCountMany', { count: sample })}
      </span>
      <span className="col-start-1 row-start-1 text-center">
        {t(count === 1 ? 'installs.projectCountOne' : 'installs.projectCountMany', { count })}
      </span>
    </span>
  )
}
// Install and Launch never share a row, but they sit in the same column down the
// list. Both labels ride along invisibly in the same grid cell, so every button
// is exactly as wide as the longer of the two — even width, no padding to spare,
// and it follows the active locale instead of a hardcoded minimum.
export function ActionLabel({ children }: { children: string }) {
  const { t } = useTranslation()
  return (
    <span className="grid">
      <span className="invisible col-start-1 row-start-1">{t('common.install')}</span>
      <span className="invisible col-start-1 row-start-1">{t('installs.launch')}</span>
      <span className="col-start-1 row-start-1">{children}</span>
    </span>
  )
}
export function ProgressLine({ progress }: { progress: InstallProgress }) {
  const { t } = useTranslation()
  if (progress.phase === 'error') {
    return (
      <p className="truncate text-xs text-red-400" title={progress.error}>
        {progress.error}
      </p>
    )
  }
  if (progress.phase === 'done') {
    return (
      <p className="text-xs font-medium text-emerald-400">
        {t('installs.installedDone')}
        {progress.replaced && progress.replaced.length > 0 && (
          <span className="ml-1 font-normal text-zinc-500">
            {t(
              progress.replaced.length > 1
                ? 'installs.replacedPreviousBuilds'
                : 'installs.replacedPreviousBuild',
              {
                builds: progress.replaced
                  .map((build) => build.commit?.slice(0, 10) || build.version)
                  .join(', ')
              }
            )}
          </span>
        )}
      </p>
    )
  }
  const percent =
    progress.phase === 'downloading' && progress.totalBytes
      ? Math.min(100, ((progress.receivedBytes ?? 0) / progress.totalBytes) * 100)
      : null
  const label =
    progress.phase === 'downloading'
      ? t('installs.downloading', {
          received: formatBytes(progress.receivedBytes ?? 0),
          total: formatBytes(progress.totalBytes ?? 0)
        })
      : progress.phase === 'verifying'
        ? t('installs.verifyingChecksum')
        : progress.phase === 'extracting'
          ? t('installs.extracting')
          : progress.phase === 'removing'
            ? t('installs.removing')
            : t('installs.finalizing')
  // one line, label beside the bar: stacking them put the bar above the row's
  // centre line (off from the buttons next to it) and made the row grow mid-install
  return (
    <div className="flex items-center gap-3">
      <div className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-white/10">
        <div
          className={`h-full rounded-full bg-blender transition-[width] duration-200 ${percent === null ? 'w-full animate-pulse' : ''}`}
          style={percent !== null ? { width: `${percent}%` } : undefined}
        />
      </div>
      <p className="shrink-0 text-[11px] text-zinc-500">{label}</p>
    </div>
  )
}
