import { useCallback, useEffect, useState } from 'react'
import PageLayout from '../components/PageLayout'
import Dropdown from '../components/Dropdown'
import { useDialog } from '../components/Dialog'
import { useTranslation, AVAILABLE_LANGUAGES, languageLabel } from '../lib/i18n'
import { cleanErrorMessage, formatBytes } from '../lib/format'
import { getLauncherApi } from '../lib/preview-fallback'
import { uiGet, uiSet } from '../lib/ui-store'
import { TRAY_PAGES_KEY, TRAY_PAGE_IDS, parseTrayPages, serializeTrayPages } from '../../../shared/tray-menu'
import {
  AUTOSTART_HIDDEN_KEY,
  AUTOSTART_KEY,
  autostartEnabled,
  autostartHiddenEnabled
} from '../../../shared/autostart'
import type {
  BlendFileInfo,
  Page,
  ProjectFolder,
  StorageUsage,
  SuperhiveStatus,
  UpdateCheckResult,
  UpdateDownloadProgress
} from '../../../shared/types'
import { BehaviorToggle, SectionCard, StorageUsageCard } from './settings/cells'
import { ThemeCard } from './settings/ThemeCard'
import { ChevronDownIcon, XIcon } from './settings/icons'
import { fileNameOf } from './projects/projects-utils'
import { SUPERHIVE_DOCS_URL, pathBoxClass, primaryButtonClass, secondaryButtonClass } from './settings/constants'

export default function SettingsPage({ highlight }: { highlight?: string }) {
  const { api, isDesktop } = getLauncherApi()
  const projectsApi = api.projects
  const buildsApi = api.builds
  const addonsApi = api.addons
  const { language, setLanguage, t } = useTranslation()
  const { confirm: confirmDialog, alert: alertDialog } = useDialog()

  const [folders, setFolders] = useState<ProjectFolder[]>([])
  const [files, setFiles] = useState<BlendFileInfo[]>([])
  const [trackedFiles, setTrackedFiles] = useState<string[]>([])
  const [installsDirPath, setInstallsDirPath] = useState('')
  const [downloadsDirPath, setDownloadsDirPath] = useState('')
  const [libraryDirPath, setLibraryDirPath] = useState('')
  const [libraryDirBusy, setLibraryDirBusy] = useState(false)
  const [superhive, setSuperhive] = useState<SuperhiveStatus>({ connected: false, available: true })
  const [superhiveToken, setSuperhiveToken] = useState('')
  const [superhiveBusy, setSuperhiveBusy] = useState(false)
  const [storage, setStorage] = useState<StorageUsage | null>(null)
  const [storageLoading, setStorageLoading] = useState(false)
  const [updateInfo, setUpdateInfo] = useState<UpdateCheckResult | null>(null)
  const [updateChecking, setUpdateChecking] = useState(false)
  const [updateBusy, setUpdateBusy] = useState(false)
  const [updateProgress, setUpdateProgress] = useState<UpdateDownloadProgress | null>(null)
  const [languageMenuOpen, setLanguageMenuOpen] = useState(false)
  const updatesApi = api.updates
  // keys are read by the main process (main/tray.ts) — keep the literals in sync
  const [closeBehavior, setCloseBehavior] = useState(() =>
    uiGet('window.closeBehavior') === 'quit' ? 'quit' : 'tray'
  )
  const [minimizeBehavior, setMinimizeBehavior] = useState(() =>
    uiGet('window.minimizeBehavior') === 'tray' ? 'tray' : 'taskbar'
  )
  const [trayPages, setTrayPages] = useState<Page[]>(() => parseTrayPages(uiGet(TRAY_PAGES_KEY)))
  // keys are read by the main process (main/autostart.ts) — shared/autostart.ts holds the literals
  const [startupEnabled, setStartupEnabled] = useState(() => autostartEnabled(uiGet(AUTOSTART_KEY)))
  const [startupMinimized, setStartupMinimized] = useState(() =>
    autostartHiddenEnabled(uiGet(AUTOSTART_HIDDEN_KEY))
  )

  const toggleStartupEnabled = useCallback(() => {
    const next = !startupEnabled
    setStartupEnabled(next)
    uiSet(AUTOSTART_KEY, next ? 'on' : 'off')
  }, [startupEnabled])

  const toggleStartupMinimized = useCallback(() => {
    const next = !startupMinimized
    setStartupMinimized(next)
    uiSet(AUTOSTART_HIDDEN_KEY, next ? 'on' : 'off')
  }, [startupMinimized])

  const changeCloseBehavior = useCallback((value: string) => {
    setCloseBehavior(value)
    uiSet('window.closeBehavior', value)
  }, [])

  const changeMinimizeBehavior = useCallback((value: string) => {
    setMinimizeBehavior(value)
    uiSet('window.minimizeBehavior', value)
  }, [])

  const toggleTrayPage = useCallback(
    (page: Page) => {
      const next = TRAY_PAGE_IDS.filter((candidate) =>
        candidate === page ? !trayPages.includes(candidate) : trayPages.includes(candidate)
      )
      setTrayPages(next)
      uiSet(TRAY_PAGES_KEY, serializeTrayPages(next))
    },
    [trayPages]
  )

  const refreshFolders = useCallback(async () => {
    try {
      setFolders(await projectsApi.listFolders())
    } catch {
      // preview mode — list stays empty
    }
  }, [projectsApi])

  const refreshFiles = useCallback(async () => {
    try {
      setFiles(await projectsApi.listFiles())
    } catch {
      // preview mode — list stays empty
    }
  }, [projectsApi])

  const refreshTracked = useCallback(async () => {
    try {
      setTrackedFiles(await projectsApi.listTrackedFiles())
    } catch {
      // preview mode — list stays empty
    }
  }, [projectsApi])

  const refreshStorage = useCallback(async () => {
    setStorageLoading(true)
    try {
      setStorage(await api.storage.usage())
    } catch {
      // preview mode / read error — keep whatever was shown before
    } finally {
      setStorageLoading(false)
    }
  }, [api])

  useEffect(() => {
    refreshFolders()
    refreshFiles()
    refreshTracked()
    ;(async () => {
      try {
        setInstallsDirPath(await buildsApi.getInstallsDir())
        setDownloadsDirPath(await buildsApi.getDownloadsDir())
        setLibraryDirPath(await addonsApi.getLibraryDir())
      } catch {
        // preview mode — paths stay blank
      }
      try {
        setSuperhive(await addonsApi.superhiveStatus())
      } catch {
        // preview mode — leave defaults
      }
    })()
  }, [refreshFolders, refreshFiles, refreshTracked, buildsApi, addonsApi])

  useEffect(() => {
    refreshStorage()
  }, [refreshStorage])

  useEffect(() => {
    if (highlight === 'superhive' || highlight === 'updates') {
      document
        .getElementById(`${highlight}-card`)
        ?.scrollIntoView({ behavior: 'smooth', block: 'center' })
    }
  }, [highlight])

  useEffect(() => {
    updatesApi
      .check()
      .then(setUpdateInfo)
      .catch(() => {
        // preview mode — the section just shows the current state
      })
    return updatesApi.onDownloadProgress((progress) => {
      setUpdateProgress(progress)
      // the download may have been started by a previous mount of this page —
      // resync the buttons when it settles instead of trusting local state
      if (progress.phase === 'ready' || progress.phase === 'error') {
        updatesApi.check().then(setUpdateInfo).catch(() => {})
      }
    })
  }, [updatesApi])

  const checkUpdates = useCallback(async () => {
    setUpdateChecking(true)
    try {
      setUpdateInfo(await updatesApi.check(true))
    } catch (cause) {
      await alertDialog(cleanErrorMessage(cause))
    } finally {
      setUpdateChecking(false)
    }
  }, [updatesApi, alertDialog])

  const downloadUpdate = useCallback(async () => {
    setUpdateBusy(true)
    try {
      setUpdateInfo(await updatesApi.download())
    } catch (cause) {
      await alertDialog(cleanErrorMessage(cause))
    } finally {
      setUpdateBusy(false)
      setUpdateProgress(null)
    }
  }, [updatesApi, alertDialog])

  const installUpdate = useCallback(async () => {
    try {
      await updatesApi.installAndRestart()
    } catch (cause) {
      await alertDialog(cleanErrorMessage(cause))
      // a failed install can invalidate the staged file (main drops it) — resync
      // so the Download button comes back instead of a stuck Restart button
      try {
        setUpdateInfo(await updatesApi.check())
      } catch {
        // keep whatever state we had
      }
    }
  }, [updatesApi, alertDialog])

  const openReleases = useCallback(() => {
    void updatesApi.openReleasePage().catch(() => {})
  }, [updatesApi])

  const connectSuperhive = useCallback(async () => {
    setSuperhiveBusy(true)
    try {
      setSuperhive(await addonsApi.superhiveConnect(superhiveToken))
      setSuperhiveToken('')
    } catch (cause) {
      await alertDialog(cleanErrorMessage(cause))
    } finally {
      setSuperhiveBusy(false)
    }
  }, [addonsApi, superhiveToken, alertDialog])

  const disconnectSuperhive = useCallback(async () => {
    setSuperhiveBusy(true)
    try {
      setSuperhive(await addonsApi.superhiveDisconnect())
    } catch (cause) {
      await alertDialog(cleanErrorMessage(cause))
    } finally {
      setSuperhiveBusy(false)
    }
  }, [addonsApi, alertDialog])

  const addFolder = useCallback(async () => {
    try {
      setFolders(await projectsApi.addFolder())
      await refreshFiles()
    } catch (cause) {
      await alertDialog(cleanErrorMessage(cause))
    }
  }, [projectsApi, refreshFiles, alertDialog])

  const addTrackedFile = useCallback(async () => {
    try {
      const added = await projectsApi.addFile()
      if (added === null) return // dialog cancelled
      await refreshTracked()
      await refreshFiles()
    } catch (cause) {
      await alertDialog(cleanErrorMessage(cause))
    }
  }, [projectsApi, refreshTracked, refreshFiles, alertDialog])

  const removeFolder = useCallback(
    async (folder: ProjectFolder) => {
      try {
        setFolders(await projectsApi.removeFolder(folder.path))
        await refreshFiles()
      } catch (cause) {
        await alertDialog(cleanErrorMessage(cause))
      }
    },
    [projectsApi, refreshFiles, alertDialog]
  )

  const missingFiles = files.filter((file) => file.missing)

  const removeMissing = useCallback(async () => {
    if (missingFiles.length === 0) return
    const ok = await confirmDialog({
      title: t('settings.removeMissingProjectsConfirmTitle'),
      message: t('settings.removeMissingProjectsConfirmMessage', { count: missingFiles.length }),
      confirmLabel: t('settings.removeMissingProjects')
    })
    if (!ok) return
    try {
      await projectsApi.removeMissing()
      await refreshFiles()
      // missing individually-tracked entries are gone from the tracked list too
      await refreshTracked()
    } catch (cause) {
      await alertDialog(cleanErrorMessage(cause))
    }
  }, [missingFiles.length, projectsApi, refreshFiles, refreshTracked, confirmDialog, alertDialog, t])

  const untrackFile = useCallback(
    async (path: string) => {
      try {
        await projectsApi.removeFromList(path)
        await refreshTracked()
        await refreshFiles()
      } catch (cause) {
        await alertDialog(cleanErrorMessage(cause))
      }
    },
    [projectsApi, refreshTracked, refreshFiles, alertDialog]
  )

  const changeInstallsDir = useCallback(async () => {
    try {
      const picked = await buildsApi.pickInstallsDir()
      if (picked) setInstallsDirPath(picked)
    } catch (cause) {
      await alertDialog(cleanErrorMessage(cause))
    }
  }, [buildsApi, alertDialog])

  const resetInstallsDirPath = useCallback(async () => {
    try {
      setInstallsDirPath(await buildsApi.resetInstallsDir())
    } catch (cause) {
      await alertDialog(cleanErrorMessage(cause))
    }
  }, [buildsApi, alertDialog])

  const openInstallsDir = useCallback(async () => {
    try {
      await buildsApi.openInstallsDir()
    } catch (cause) {
      await alertDialog(cleanErrorMessage(cause))
    }
  }, [buildsApi, alertDialog])

  const changeDownloadsDir = useCallback(async () => {
    try {
      const picked = await buildsApi.pickDownloadsDir()
      if (picked) setDownloadsDirPath(picked)
    } catch (cause) {
      await alertDialog(cleanErrorMessage(cause))
    }
  }, [buildsApi, alertDialog])

  const resetDownloadsDirPath = useCallback(async () => {
    try {
      setDownloadsDirPath(await buildsApi.resetDownloadsDir())
    } catch (cause) {
      await alertDialog(cleanErrorMessage(cause))
    }
  }, [buildsApi, alertDialog])

  const openDownloadsDir = useCallback(async () => {
    try {
      await buildsApi.openDownloadsDir()
    } catch (cause) {
      await alertDialog(cleanErrorMessage(cause))
    }
  }, [buildsApi, alertDialog])

  // moving the stored add-on files can take a moment — block the buttons meanwhile
  const changeLibraryDir = useCallback(async () => {
    setLibraryDirBusy(true)
    try {
      const picked = await addonsApi.pickLibraryDir()
      if (picked) setLibraryDirPath(picked)
    } catch (cause) {
      await alertDialog(cleanErrorMessage(cause))
    } finally {
      setLibraryDirBusy(false)
    }
  }, [addonsApi, alertDialog])

  const resetLibraryDirPath = useCallback(async () => {
    setLibraryDirBusy(true)
    try {
      setLibraryDirPath(await addonsApi.resetLibraryDir())
    } catch (cause) {
      await alertDialog(cleanErrorMessage(cause))
    } finally {
      setLibraryDirBusy(false)
    }
  }, [addonsApi, alertDialog])

  const openLibraryDir = useCallback(async () => {
    try {
      await addonsApi.openLibraryDir()
    } catch (cause) {
      await alertDialog(cleanErrorMessage(cause))
    }
  }, [addonsApi, alertDialog])

  const desktopOnlyTitle = isDesktop ? undefined : t('settings.desktopOnlyHint')

  return (
    <PageLayout title={t('nav.settings')}>
      <div className="flex flex-col gap-4">
        <SectionCard
          title={t('settings.updates')}
          hint={t('settings.updatesHint')}
          anchorId="updates-card"
          highlighted={highlight === 'updates'}
        >
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2 text-xs">
              <span className="text-zinc-500">{t('settings.updatesCurrent')}</span>
              <span className="font-medium text-zinc-200">
                {updateInfo?.currentVersion ? `v${updateInfo.currentVersion}` : '—'}
              </span>
            </div>

            {updateChecking ? (
              <p className="text-xs text-zinc-500">{t('settings.updatesChecking')}</p>
            ) : updateInfo?.updateAvailable ? (
              // a known update outranks a transient check error — offline users
              // with a staged update must still see (and be able to install) it
              <p className="text-xs font-medium text-blender">
                {t('settings.updatesAvailable', { version: updateInfo.latestVersion ?? '' })}
              </p>
            ) : updateInfo?.error ? (
              <p className="text-xs text-amber-400">
                {t('settings.updatesCheckFailed', { error: updateInfo.error })}
              </p>
            ) : updateInfo?.latestVersion ? (
              <p className="text-xs text-emerald-400">{t('settings.updatesUpToDate')}</p>
            ) : null}

            {updateProgress?.phase === 'downloading' && (
              <p className="text-xs text-zinc-400">
                {t('settings.updatesDownloading', {
                  progress: updateProgress.totalBytes
                    ? `${Math.round(((updateProgress.receivedBytes ?? 0) / updateProgress.totalBytes) * 100)}%`
                    : formatBytes(updateProgress.receivedBytes ?? 0)
                })}
              </p>
            )}
            {updateProgress?.phase === 'verifying' && (
              <p className="text-xs text-zinc-400">{t('settings.updatesVerifying')}</p>
            )}
            {updateInfo?.downloaded && (
              <p className="text-xs text-emerald-400">{t('settings.updatesReady')}</p>
            )}
            {updateInfo?.updateAvailable && !updateInfo.canSelfUpdate && (
              <p className="text-xs text-zinc-500">{t('settings.updatesManualOnly')}</p>
            )}

            <div className="mt-1 flex flex-wrap items-center gap-2">
              {updateInfo?.updateAvailable && updateInfo.canSelfUpdate && !updateInfo.downloaded && (
                <button
                  onClick={downloadUpdate}
                  disabled={updateBusy || updateProgress?.phase === 'downloading'}
                  className={primaryButtonClass}
                >
                  {updateBusy ? '…' : t('settings.updatesDownload')}
                </button>
              )}
              {updateInfo?.updateAvailable && updateInfo.canSelfUpdate && updateInfo.downloaded && (
                <button onClick={installUpdate} className={primaryButtonClass}>
                  {t('settings.updatesRestart')}
                </button>
              )}
              <button
                onClick={checkUpdates}
                disabled={!isDesktop || updateChecking || updateBusy}
                title={desktopOnlyTitle}
                className={`${secondaryButtonClass} disabled:cursor-not-allowed disabled:opacity-40`}
              >
                {t('settings.updatesCheck')}
              </button>
            </div>
            <button
              onClick={openReleases}
              className="self-start text-[11px] text-zinc-500 underline transition-colors hover:text-zinc-300"
            >
              {t('settings.updatesOpenReleases')}
            </button>
          </div>
        </SectionCard>

        <SectionCard
          title={t('settings.language')}
          hint={t('settings.languageHint')}
          control={
            <Dropdown
              open={languageMenuOpen}
              onClose={() => setLanguageMenuOpen(false)}
              align="right"
              menuClassName="max-h-64 w-48 overflow-auto rounded-lg border border-white/10 bg-surface-menu p-1 shadow-xl"
              trigger={
                <button
                  onClick={() => setLanguageMenuOpen((open) => !open)}
                  className="inline-flex min-w-[10rem] items-center justify-between gap-2 rounded-lg border border-white/10 bg-surface-input px-3 py-1.5 text-sm font-medium text-zinc-200 transition-colors hover:bg-white/10"
                >
                  {languageLabel(language)}
                  <ChevronDownIcon className="h-4 w-4 shrink-0 text-zinc-500" />
                </button>
              }
            >
              {AVAILABLE_LANGUAGES.map((code) => (
                <button
                  key={code}
                  onClick={() => {
                    setLanguage(code)
                    setLanguageMenuOpen(false)
                  }}
                  className={`flex w-full items-center rounded-md px-3 py-1.5 text-left text-sm transition-colors ${
                    language === code ? 'bg-selection/15 text-selection' : 'text-zinc-300 hover:bg-white/10'
                  }`}
                >
                  {languageLabel(code)}
                </button>
              ))}
            </Dropdown>
          }
        />

        <ThemeCard />

        <SectionCard title={t('settings.startup')} hint={t('settings.startupHint')}>
          <div
            title={desktopOnlyTitle}
            className={`flex flex-col gap-2 ${isDesktop ? '' : 'opacity-40'}`}
          >
            <label
              className={`flex items-center gap-1.5 self-start text-xs text-zinc-300 transition-colors ${
                isDesktop ? 'cursor-pointer hover:text-zinc-100' : 'cursor-not-allowed'
              }`}
            >
              <input
                type="checkbox"
                checked={startupEnabled}
                onChange={toggleStartupEnabled}
                disabled={!isDesktop}
                className="accent-blender disabled:cursor-not-allowed"
              />
              {t('settings.startupWithSystem')}
            </label>
            <label
              className={`flex items-center gap-1.5 self-start text-xs transition-colors ${
                isDesktop && startupEnabled
                  ? 'cursor-pointer text-zinc-300 hover:text-zinc-100'
                  : 'cursor-not-allowed text-zinc-600'
              }`}
            >
              <input
                type="checkbox"
                checked={startupMinimized}
                onChange={toggleStartupMinimized}
                disabled={!isDesktop || !startupEnabled}
                className="accent-blender disabled:cursor-not-allowed"
              />
              {t('settings.startupMinimized')}
            </label>
          </div>
        </SectionCard>

        <SectionCard title={t('settings.tray')} hint={t('settings.trayHint')}>
          <div className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs text-zinc-300">{t('settings.trayOnClose')}</span>
              <BehaviorToggle
                value={closeBehavior}
                onChange={changeCloseBehavior}
                disabled={!isDesktop}
                title={desktopOnlyTitle}
                options={[
                  { id: 'quit', label: t('settings.trayActionQuit') },
                  { id: 'tray', label: t('settings.trayActionTray') }
                ]}
              />
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs text-zinc-300">{t('settings.trayOnMinimize')}</span>
              <BehaviorToggle
                value={minimizeBehavior}
                onChange={changeMinimizeBehavior}
                disabled={!isDesktop}
                title={desktopOnlyTitle}
                options={[
                  { id: 'taskbar', label: t('settings.trayActionTaskbar') },
                  { id: 'tray', label: t('settings.trayActionTray') }
                ]}
              />
            </div>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-xs text-zinc-300">{t('settings.trayPages')}</span>
              <div
                title={isDesktop ? undefined : desktopOnlyTitle}
                className={`flex flex-wrap items-center gap-3 ${isDesktop ? '' : 'opacity-40'}`}
              >
                {TRAY_PAGE_IDS.map((page) => (
                  <label
                    key={page}
                    className="flex cursor-pointer items-center gap-1.5 text-xs text-zinc-400 transition-colors hover:text-zinc-200"
                  >
                    <input
                      type="checkbox"
                      checked={trayPages.includes(page)}
                      onChange={() => toggleTrayPage(page)}
                      disabled={!isDesktop}
                      className="accent-blender disabled:cursor-not-allowed"
                    />
                    {t(`nav.${page}`)}
                  </label>
                ))}
              </div>
            </div>
          </div>
        </SectionCard>

        <StorageUsageCard
          usage={storage}
          loading={storageLoading}
          isDesktop={isDesktop}
          desktopOnlyTitle={desktopOnlyTitle}
          onRecalculate={refreshStorage}
        />

        <SectionCard
          title={t('settings.superhive')}
          hint={t('settings.superhiveHint')}
          anchorId="superhive-card"
          highlighted={highlight === 'superhive'}
        >
          {isDesktop && !superhive.available ? (
            <p className="text-xs text-amber-400">{t('settings.superhiveUnavailable')}</p>
          ) : superhive.connected ? (
            <div className="flex items-center gap-3">
              <span className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-400">
                <span className="h-2 w-2 rounded-full bg-emerald-400" />
                {t('settings.superhiveConnected')}
              </span>
              <button
                onClick={disconnectSuperhive}
                disabled={superhiveBusy || !isDesktop}
                className={`${secondaryButtonClass} disabled:cursor-not-allowed disabled:opacity-40`}
              >
                {t('settings.superhiveDisconnect')}
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <input
                type="password"
                value={superhiveToken}
                onChange={(event) => setSuperhiveToken(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && superhiveToken.trim() && !superhiveBusy) connectSuperhive()
                }}
                placeholder={t('settings.superhiveTokenPlaceholder')}
                disabled={!isDesktop}
                autoComplete="off"
                spellCheck={false}
                className="min-w-0 flex-1 rounded-lg border border-white/10 bg-surface-input px-3 py-1.5 text-xs text-zinc-200 placeholder:text-zinc-600 focus:border-blender/50 focus:outline-none disabled:opacity-40"
              />
              <button
                onClick={connectSuperhive}
                disabled={!isDesktop || !superhiveToken.trim() || superhiveBusy}
                className="shrink-0 rounded-lg bg-accent-button px-3 py-1.5 text-xs font-medium text-on-accent transition-colors hover:bg-accent-button-hover disabled:cursor-not-allowed disabled:opacity-40"
              >
                {superhiveBusy ? '…' : t('settings.superhiveConnect')}
              </button>
            </div>
          )}
          <button
            onClick={() => window.open(SUPERHIVE_DOCS_URL, '_blank', 'noopener')}
            className="mt-2 text-[11px] text-zinc-500 underline transition-colors hover:text-zinc-300"
          >
            {t('settings.superhiveWhereToken')}
          </button>
        </SectionCard>

        <SectionCard title={t('settings.projectFolders')} hint={t('settings.projectFoldersHint')}>
          <div className="flex flex-wrap gap-2">
            {folders.length === 0 ? (
              <p className="text-xs text-zinc-500">{t('settings.noFolders')}</p>
            ) : (
              folders.map((folder) => (
                <span
                  key={folder.path}
                  className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-white/10 bg-surface-menu py-1 pl-3 pr-2 text-xs text-zinc-300"
                >
                  <span className="truncate" title={folder.path}>
                    {folder.name}
                  </span>
                  <button
                    onClick={() => removeFolder(folder)}
                    title={t('common.remove')}
                    className="rounded-full p-0.5 text-zinc-500 transition-colors hover:bg-white/10 hover:text-red-400"
                  >
                    <XIcon />
                  </button>
                </span>
              ))
            )}
          </div>
          <button
            onClick={addFolder}
            disabled={!isDesktop}
            title={desktopOnlyTitle}
            className={`mt-3 disabled:cursor-not-allowed disabled:opacity-40 ${secondaryButtonClass}`}
          >
            + {t('settings.addFolder')}
          </button>
        </SectionCard>

        <SectionCard
          title={t('settings.trackedFiles')}
          hint={t('settings.trackedFilesHint')}
          control={
            trackedFiles.length > 0 ? (
              <span className="rounded-full border border-white/10 px-2 py-0.5 text-[11px] text-zinc-500">
                {trackedFiles.length}
              </span>
            ) : undefined
          }
        >
          {trackedFiles.length === 0 ? (
            <p className="text-xs text-zinc-500">{t('settings.noTrackedFiles')}</p>
          ) : (
            <div className="-mx-2 max-h-56 overflow-y-auto">
              {trackedFiles.map((path) => (
                <div
                  key={path}
                  className="flex items-center gap-3 rounded-lg px-2 py-1 transition-colors hover:bg-white/5"
                >
                  <span className="max-w-[45%] shrink-0 truncate text-xs text-zinc-300">
                    {fileNameOf(path).replace(/\.blend$/i, '')}
                  </span>
                  <span className="min-w-0 flex-1 truncate text-right text-[11px] text-zinc-600" title={path}>
                    {path}
                  </span>
                  <button
                    onClick={() => untrackFile(path)}
                    title={t('common.remove')}
                    className="shrink-0 rounded-full p-0.5 text-zinc-600 transition-colors hover:bg-white/10 hover:text-red-400"
                  >
                    <XIcon />
                  </button>
                </div>
              ))}
            </div>
          )}
          <button
            onClick={addTrackedFile}
            disabled={!isDesktop}
            title={desktopOnlyTitle}
            className={`mt-3 disabled:cursor-not-allowed disabled:opacity-40 ${secondaryButtonClass}`}
          >
            + {t('settings.addFile')}
          </button>
        </SectionCard>

        <SectionCard
          title={t('settings.removeMissingProjects')}
          hint={t('settings.removeMissingProjectsHint')}
          control={
            <button
              onClick={removeMissing}
              disabled={missingFiles.length === 0 || !isDesktop}
              title={desktopOnlyTitle}
              className="rounded-lg border border-red-500/30 px-3 py-1.5 text-xs font-medium text-red-300 transition-colors hover:bg-red-500/10 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {missingFiles.length === 0
                ? t('settings.removeMissingProjectsNone')
                : t('settings.removeMissingProjects')}
            </button>
          }
        />

        <SectionCard title={t('settings.installFolder')} hint={t('settings.installFolderHint')}>
          <div className="flex items-center gap-2">
            <p className={pathBoxClass} title={installsDirPath}>
              {installsDirPath || '—'}
            </p>
            <button
              onClick={openInstallsDir}
              disabled={!isDesktop}
              title={desktopOnlyTitle}
              className={`${secondaryButtonClass} disabled:cursor-not-allowed disabled:opacity-40`}
            >
              {t('settings.openFolder')}
            </button>
            <button
              onClick={changeInstallsDir}
              disabled={!isDesktop}
              title={desktopOnlyTitle}
              className={`${secondaryButtonClass} disabled:cursor-not-allowed disabled:opacity-40`}
            >
              {t('settings.change')}
            </button>
            <button
              onClick={resetInstallsDirPath}
              disabled={!isDesktop}
              title={desktopOnlyTitle}
              className={`${secondaryButtonClass} disabled:cursor-not-allowed disabled:opacity-40`}
            >
              {t('settings.resetToDefault')}
            </button>
          </div>
        </SectionCard>

        <SectionCard title={t('settings.downloadFolder')} hint={t('settings.downloadFolderHint')}>
          <div className="flex items-center gap-2">
            <p className={pathBoxClass} title={downloadsDirPath}>
              {downloadsDirPath || '—'}
            </p>
            <button
              onClick={openDownloadsDir}
              disabled={!isDesktop}
              title={desktopOnlyTitle}
              className={`${secondaryButtonClass} disabled:cursor-not-allowed disabled:opacity-40`}
            >
              {t('settings.openFolder')}
            </button>
            <button
              onClick={changeDownloadsDir}
              disabled={!isDesktop}
              title={desktopOnlyTitle}
              className={`${secondaryButtonClass} disabled:cursor-not-allowed disabled:opacity-40`}
            >
              {t('settings.change')}
            </button>
            <button
              onClick={resetDownloadsDirPath}
              disabled={!isDesktop}
              title={desktopOnlyTitle}
              className={`${secondaryButtonClass} disabled:cursor-not-allowed disabled:opacity-40`}
            >
              {t('settings.resetToDefault')}
            </button>
          </div>
        </SectionCard>

        <SectionCard title={t('settings.libraryFolder')} hint={t('settings.libraryFolderHint')}>
          <div className="flex items-center gap-2">
            <p className={pathBoxClass} title={libraryDirPath}>
              {libraryDirPath || '—'}
            </p>
            <button
              onClick={openLibraryDir}
              disabled={!isDesktop || libraryDirBusy}
              title={desktopOnlyTitle}
              className={`${secondaryButtonClass} disabled:cursor-not-allowed disabled:opacity-40`}
            >
              {t('settings.openFolder')}
            </button>
            <button
              onClick={changeLibraryDir}
              disabled={!isDesktop || libraryDirBusy}
              title={desktopOnlyTitle}
              className={`${secondaryButtonClass} disabled:cursor-not-allowed disabled:opacity-40`}
            >
              {libraryDirBusy ? t('settings.libraryFolderMoving') : t('settings.change')}
            </button>
            <button
              onClick={resetLibraryDirPath}
              disabled={!isDesktop || libraryDirBusy}
              title={desktopOnlyTitle}
              className={`${secondaryButtonClass} disabled:cursor-not-allowed disabled:opacity-40`}
            >
              {t('settings.resetToDefault')}
            </button>
          </div>
        </SectionCard>
      </div>
    </PageLayout>
  )
}

