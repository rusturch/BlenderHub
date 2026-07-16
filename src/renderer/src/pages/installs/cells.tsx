import { formatBytes } from '../../lib/format'
import { useTranslation } from '../../lib/i18n'
import type { InstallProgress } from '../../../../shared/types'
import { CYCLE_STYLES } from './constants'

export function CycleBadge({ cycle }: { cycle: string }) {
  return (
    <span
      className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
        CYCLE_STYLES[cycle] ?? 'bg-white/10 text-zinc-400'
      }`}
    >
      {cycle}
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
          : t('installs.finalizing')
  return (
    <div>
      <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/10">
        <div
          className={`h-full rounded-full bg-blender transition-[width] duration-200 ${percent === null ? 'w-full animate-pulse' : ''}`}
          style={percent !== null ? { width: `${percent}%` } : undefined}
        />
      </div>
      <p className="mt-1 text-[11px] text-zinc-500">{label}</p>
    </div>
  )
}
