import { useTranslation } from '../../lib/i18n'
import type { AddonInfo } from '../../../../shared/types'

export function StatusCell({
  addon,
  versionError,
  pending,
  disabled,
  onToggle,
  absentHint,
  replaced
}: {
  addon: AddonInfo | undefined
  versionError?: string
  pending: boolean | undefined
  disabled: boolean
  onToggle: () => void
  /** why the cell is a dash — the reason nothing can be installed here */
  absentHint?: string
  /** a different version is staged to install in this column → this copy will be removed first */
  replaced?: boolean
}) {
  const { t } = useTranslation()
  if (versionError) {
    return (
      <span className="text-xs text-amber-500" title={t('addons.cellReadError', { error: versionError })}>
        ?
      </span>
    )
  }
  if (!addon) {
    return (
      <span className="text-zinc-700" title={absentHint ?? t('addons.cellNotInstalled')}>
        –
      </span>
    )
  }
  if (addon.missing) {
    if (!addon.enabled) {
      return (
        <span className="text-zinc-700" title={t('addons.cellDanglingDisabled')}>
          –
        </span>
      )
    }
    const willDisable = pending !== undefined && pending !== addon.enabled
    return (
      <button
        onClick={onToggle}
        disabled={disabled}
        title={
          willDisable
            ? t('addons.cellDanglingWillRemove', { module: addon.module })
            : t('addons.cellDanglingEnabled', { module: addon.module })
        }
        className="rounded p-1 text-xs font-semibold transition-colors hover:bg-white/10 disabled:cursor-default disabled:hover:bg-transparent"
      >
        {willDisable ? (
          <span className="inline-block h-2.5 w-2.5 rounded-full border-2 border-amber-400" />
        ) : (
          <span className="text-amber-500">!</span>
        )}
      </button>
    )
  }
  const version = addon.version ? ` · v${addon.version}` : ''
  if (addon.origin === 'core') {
    // baked into Blender as always-on core — present, but nothing to toggle (not a dash)
    return (
      <span
        className="inline-flex items-center justify-center"
        title={t('addons.cellCore', { module: addon.module })}
      >
        <svg viewBox="0 0 20 20" className="h-3.5 w-3.5" fill="none" aria-hidden="true">
          <circle cx="10" cy="10" r="9" fill="#22c55e" />
          <path
            d="M6 10.4l2.6 2.6L14 7.6"
            stroke="white"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>
    )
  }
  if (replaced) {
    // another version was ticked to install in this column — this copy gets uninstalled first. It's a
    // pending change, so mark it amber like a pending disable: a hollow amber ring, not the solid
    // "enabled" dot. Click cancels the switch.
    return (
      <button
        onClick={onToggle}
        disabled={disabled}
        title={t('addons.cellReplaced', { version, module: addon.module })}
        className="rounded p-1 transition-colors hover:bg-white/10 disabled:cursor-default disabled:hover:bg-transparent"
      >
        <span className="inline-block h-2.5 w-2.5 rounded-full border-2 border-amber-400" />
      </button>
    )
  }
  const changed = pending !== undefined && pending !== addon.enabled
  const dot = changed ? (
    pending ? (
      <span className="inline-block h-2.5 w-2.5 rounded-full bg-amber-400" />
    ) : (
      <span className="inline-block h-2.5 w-2.5 rounded-full border-2 border-amber-400" />
    )
  ) : addon.enabled ? (
    <span className="inline-block h-2.5 w-2.5 rounded-full bg-blender" />
  ) : (
    <span className="inline-block h-2.5 w-2.5 rounded-full border border-zinc-600" />
  )
  const state = changed
    ? pending
      ? t('addons.cellWillEnable')
      : t('addons.cellWillDisable')
    : addon.enabled
      ? t('addons.cellEnabled')
      : t('addons.cellDisabled')
  return (
    <button
      onClick={onToggle}
      disabled={disabled}
      title={`${state}${version}\n${addon.module}`}
      className="rounded p-1 transition-colors hover:bg-white/10 disabled:cursor-default disabled:hover:bg-transparent"
    >
      {dot}
    </button>
  )
}

// a square (vs the round enable/disable dots) — not installed here, but installable on Apply
export function InstallCell({
  staged,
  disabled,
  onToggle,
  hint,
  warn
}: {
  staged: boolean
  disabled: boolean
  onToggle: () => void
  /** extra line appended to the tooltip, e.g. the unsupported-carry warning */
  hint?: string
  /** support for this Blender version is not declared — tint the square reddish */
  warn?: boolean
}) {
  const { t } = useTranslation()
  const base = staged ? t('addons.installStaged') : t('addons.installTick')
  const square = staged
    ? warn
      ? 'bg-red-400'
      : 'bg-amber-400'
    : warn
      ? 'border border-dashed border-red-500/60'
      : 'border border-dashed border-zinc-600'
  return (
    <button
      onClick={onToggle}
      disabled={disabled}
      title={hint ? `${base}\n${hint}` : base}
      className="rounded p-1 transition-colors hover:bg-white/10 disabled:cursor-default disabled:hover:bg-transparent"
    >
      <span className={`inline-block h-2.5 w-2.5 rounded-sm ${square}`} />
    </button>
  )
}
