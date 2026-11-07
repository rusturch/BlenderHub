import { useCallback, useEffect, useRef, useState } from 'react'
import { useDialog } from '../../components/Dialog'
import { useTranslation } from '../../lib/i18n'
import { cleanErrorMessage, formatBytes } from '../../lib/format'
import { getLauncherApi } from '../../lib/preview-fallback'
import { uiGet, uiSet } from '../../lib/ui-store'
import { CLOUD_ENABLED_UI_KEY } from '../../../../shared/cloud-sync'
import type { CloudSyncStatus } from '../../../../shared/types'
import { SectionCard } from './cells'
import { secondaryButtonClass } from './constants'

const EMPTY_STATUS: CloudSyncStatus = {
  connected: false,
  available: true,
  enabled: false,
  account: null,
  usage: null,
  syncing: false,
  lastSyncAt: null,
  lastError: null,
  firstLinkPending: false,
  connecting: false,
  dataFolderCloudHint: null
}

const cloudEnabled = (): boolean => uiGet(CLOUD_ENABLED_UI_KEY) === 'on'

export function CloudSyncCard({ anchorId, highlighted }: { anchorId?: string; highlighted?: boolean }) {
  const { api, isDesktop } = getLauncherApi()
  const cloud = api.cloudSync
  const { t } = useTranslation()
  const { confirm: confirmDialog, alert: alertDialog } = useDialog()

  const [status, setStatus] = useState<CloudSyncStatus>(EMPTY_STATUS)
  const [enabled, setEnabled] = useState(cloudEnabled)
  const [busy, setBusy] = useState(false)
  const [pending, setPending] = useState(false)
  const pendingRef = useRef(false)

  useEffect(() => {
    let alive = true
    cloud.status().then((next) => alive && setStatus(next))
    const off = cloud.onStateChanged((next) => {
      if (!alive) return
      setStatus(next)
      // main may have flipped the toggle (auto-enable on connect, off on delete) — re-read it
      setEnabled(cloudEnabled())
      // sign-in finished (connected) or the attempt ended (session gone) →
      // leave the local "waiting for the browser" UI
      if (pendingRef.current && (next.connected || !next.connecting)) {
        setPending(false)
        pendingRef.current = false
      }
    })
    return () => {
      alive = false
      off()
    }
  }, [cloud])

  const toggleEnabled = useCallback(() => {
    const next = !enabled
    setEnabled(next)
    uiSet(CLOUD_ENABLED_UI_KEY, next ? 'on' : 'off')
  }, [enabled])

  const connect = useCallback(async () => {
    setBusy(true)
    try {
      // main opens the Google consent page in the system browser itself
      await cloud.connectStart()
      setPending(true)
      pendingRef.current = true
    } catch (error) {
      await alertDialog(cleanErrorMessage(error))
    } finally {
      setBusy(false)
    }
  }, [cloud, alertDialog])

  const cancelConnect = useCallback(async () => {
    await cloud.connectCancel().catch(() => {})
    setPending(false)
    pendingRef.current = false
  }, [cloud])

  const disconnect = useCallback(async () => {
    const ok = await confirmDialog({
      title: t('settings.cloudDisconnectTitle'),
      message: t('settings.cloudDisconnectMessage'),
      confirmLabel: t('settings.cloudDisconnect')
    })
    if (!ok) return
    setBusy(true)
    try {
      setStatus(await cloud.disconnect(false))
    } catch (error) {
      await alertDialog(cleanErrorMessage(error))
    } finally {
      setBusy(false)
    }
  }, [cloud, confirmDialog, alertDialog, t])

  const syncNow = useCallback(async () => {
    setBusy(true)
    try {
      setStatus(await cloud.syncNow())
    } finally {
      setBusy(false)
    }
  }, [cloud])

  const refresh = useCallback(async () => {
    setBusy(true)
    try {
      setStatus(await cloud.refreshAccount())
    } finally {
      setBusy(false)
    }
  }, [cloud])

  const resolveFirstLink = useCallback(
    async (choice: 'cloud' | 'local') => {
      setBusy(true)
      try {
        setStatus(await cloud.resolveFirstLink(choice))
      } catch (error) {
        await alertDialog(cleanErrorMessage(error))
      } finally {
        setBusy(false)
      }
    },
    [cloud, alertDialog]
  )

  const deleteData = useCallback(async () => {
    const ok = await confirmDialog({
      title: t('settings.cloudDeleteTitle'),
      message: t('settings.cloudDeleteMessage'),
      variant: 'danger',
      tone: 'danger',
      confirmLabel: t('settings.cloudDelete')
    })
    if (!ok) return
    setBusy(true)
    try {
      setStatus(await cloud.deleteCloudData())
      await alertDialog(t('settings.cloudDeleteDone'))
    } catch (error) {
      await alertDialog(cleanErrorMessage(error))
    } finally {
      setBusy(false)
    }
  }, [cloud, confirmDialog, alertDialog, t])

  const usage = status.usage

  return (
    <SectionCard
      title={t('settings.cloudSync')}
      hint={t('settings.cloudSyncHint')}
      anchorId={anchorId}
      highlighted={highlighted}
    >
      {isDesktop && !status.available ? (
        <p className="text-xs text-amber-400">{t('settings.cloudUnavailable')}</p>
      ) : status.connected ? (
        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
            <span className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-400">
              <span className="h-2 w-2 rounded-full bg-emerald-400" />
              {status.account?.displayName || t('settings.cloudConnected')}
            </span>
            {status.account?.email && <span className="text-xs text-zinc-500">{status.account.email}</span>}
            {status.syncing && <span className="text-xs text-zinc-500">{t('settings.cloudSyncing')}</span>}
          </div>

          {status.firstLinkPending && (
            <div className="flex flex-col gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3">
              <p className="text-xs text-zinc-300">{t('settings.cloudFirstLink')}</p>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  onClick={() => resolveFirstLink('cloud')}
                  disabled={busy}
                  className="rounded-md bg-accent-button px-3 py-1.5 text-xs font-medium text-on-accent transition-colors hover:bg-accent-button-hover disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {t('settings.cloudFirstLinkTakeCloud')}
                </button>
                <button
                  onClick={() => resolveFirstLink('local')}
                  disabled={busy}
                  className={`${secondaryButtonClass} disabled:cursor-not-allowed disabled:opacity-40`}
                >
                  {t('settings.cloudFirstLinkUploadLocal')}
                </button>
              </div>
            </div>
          )}
          {status.lastError && <p className="text-xs text-amber-400">{status.lastError}</p>}

          {usage && (
            <span className="text-[11px] text-zinc-500">
              {t('settings.cloudUsage', { used: formatBytes(usage.usedBytes), count: usage.itemCount })}
            </span>
          )}

          {status.dataFolderCloudHint && (
            <p className="text-[11px] text-zinc-500">
              {t('settings.cloudFolderHint', { provider: status.dataFolderCloudHint })}
            </p>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={syncNow}
              disabled={busy || !isDesktop || status.syncing}
              className={`${secondaryButtonClass} disabled:cursor-not-allowed disabled:opacity-40`}
            >
              {t('settings.cloudSyncNow')}
            </button>
            <button
              onClick={refresh}
              disabled={busy || !isDesktop}
              className={`${secondaryButtonClass} disabled:cursor-not-allowed disabled:opacity-40`}
            >
              {t('settings.cloudCheckStatus')}
            </button>
            <button
              onClick={disconnect}
              disabled={busy || !isDesktop}
              className={`${secondaryButtonClass} disabled:cursor-not-allowed disabled:opacity-40`}
            >
              {t('settings.cloudDisconnect')}
            </button>
            <button
              onClick={deleteData}
              disabled={busy || !isDesktop}
              className="rounded-lg px-3 py-1.5 text-xs font-medium text-red-400 transition-colors hover:bg-red-500/10 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {t('settings.cloudDelete')}
            </button>
          </div>

          {status.lastSyncAt && (
            <span className="text-[11px] text-zinc-600">
              {t('settings.cloudLastSync', { time: new Date(status.lastSyncAt).toLocaleString() })}
            </span>
          )}

          <label
            className={`flex items-center gap-1.5 self-start text-xs text-zinc-300 ${
              isDesktop ? 'cursor-pointer hover:text-zinc-100' : 'cursor-not-allowed'
            }`}
          >
            <input
              type="checkbox"
              checked={enabled}
              onChange={toggleEnabled}
              disabled={!isDesktop}
              className="accent-blender disabled:cursor-not-allowed"
            />
            {t('settings.cloudEnabled')}
          </label>
        </div>
      ) : pending ? (
        <div className="flex flex-col gap-2">
          <p className="text-xs text-zinc-300">{t('settings.cloudWaiting')}</p>
          <div className="flex items-center gap-2">
            <button onClick={() => cloud.openVerification().catch(() => {})} className={secondaryButtonClass}>
              {t('settings.cloudReopen')}
            </button>
            <button onClick={cancelConnect} className={secondaryButtonClass}>
              {t('common.cancel')}
            </button>
          </div>
        </div>
      ) : (
        <div className="flex flex-col gap-2">
          <button
            onClick={connect}
            disabled={!isDesktop || busy}
            className="self-start rounded-lg bg-accent-button px-3 py-1.5 text-xs font-medium text-on-accent transition-colors hover:bg-accent-button-hover disabled:cursor-not-allowed disabled:opacity-40"
          >
            {busy ? '…' : t('settings.cloudConnect')}
          </button>
          {status.lastError && <p className="text-xs text-amber-400">{status.lastError}</p>}
        </div>
      )}
    </SectionCard>
  )
}
