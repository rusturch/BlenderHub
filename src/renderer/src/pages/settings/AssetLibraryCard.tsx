import { useCallback, useEffect, useState } from 'react'
import { useDialog } from '../../components/Dialog'
import RunningBlenderGate from '../../components/RunningBlenderGate'
import { useTranslation } from '../../lib/i18n'
import { cleanErrorMessage } from '../../lib/format'
import { getLauncherApi } from '../../lib/preview-fallback'
import { uiGet, uiSet } from '../../lib/ui-store'
import { ASSET_LIBRARY_KEY, assetLibraryEnabled } from '../../../../shared/asset-library'
import type {
  AssetLibraryInfo,
  AssetLibraryProgress,
  AssetLibraryVersionStatus,
  RunningBlender
} from '../../../../shared/types'
import { SectionCard } from './cells'
import { pathBoxClass, secondaryButtonClass } from './constants'

// statuses phase 2 would write to — the running-Blender gate asks about exactly
// these ('running' included: those bases still need the write once Blender closes)
const NEEDS_WRITE: AssetLibraryVersionStatus['status'][] = [
  'unregistered',
  'stale',
  'user-removed',
  'running',
  'error'
]
// statuses that may still carry our entry — what a disable-with-removal touches
const CARRIES_ENTRY: AssetLibraryVersionStatus['status'][] = [
  'registered',
  'stale',
  'running',
  'error'
]

const minorsWith = (
  info: AssetLibraryInfo | null,
  statuses: AssetLibraryVersionStatus['status'][]
): string[] => [
  ...new Set(
    (info?.versions ?? [])
      .filter((row) => statuses.includes(row.status))
      .map((row) => row.minor)
  )
]

export function AssetLibraryCard() {
  const { api, isDesktop } = getLauncherApi()
  const { t } = useTranslation()
  const { choose: chooseDialog, alert: alertDialog } = useDialog()
  const desktopOnlyTitle = isDesktop ? undefined : t('settings.desktopOnlyHint')

  // the key is read by the main process (main/asset-library/service.ts) —
  // shared/asset-library.ts holds the literal
  const [enabled, setEnabled] = useState(() => assetLibraryEnabled(uiGet(ASSET_LIBRARY_KEY)))
  const [info, setInfo] = useState<AssetLibraryInfo | null>(null)
  const [busy, setBusy] = useState<'register' | 'unregister' | null>(null)
  const [flowBusy, setFlowBusy] = useState(false)
  const [progress, setProgress] = useState<AssetLibraryProgress | null>(null)
  const [howToOpen, setHowToOpen] = useState(false)
  const [gate, setGate] = useState<{
    minors: string[]
    initial: RunningBlender[]
    resume: () => void
  } | null>(null)

  useEffect(() => {
    if (!isDesktop) return
    api.assetLibrary.status().then(setInfo, () => {})
  }, [api, isDesktop])

  useEffect(() => api.assetLibrary.onProgress(setProgress), [api])

  const gateOnRunning = useCallback(
    async (minors: string[], run: () => Promise<void>) => {
      let found: RunningBlender[] = []
      if (minors.length > 0) {
        try {
          found = await api.builds.listRunning(minors)
        } catch {
          // detection failed — proceed; main still skips running bases itself
        }
      }
      if (found.length > 0) setGate({ minors, initial: found, resume: () => void run() })
      else await run()
    },
    [api]
  )

  const runReconcile = useCallback(async () => {
    setBusy('register')
    setProgress(null)
    try {
      setInfo(await api.assetLibrary.reconcile())
    } catch (error) {
      await alertDialog(cleanErrorMessage(error))
    } finally {
      setBusy(null)
      setProgress(null)
    }
  }, [api, alertDialog])

  const enable = useCallback(async () => {
    // flowBusy covers the whole flow, including the async gap before busy is set —
    // a double-click must not race enable against disable
    setFlowBusy(true)
    try {
      setEnabled(true)
      uiSet(ASSET_LIBRARY_KEY, 'on')
      const snapshot = (await api.assetLibrary.status().catch(() => null)) ?? info
      if (snapshot) setInfo(snapshot)
      await gateOnRunning(minorsWith(snapshot, NEEDS_WRITE), runReconcile)
    } finally {
      setFlowBusy(false)
    }
  }, [api, info, gateOnRunning, runReconcile])

  const disable = useCallback(async () => {
    setFlowBusy(true)
    try {
      const choice = await chooseDialog({
        title: t('settings.assetLibraryDisableTitle'),
        message: t('settings.assetLibraryDisableMessage'),
        variant: 'warning',
        buttons: [
          { id: 'cancel', label: t('common.cancel') },
          { id: 'keep', label: t('settings.assetLibraryDisableKeep'), kind: 'secondary' },
          { id: 'remove', label: t('settings.assetLibraryDisableRemove'), kind: 'primary' }
        ]
      })
      if (choice !== 'keep' && choice !== 'remove') return
      setEnabled(false)
      uiSet(ASSET_LIBRARY_KEY, 'off')
      if (choice !== 'remove') return
      // a fresh snapshot, not the mount-time one — the gate must know the truth
      // about which minors still carry the entry
      const snapshot = (await api.assetLibrary.status().catch(() => null)) ?? info
      if (snapshot) setInfo(snapshot)
      await gateOnRunning(minorsWith(snapshot, CARRIES_ENTRY), async () => {
        setBusy('unregister')
        setProgress(null)
        try {
          const after = await api.assetLibrary.unregister()
          setInfo(after)
          // leftovers (Blender still open, a failed write) would otherwise vanish
          // silently — the card hides its status area once the toggle is off
          const leftover = after.versions.filter(
            (row) => row.status === 'running' || row.status === 'error'
          )
          if (leftover.length > 0) {
            await alertDialog(
              t('settings.assetLibraryRemoveLeftover', {
                versions: leftover.map((row) => row.version).join(', ')
              })
            )
          }
        } catch (error) {
          await alertDialog(cleanErrorMessage(error))
        } finally {
          setBusy(null)
          setProgress(null)
        }
      })
    } finally {
      setFlowBusy(false)
    }
  }, [api, info, chooseDialog, alertDialog, gateOnRunning, t])

  const openDir = useCallback(() => {
    api.assetLibrary.openDir().catch(() => {})
  }, [api])

  const rowText = (row: AssetLibraryVersionStatus): string => {
    switch (row.status) {
      case 'stale':
        return t('settings.assetLibraryRowStale')
      case 'unregistered':
        return t('settings.assetLibraryRowUnregistered')
      case 'user-removed':
        return t('settings.assetLibraryRowUserRemoved')
      case 'running':
        return t('settings.assetLibraryRowRunning')
      case 'no-userpref':
        return t('settings.assetLibraryRowNoUserpref')
      case 'unsupported':
        return t('settings.assetLibraryRowUnsupported')
      case 'error':
        return t('settings.assetLibraryRowError', { error: row.error ?? '' })
      default:
        return ''
    }
  }

  const versions = info?.versions ?? []
  // versions below 3.0 cannot have the library at all — they never count against "all"
  const relevant = versions.filter((row) => row.status !== 'unsupported')
  const registeredCount = relevant.filter((row) => row.status === 'registered').length
  const problems = versions.filter((row) => row.status !== 'registered')
  const allOk = relevant.length > 0 && registeredCount === relevant.length

  return (
    <SectionCard title={t('settings.assetLibrary')} hint={t('settings.assetLibraryHint')}>
      <div className="flex flex-col gap-3">
        <label
          title={desktopOnlyTitle}
          className={`flex items-center gap-1.5 self-start text-xs text-zinc-300 transition-colors ${
            isDesktop && busy === null && !flowBusy ? 'cursor-pointer hover:text-zinc-100' : 'cursor-not-allowed'
          }`}
        >
          <input
            type="checkbox"
            checked={enabled}
            onChange={() => (enabled ? void disable() : void enable())}
            disabled={!isDesktop || busy !== null || flowBusy}
            className="accent-blender disabled:cursor-not-allowed"
          />
          {t('settings.assetLibraryEnable')}
        </label>

        <div className="flex items-center gap-2">
          <p className={pathBoxClass} title={info?.dir}>
            {info?.dir || '—'}
          </p>
          <button
            onClick={openDir}
            disabled={!isDesktop}
            title={desktopOnlyTitle}
            className={`${secondaryButtonClass} disabled:cursor-not-allowed disabled:opacity-40`}
          >
            {t('settings.openFolder')}
          </button>
        </div>

        {busy !== null ? (
          <p className="text-xs text-zinc-400">
            {progress && progress.total > 0
              ? t(
                  busy === 'register'
                    ? 'settings.assetLibraryRegistering'
                    : 'settings.assetLibraryUnregistering',
                  { done: String(progress.done), total: String(progress.total) }
                )
              : t('settings.assetLibraryWorking')}
          </p>
        ) : enabled && info ? (
          relevant.length === 0 ? (
            <p className="text-xs text-zinc-500">{t('settings.assetLibraryNoVersions')}</p>
          ) : allOk ? (
            <p className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-400">
              <span className="h-2 w-2 rounded-full bg-emerald-400" />
              {t('settings.assetLibraryRegisteredAll', { count: String(relevant.length) })}
            </p>
          ) : (
            <div className="flex flex-col gap-1.5">
              <div className="flex flex-wrap items-center gap-2">
                <span className="inline-flex items-center gap-1.5 text-xs font-medium text-amber-400">
                  <span className="h-2 w-2 rounded-full bg-amber-400" />
                  {t('settings.assetLibraryRegisteredPartial', {
                    done: String(registeredCount),
                    total: String(relevant.length)
                  })}
                </span>
                <button
                  onClick={() => void gateOnRunning(minorsWith(info, NEEDS_WRITE), runReconcile)}
                  className={secondaryButtonClass}
                >
                  {t('settings.assetLibraryFix')}
                </button>
              </div>
              <ul className="flex flex-col gap-0.5">
                {problems.map((row, index) => (
                  <li key={`${row.minor}-${index}`} className="text-[11px] text-zinc-500">
                    {row.version}
                    {row.portable ? ` ${t('settings.assetLibraryPortable')}` : ''} — {rowText(row)}
                  </li>
                ))}
              </ul>
            </div>
          )
        ) : null}

        <button
          onClick={() => setHowToOpen((open) => !open)}
          className="self-start text-[11px] text-zinc-500 underline transition-colors hover:text-zinc-300"
        >
          {t('settings.assetLibraryHowTo')}
        </button>
        {howToOpen && (
          <p className="whitespace-pre-line text-[11px] leading-relaxed text-zinc-500">
            {t('settings.assetLibraryHowToText')}
          </p>
        )}
      </div>
      {gate && (
        <RunningBlenderGate
          api={api}
          minors={gate.minors}
          initial={gate.initial}
          onProceed={() => {
            const resume = gate.resume
            setGate(null)
            resume()
          }}
          onCancel={() => setGate(null)}
        />
      )}
    </SectionCard>
  )
}
