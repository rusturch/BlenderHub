import { useEffect, useRef, useState } from 'react'
import type { LauncherApi, RunningBlender } from '../../../shared/types'
import { useTranslation } from '../lib/i18n'

// Shown when an Apply/Uninstall/Restore touches Blender versions that are running
// right now: a running Blender re-saves its in-memory preferences on any prefs change,
// silently overwriting whatever the launcher's headless run wrote (uninstalled add-ons
// come back as ghost "missing" entries). The gate re-checks every couple of seconds and
// proceeds by itself once the affected versions exit. Closing is REQUESTED via the OS
// close signal, never forced — Blender itself prompts about unsaved files.
export default function RunningBlenderGate({
  api,
  minors,
  initial,
  onProceed,
  onCancel
}: {
  api: LauncherApi
  minors: string[]
  initial: RunningBlender[]
  /** called once the affected versions are closed — or by the explicit override */
  onProceed: () => void
  onCancel: () => void
}) {
  const { t } = useTranslation()
  const [running, setRunning] = useState<RunningBlender[]>(initial)
  const [closeRequested, setCloseRequested] = useState(false)
  // in-flight guard only — the button stays clickable afterwards, so a window whose
  // close the user cancelled inside Blender can be asked again
  const [closing, setClosing] = useState(false)
  // proceed/cancel land in refs so the poll interval never captures stale closures
  const onProceedRef = useRef(onProceed)
  onProceedRef.current = onProceed
  const decidedRef = useRef(false)

  useEffect(() => {
    let checking = false
    const check = async (): Promise<void> => {
      if (checking || decidedRef.current) return
      checking = true
      try {
        const fresh = await api.builds.listRunning(minors)
        if (decidedRef.current) return
        if (fresh.length === 0) {
          decidedRef.current = true
          onProceedRef.current()
          return
        }
        setRunning(fresh)
      } catch {
        // detection hiccup — keep the last known list, try again on the next tick
      } finally {
        checking = false
      }
    }
    const id = window.setInterval(() => void check(), 2000)
    return () => window.clearInterval(id)
    // minors are fixed for the dialog's lifetime (a new gate gets a new mount)
  }, [api.builds, minors])

  // one shot closes everything: main raises all windows into a stack and asks each to
  // close — the user deals with the top one, the next is already right beneath it
  const askToClose = async (): Promise<void> => {
    setCloseRequested(true)
    setClosing(true)
    try {
      await api.builds.requestClose(minors)
    } catch {
      // the poll keeps showing the real state either way
    } finally {
      setClosing(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onCancel}>
      <div
        className="w-full max-w-md rounded-xl border border-white/10 bg-surface-dialog p-5 shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <h2 className="text-base font-semibold text-zinc-100">{t('runningGate.title')}</h2>
        <p className="mt-1 text-xs leading-relaxed text-zinc-500">{t('runningGate.message')}</p>

        <ul className="mt-3 space-y-1 rounded-lg border border-white/10 p-3">
          {running.map((entry) => (
            <li key={entry.minor} className="flex items-center gap-2 text-sm text-zinc-200">
              <span className="inline-block h-2 w-2 animate-pulse rounded-full bg-amber-400" />
              Blender {entry.minor}
              {entry.count > 1 && (
                <span className="text-xs text-zinc-500">{t('runningGate.windowsCount', { count: entry.count })}</span>
              )}
            </li>
          ))}
        </ul>

        <p className="mt-2 text-[11px] text-zinc-600">
          {closeRequested ? t('runningGate.closeRequested') : t('runningGate.autoCheck')}
        </p>

        <div className="mt-4 flex items-center justify-between gap-2">
          <button
            onClick={() => {
              decidedRef.current = true
              onProceed()
            }}
            title={t('runningGate.proceedAnywayHint')}
            className="rounded-lg px-2 py-1.5 text-xs text-zinc-600 transition-colors hover:text-red-400"
          >
            {t('runningGate.proceedAnyway')}
          </button>
          <div className="flex items-center gap-2">
            <button
              onClick={onCancel}
              className="rounded-lg border border-white/10 px-4 py-1.5 text-sm text-zinc-300 transition-colors hover:bg-white/5"
            >
              {t('common.cancel')}
            </button>
            <button
              onClick={() => void askToClose()}
              disabled={closing}
              title={t('runningGate.askCloseHint')}
              className="rounded-lg bg-blender px-4 py-1.5 text-sm font-medium text-on-accent transition-colors hover:bg-blender/90 disabled:opacity-50"
            >
              {t('runningGate.askClose')}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
