import { useState } from 'react'
import { HIDDEN_SYNC_COMPONENT_IDS, SYNC_COMPONENT_IDS } from '../../../shared/types'
import type { LauncherApi, PlanInstallRequest, PlanOpResult, SyncOpResult } from '../../../shared/types'
import { groupAddons } from '../../../shared/addon-identity'
import { compareVersionsDesc } from '../../../shared/blender-builds'
import { cleanErrorMessage } from '../lib/format'
import { useTranslation } from '../lib/i18n'

type RunState = 'idle' | 'running' | 'done' | 'error'

function statusClass(status: string): string {
  return status === 'ok' ? 'text-emerald-400' : status === 'skipped' ? 'text-zinc-500' : 'text-red-400'
}

// Offered once, right after the FIRST build of a brand-new major.minor is added
// (Installs.tsx decides that). Settings come from the Sync page's "Source" (null
// hides that half). The add-on set's origin is picked HERE, in a select: the
// default set (add-ons enabled in every version where they are installed — the
// ones whose row checkbox on the Add-ons page is fully on), or one concrete
// version's enabled set. `sourceOptions` = the versions that existed before.
export default function SyncOfferDialog({
  version,
  minor,
  settingsSource,
  sourceOptions,
  api,
  onClose
}: {
  version: string
  minor: string
  settingsSource: string | null
  sourceOptions: string[]
  api: LauncherApi
  onClose: () => void
}) {
  const { t } = useTranslation()
  const [settingsState, setSettingsState] = useState<RunState>('idle')
  const [settingsResults, setSettingsResults] = useState<SyncOpResult[]>([])
  const [settingsError, setSettingsError] = useState<string | null>(null)

  const [addonsState, setAddonsState] = useState<RunState>('idle')
  const [addonsResults, setAddonsResults] = useState<PlanOpResult[]>([])
  const [addonsError, setAddonsError] = useState<string | null>(null)
  const [addonsEmpty, setAddonsEmpty] = useState(false)
  // 'default' — the cross-version default set; otherwise a concrete source minor
  const [addonsFrom, setAddonsFrom] = useState('default')

  const syncSettings = async (): Promise<void> => {
    if (!settingsSource) return
    setSettingsState('running')
    setSettingsError(null)
    try {
      const components = SYNC_COMPONENT_IDS.filter((id) => !HIDDEN_SYNC_COMPONENT_IDS.includes(id))
      const outcome = await api.settingsSync.apply({
        sourceMinor: settingsSource,
        targets: [{ minor, components: [...components] }]
      })
      setSettingsResults(outcome.results)
      setSettingsState('done')
    } catch (error) {
      setSettingsError(cleanErrorMessage(error))
      setSettingsState('error')
    }
  }

  // each carried add-on is a (module, sourceMinor) pair — the version whose installed copy
  // gets packed and installed into the new minor (same carry mechanism as the matrix ticks)
  const collectCarries = (cache: Awaited<ReturnType<LauncherApi['addons']['scan']>>): { module: string; sourceMinor: string }[] => {
    if (addonsFrom !== 'default') {
      const sourceEntry = cache.find((entry) => entry.minor === addonsFrom)
      return (sourceEntry?.addons ?? [])
        .filter((addon) => addon.enabled && (addon.origin === 'user' || addon.origin === 'extension'))
        .map((addon) => ({ module: addon.module, sourceMinor: addonsFrom }))
    }
    // default set: add-ons enabled in EVERY version where a user/extension copy is
    // installed (= the Add-ons page row checkbox is fully on), carried from the
    // newest enabled copy; the brand-new minor itself does not count
    const carries: { module: string; sourceMinor: string }[] = []
    for (const row of groupAddons(cache)) {
      const cells = [...row.perMinor.entries()].filter(
        ([cellMinor, addon]) =>
          cellMinor !== minor &&
          !addon.missing &&
          (addon.origin === 'user' || addon.origin === 'extension')
      )
      if (cells.length === 0 || !cells.every(([, addon]) => addon.enabled)) continue
      const [newestMinor, newest] = cells.sort((a, b) => compareVersionsDesc(a[0], b[0]))[0]
      carries.push({ module: newest.module, sourceMinor: newestMinor })
    }
    return carries
  }

  const syncAddons = async (): Promise<void> => {
    setAddonsState('running')
    setAddonsError(null)
    try {
      const cache = (await api.addons.getCached()) ?? (await api.addons.scan())
      const carries = collectCarries(cache)
      if (carries.length === 0) {
        setAddonsEmpty(true)
        setAddonsState('done')
        return
      }
      const installs: PlanInstallRequest[] = carries.map((carry) => ({
        minor,
        kind: 'backup',
        id: `${carry.module}@${carry.sourceMinor}`,
        module: carry.module,
        sourceMinor: carry.sourceMinor
      }))
      const outcome = await api.addons.applyPlan({ installs, uninstalls: [], enable: [], disable: [] })
      setAddonsResults(outcome.results)
      setAddonsState('done')
    } catch (error) {
      setAddonsError(cleanErrorMessage(error))
      setAddonsState('error')
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div
        className="w-full max-w-md rounded-xl border border-white/10 bg-surface-dialog p-5 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 className="text-base font-semibold text-zinc-100">{t('syncOffer.title', { version })}</h2>
        <p className="mt-1 text-xs leading-relaxed text-zinc-500">{t('syncOffer.message')}</p>

        <div className="mt-4 space-y-3">
          {settingsSource && (
          <div className="rounded-lg border border-white/10 p-3">
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm text-zinc-200">{t('syncOffer.settings')}</p>
              <button
                onClick={syncSettings}
                disabled={settingsState === 'running' || settingsState === 'done'}
                className="shrink-0 rounded-lg border border-blender/40 px-3 py-1 text-xs font-medium text-blender transition-colors hover:bg-blender/10 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {settingsState === 'running'
                  ? t('syncOffer.syncing')
                  : settingsState === 'done'
                    ? t('syncOffer.synced')
                    : t('syncOffer.syncSettings')}
              </button>
            </div>
            <p className="mt-1 text-[11px] text-zinc-500">{t('syncOffer.settingsHint', { source: settingsSource })}</p>
            {settingsError && <p className="mt-1 text-xs text-red-400">{settingsError}</p>}
            {settingsResults.length > 0 && (
              <ul className="mt-1 space-y-0.5">
                {settingsResults.map((result) => (
                  <li key={result.component} className={`text-[11px] ${statusClass(result.status)}`}>
                    {result.component}: {result.detail ?? result.status}
                  </li>
                ))}
              </ul>
            )}
          </div>
          )}

          {sourceOptions.length > 0 && (
          <div className="rounded-lg border border-white/10 p-3">
            <div className="flex items-center justify-between gap-3">
              <p className="text-sm text-zinc-200">{t('syncOffer.addons')}</p>
              <button
                onClick={syncAddons}
                disabled={addonsState === 'running' || addonsState === 'done'}
                className="shrink-0 rounded-lg border border-blender/40 px-3 py-1 text-xs font-medium text-blender transition-colors hover:bg-blender/10 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {addonsState === 'running'
                  ? t('syncOffer.copying')
                  : addonsState === 'done'
                    ? t('syncOffer.copied')
                    : t('syncOffer.syncAddons')}
              </button>
            </div>
            <label className="mt-2 flex items-center gap-2 text-[11px] text-zinc-500">
              {t('syncOffer.fromLabel')}
              <select
                value={addonsFrom}
                onChange={(event) => setAddonsFrom(event.target.value)}
                disabled={addonsState === 'running' || addonsState === 'done'}
                className="min-w-0 flex-1 rounded-lg border border-white/10 bg-surface-input px-2 py-1 text-xs text-zinc-200 focus:border-blender/50 focus:outline-none disabled:opacity-50"
              >
                <option value="default">{t('syncOffer.fromDefault')}</option>
                {sourceOptions.map((option) => (
                  <option key={option} value={option}>
                    {t('syncOffer.fromVersion', { minor: option })}
                  </option>
                ))}
              </select>
            </label>
            <p className="mt-1.5 text-[11px] text-zinc-500">
              {addonsFrom === 'default'
                ? t('syncOffer.addonsHintDefault')
                : t('syncOffer.addonsHint', { source: addonsFrom })}
            </p>
            {addonsError && <p className="mt-1 text-xs text-red-400">{addonsError}</p>}
            {addonsEmpty && <p className="mt-1 text-[11px] text-zinc-500">{t('syncOffer.nothingToCopy')}</p>}
            {addonsResults.length > 0 && (
              <ul className="mt-1 max-h-32 space-y-0.5 overflow-y-auto">
                {addonsResults.map((result, index) => (
                  <li key={`${result.id}-${index}`} className={`text-[11px] ${statusClass(result.status)}`}>
                    {result.id}: {result.detail ?? result.status}
                  </li>
                ))}
              </ul>
            )}
          </div>
          )}
        </div>

        <div className="mt-4 flex justify-end">
          <button
            onClick={onClose}
            className="rounded-lg border border-white/10 px-4 py-1.5 text-sm text-zinc-300 transition-colors hover:bg-white/10"
          >
            {settingsState === 'done' || addonsState === 'done' ? t('common.done') : t('syncOffer.notNow')}
          </button>
        </div>
      </div>
    </div>
  )
}
