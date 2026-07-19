import { useCallback, useEffect, useMemo, useState } from 'react'
import PageLayout, { EmptyState } from '../components/PageLayout'
import Dropdown from '../components/Dropdown'
import { useDialog } from '../components/Dialog'
import { DownloadIcon, FolderIcon } from '../components/Sidebar'
import { compareVersionsDesc, pickNativeInstall } from '../../../shared/blender-builds'
import { cleanErrorMessage, formatBytes } from '../lib/format'
import { useTranslation } from '../lib/i18n'
import { getLauncherApi } from '../lib/preview-fallback'
import { uiGet, uiSet } from '../lib/ui-store'
import type { BlendFileInfo, InstalledBuild, ProjectFolder } from '../../../shared/types'
import { CubeIcon, WarningIcon, SearchIcon, RefreshIcon, PlusIcon, ChevronDownIcon, DotsIcon, CheckIcon, GearIcon } from './projects/icons'
import { readFlag } from './projects/projects-utils'
import { FilterSelect } from '../components/FilterSelect'
import type { ProjectsPageProps } from './projects/types'

// Module-level snapshot of the last successful load. The component is unmounted on
// every tab switch, but the module lives on — re-entering the page shows the previous
// list instantly while a fresh scan replaces it in the background.
let lastLoaded: {
  folders: ProjectFolder[]
  files: BlendFileInfo[]
  installed: InstalledBuild[]
} | null = null

export default function ProjectsPage({
  versionFilter,
  onVersionFilterChange,
  onShowInstalls
}: ProjectsPageProps) {
  const { api, isDesktop } = getLauncherApi()
  const { t } = useTranslation()
  const projectsApi = api.projects
  const buildsApi = api.builds
  const { confirm: confirmDialog, alert: alertDialog } = useDialog()

  const [folders, setFolders] = useState<ProjectFolder[]>(() => lastLoaded?.folders ?? [])
  const [files, setFiles] = useState<BlendFileInfo[] | null>(() => lastLoaded?.files ?? null)
  const [installed, setInstalled] = useState<InstalledBuild[]>(() => lastLoaded?.installed ?? [])
  const [scanning, setScanning] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [menuFor, setMenuFor] = useState<string | null>(null)
  const [sortKey, setSortKey] = useState<'name' | 'date' | 'version' | 'size'>('date')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')
  const [query, setQuery] = useState('')
  const [addMenuOpen, setAddMenuOpen] = useState(false)

  const [newProjectOpen, setNewProjectOpen] = useState(false)
  const [npName, setNpName] = useState('')
  const [npInstallId, setNpInstallId] = useState('')
  const [npFolder, setNpFolder] = useState('')
  const [npError, setNpError] = useState<string | null>(null)
  const [creating, setCreating] = useState(false)

  const [cardMenuFor, setCardMenuFor] = useState<string | null>(null)
  const [renameFor, setRenameFor] = useState<BlendFileInfo | null>(null)
  const [renameValue, setRenameValue] = useState('')
  const [selectedInstall, setSelectedInstall] = useState<Record<string, string>>({})

  const [settingsOpen, setSettingsOpen] = useState(false)
  const [showDate, setShowDate] = useState(() => readFlag('projects.showDate', true))
  const [showSize, setShowSize] = useState(() => readFlag('projects.showSize', false))
  const [showPath, setShowPath] = useState(() => readFlag('projects.showPath', true))
  const [showVersion, setShowVersion] = useState(() => readFlag('projects.showVersion', true))
  const [cardSize, setCardSize] = useState(() => {
    const stored = Number(uiGet('projects.cardSize'))
    return Number.isFinite(stored) && stored >= 150 && stored <= 340 ? stored : 200
  })

  useEffect(() => {
    uiSet('projects.showDate', showDate ? '1' : '0')
    uiSet('projects.showSize', showSize ? '1' : '0')
    uiSet('projects.showPath', showPath ? '1' : '0')
    uiSet('projects.showVersion', showVersion ? '1' : '0')
    uiSet('projects.cardSize', String(cardSize))
  }, [showDate, showSize, showPath, showVersion, cardSize])

  const refreshFiles = useCallback(async () => {
    setScanning(true)
    setError(null)
    try {
      setFiles(await projectsApi.listFiles())
    } catch (cause) {
      setError(cleanErrorMessage(cause))
    } finally {
      setScanning(false)
    }
  }, [projectsApi])

  useEffect(() => {
    ;(async () => {
      try {
        setFolders(await projectsApi.listFolders())
        setInstalled(await buildsApi.listInstalled())
      } catch {
        // preview mode — lists stay empty
      }
      await refreshFiles()
    })()
  }, [projectsApi, buildsApi, refreshFiles])

  useEffect(() => {
    if (files !== null) lastLoaded = { folders, files, installed }
  }, [folders, files, installed])

  const addFolder = useCallback(async () => {
    try {
      setFolders(await projectsApi.addFolder())
      await refreshFiles()
    } catch (cause) {
      await alertDialog(cleanErrorMessage(cause))
    }
  }, [projectsApi, refreshFiles, alertDialog])

  const addFile = useCallback(async () => {
    try {
      const added = await projectsApi.addFile()
      if (added) await refreshFiles()
    } catch (cause) {
      await alertDialog(cleanErrorMessage(cause))
    }
  }, [projectsApi, refreshFiles, alertDialog])

  const installedSorted = useMemo(
    () => [...installed].sort((a, b) => compareVersionsDesc(a.version, b.version)),
    [installed]
  )

  const openNewProject = useCallback(() => {
    setNpName('')
    setNpFolder('')
    setNpError(null)
    setNpInstallId(installedSorted[0]?.id ?? '')
    setNewProjectOpen(true)
  }, [installedSorted])

  const pickLocation = useCallback(async () => {
    try {
      const picked = await projectsApi.pickFolder()
      if (picked) setNpFolder(picked)
    } catch (cause) {
      await alertDialog(cleanErrorMessage(cause))
    }
  }, [projectsApi, alertDialog])

  const submitNewProject = useCallback(async () => {
    if (!npName.trim() || !npFolder || !npInstallId) return
    setCreating(true)
    setNpError(null)
    try {
      const createdPath = await projectsApi.createProject({
        name: npName.trim(),
        installId: npInstallId,
        folder: npFolder
      })
      setNewProjectOpen(false)
      await refreshFiles()
      await projectsApi.openFile(createdPath, npInstallId)
    } catch (cause) {
      setNpError(cleanErrorMessage(cause))
    } finally {
      setCreating(false)
    }
  }, [npName, npFolder, npInstallId, projectsApi, refreshFiles])

  const bestInstallFor = useCallback(
    (file: BlendFileInfo): InstalledBuild | null => {
      if (installedSorted.length === 0) return null
      return pickNativeInstall(installedSorted, file.blenderVersion) ?? installedSorted[0]
    },
    [installedSorted]
  )

  const openFile = useCallback(
    async (file: BlendFileInfo, installId?: string) => {
      const target = installId ?? bestInstallFor(file)?.id
      if (!target) return
      setMenuFor(null)
      try {
        await projectsApi.openFile(file.path, target)
      } catch (cause) {
        await alertDialog(cleanErrorMessage(cause))
      }
    },
    [projectsApi, bestInstallFor, alertDialog]
  )

  const nativeInstallFor = useCallback(
    (file: BlendFileInfo): InstalledBuild | null => pickNativeInstall(installedSorted, file.blenderVersion),
    [installedSorted]
  )

  const requestOpen = useCallback(
    (file: BlendFileInfo, build: InstalledBuild | null) => {
      if (!build) return
      const native = nativeInstallFor(file)
      const needsConfirm = native ? build.id !== native.id : Boolean(file.blenderVersion)
      if (needsConfirm) {
        confirmDialog({
          title: t('projects.openDifferentVersionTitle'),
          message: t('projects.openDifferentVersionMessage', {
            fileVersion: file.blenderVersion ?? t('projects.unknownVersion'),
            buildVersion: build.version
          }),
          variant: 'warning',
          confirmLabel: t('projects.openInBlender', { version: build.version })
        }).then((ok) => {
          if (ok) openFile(file, build.id)
        })
      } else {
        openFile(file, build.id)
      }
    },
    [nativeInstallFor, openFile, confirmDialog, t]
  )

  const changePreview = useCallback(
    async (file: BlendFileInfo) => {
      try {
        const ok = await projectsApi.setPreview(file.path)
        if (ok) await refreshFiles()
      } catch (cause) {
        await alertDialog(cleanErrorMessage(cause))
      }
    },
    [projectsApi, refreshFiles, alertDialog]
  )

  const resetPreview = useCallback(
    async (file: BlendFileInfo) => {
      try {
        await projectsApi.clearPreview(file.path)
        await refreshFiles()
      } catch (cause) {
        await alertDialog(cleanErrorMessage(cause))
      }
    },
    [projectsApi, refreshFiles, alertDialog]
  )

  const relocateProject = useCallback(
    async (file: BlendFileInfo) => {
      try {
        const moved = await projectsApi.moveProject(file.path)
        if (moved) await refreshFiles()
      } catch (cause) {
        await alertDialog(cleanErrorMessage(cause))
      }
    },
    [projectsApi, refreshFiles, alertDialog]
  )

  const removeFromList = useCallback(
    async (file: BlendFileInfo) => {
      const ok = await confirmDialog({
        title: t('projects.removeFromListTitle'),
        message: t('projects.removeFromListMessage', { name: file.displayName ?? file.name }),
        confirmLabel: t('common.remove')
      })
      if (!ok) return
      try {
        await projectsApi.removeFromList(file.path)
        await refreshFiles()
      } catch (cause) {
        await alertDialog(cleanErrorMessage(cause))
      }
    },
    [projectsApi, refreshFiles, confirmDialog, alertDialog, t]
  )

  const deleteProjectFile = useCallback(
    async (file: BlendFileInfo) => {
      const ok = await confirmDialog({
        title: t('projects.deleteFileTitle'),
        message: t('projects.deleteFileMessage', { name: file.name }),
        variant: 'danger',
        tone: 'danger',
        confirmLabel: t('common.delete')
      })
      if (!ok) return
      try {
        await projectsApi.deleteFile(file.path)
        await refreshFiles()
      } catch (cause) {
        await alertDialog(cleanErrorMessage(cause))
      }
    },
    [projectsApi, refreshFiles, confirmDialog, alertDialog, t]
  )

  const findMissing = useCallback(
    async (file: BlendFileInfo) => {
      try {
        const found = await projectsApi.findMissing(file.path)
        if (found) await refreshFiles()
      } catch (cause) {
        await alertDialog(cleanErrorMessage(cause))
      }
    },
    [projectsApi, refreshFiles, alertDialog]
  )

  const openRename = useCallback((file: BlendFileInfo) => {
    setRenameFor(file)
    setRenameValue(file.displayName ?? file.name.replace(/\.blend$/i, ''))
  }, [])

  const saveDisplayName = useCallback(async () => {
    if (!renameFor) return
    try {
      const trimmed = renameValue.trim()
      await projectsApi.setDisplayName(renameFor.path, trimmed.length ? trimmed : null)
      setRenameFor(null)
      await refreshFiles()
    } catch (cause) {
      await alertDialog(cleanErrorMessage(cause))
    }
  }, [renameFor, renameValue, projectsApi, refreshFiles, alertDialog])

  const versions = useMemo(() => {
    const present = new Set<string>()
    for (const file of files ?? []) if (file.blenderVersion) present.add(file.blenderVersion)
    // an externally-set filter (from "View projects") must stay selectable in the dropdown
    if (versionFilter !== 'all') present.add(versionFilter)
    return ['all', ...[...present].sort(compareVersionsDesc)]
  }, [files, versionFilter])

  const visibleFiles = useMemo(() => {
    const q = query.trim().toLowerCase()
    return (files ?? []).filter((file) => {
      // missing files are exempt from the version filter — their version is unknown
      if (!file.missing && versionFilter !== 'all' && file.blenderVersion !== versionFilter) return false
      if (q && !file.name.toLowerCase().includes(q) && !(file.displayName ?? '').toLowerCase().includes(q))
        return false
      return true
    })
  }, [files, versionFilter, query])

  const sortedFiles = useMemo(() => {
    const factor = sortDir === 'asc' ? -1 : 1
    return [...visibleFiles].sort((a, b) => {
      // missing files have no date/size/version — pin them to the top so sorting doesn't bury them
      if (a.missing !== b.missing) return a.missing ? -1 : 1
      if (sortKey === 'name') return b.name.localeCompare(a.name) * factor
      if (sortKey === 'date') return (b.mtimeMs - a.mtimeMs) * factor
      if (sortKey === 'size') return (b.size - a.size) * factor
      // version: files without a detected version always sort last
      if (!a.blenderVersion && !b.blenderVersion) return 0
      if (!a.blenderVersion) return 1
      if (!b.blenderVersion) return -1
      return compareVersionsDesc(a.blenderVersion, b.blenderVersion) * factor
    })
  }, [visibleFiles, sortKey, sortDir])

  const hasProjects = folders.length > 0 || (files?.length ?? 0) > 0
  const noInstalls = installedSorted.length === 0

  return (
    <PageLayout
      title={t('projects.title')}
      actions={
        <div className="flex items-center gap-2">
          <button
            title={t('projects.rescanFolders')}
            onClick={refreshFiles}
            disabled={!isDesktop || scanning}
            className="rounded-lg border border-white/10 p-2 text-zinc-400 transition-colors hover:bg-white/5 hover:text-zinc-200 disabled:opacity-50"
          >
            <RefreshIcon className={`h-4 w-4 ${scanning ? 'animate-spin' : ''}`} />
          </button>
          <Dropdown
            open={addMenuOpen}
            onClose={() => setAddMenuOpen(false)}
            align="right"
            menuClassName="min-w-44 overflow-hidden rounded-lg border border-white/10 bg-surface-menu py-1 shadow-xl"
            trigger={
              <button
                onClick={() => setAddMenuOpen((open) => !open)}
                disabled={!isDesktop}
                className="flex items-center gap-1 rounded-lg border border-white/10 px-3 py-1.5 text-sm font-medium text-zinc-200 transition-colors hover:bg-white/5 disabled:opacity-50"
              >
                {t('projects.add')}
                <ChevronDownIcon />
              </button>
            }
          >
            <button
              onClick={() => {
                setAddMenuOpen(false)
                addFolder()
              }}
              className="block w-full px-3 py-1.5 text-left text-sm text-zinc-300 transition-colors hover:bg-white/5"
            >
              {t('projects.addFolder')}
            </button>
            <button
              onClick={() => {
                setAddMenuOpen(false)
                addFile()
              }}
              className="block w-full px-3 py-1.5 text-left text-sm text-zinc-300 transition-colors hover:bg-white/5"
            >
              {t('projects.addFile')}
            </button>
          </Dropdown>
          <button
            onClick={openNewProject}
            disabled={!isDesktop || noInstalls}
            title={noInstalls ? t('projects.installFirst') : undefined}
            className="flex items-center gap-1 rounded-lg bg-blender px-3 py-1.5 text-sm font-medium text-on-accent transition-colors hover:bg-blender/90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <PlusIcon />
            {t('projects.newProject')}
          </button>
        </div>
      }
    >
      {!isDesktop ? (
        <EmptyState
          icon={<FolderIcon className="h-7 w-7" />}
          title={t('projects.desktopOnlyTitle')}
          hint={t('projects.desktopOnlyHint')}
        />
      ) : !hasProjects && !scanning ? (
        <EmptyState
          icon={<FolderIcon className="h-7 w-7" />}
          title={t('projects.emptyTitle')}
          hint={t('projects.emptyHint')}
        />
      ) : (
        <div className="flex flex-col gap-4">
          <div className="flex flex-wrap items-end gap-2">
            <FilterSelect
              label={t('projects.sort')}
              value={sortKey}
              onChange={setSortKey}
              options={[
                { value: 'name', label: t('projects.name') },
                { value: 'date', label: t('projects.date') },
                { value: 'version', label: t('projects.version') },
                { value: 'size', label: t('projects.size') }
              ]}
            />
            <FilterSelect
              label={t('projects.order')}
              value={sortDir}
              onChange={setSortDir}
              options={[
                { value: 'desc', label: t('projects.descending') },
                { value: 'asc', label: t('projects.ascending') }
              ]}
            />
            <FilterSelect
              label={t('projects.version')}
              value={versionFilter}
              onChange={onVersionFilterChange}
              options={versions.map((version) => ({
                value: version,
                label: version === 'all' ? t('projects.all') : version
              }))}
              width="w-20"
            />
            <div className="ml-auto flex items-end gap-2 self-end">
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t('projects.searchPlaceholder')}
                disabled={!isDesktop}
                className="w-44 rounded-lg border border-white/10 bg-transparent px-3 py-1.5 text-xs text-zinc-200 placeholder:text-zinc-600 focus:border-blender/50 focus:outline-none disabled:opacity-50"
              />
              <Dropdown
                open={settingsOpen}
                onClose={() => setSettingsOpen(false)}
                align="right"
                menuClassName="w-52 rounded-lg border border-white/10 bg-surface-menu p-1 shadow-xl"
                trigger={
                  <button
                    title={t('projects.displaySettings')}
                    onClick={() => setSettingsOpen((open) => !open)}
                    className="rounded-lg border border-white/10 p-1.5 text-zinc-400 transition-colors hover:bg-white/5 hover:text-zinc-200"
                  >
                    <GearIcon className="h-4 w-4" />
                  </button>
                }
              >
                <p className="px-2 py-1 text-[11px] font-medium uppercase tracking-wide text-zinc-500">
                  {t('projects.showOnCards')}
                </p>
                <label className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm text-zinc-300 transition-colors hover:bg-white/5">
                  <input
                    type="checkbox"
                    checked={showDate}
                    onChange={(event) => setShowDate(event.target.checked)}
                    className="accent-blender"
                  />
                  {t('projects.date')}
                </label>
                <label className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm text-zinc-300 transition-colors hover:bg-white/5">
                  <input
                    type="checkbox"
                    checked={showSize}
                    onChange={(event) => setShowSize(event.target.checked)}
                    className="accent-blender"
                  />
                  {t('projects.fileSize')}
                </label>
                <label className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm text-zinc-300 transition-colors hover:bg-white/5">
                  <input
                    type="checkbox"
                    checked={showPath}
                    onChange={(event) => setShowPath(event.target.checked)}
                    className="accent-blender"
                  />
                  {t('projects.path')}
                </label>
                <label className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm text-zinc-300 transition-colors hover:bg-white/5">
                  <input
                    type="checkbox"
                    checked={showVersion}
                    onChange={(event) => setShowVersion(event.target.checked)}
                    className="accent-blender"
                  />
                  {t('projects.version')}
                </label>
                <div className="my-1 border-t border-white/5" />
                <p className="px-2 py-1 text-[11px] font-medium uppercase tracking-wide text-zinc-500">
                  {t('projects.size')}
                </p>
                <div className="px-2 pb-2 pt-1">
                  <input
                    type="range"
                    min={150}
                    max={340}
                    step={2}
                    value={cardSize}
                    onChange={(event) => setCardSize(Number(event.target.value))}
                    className="w-full accent-blender"
                  />
                  <p className="mt-1 text-center text-[11px] text-zinc-500">
                    {(cardSize / 200).toFixed(2)}x
                  </p>
                </div>
              </Dropdown>
            </div>
          </div>

          {error && <p className="text-sm text-red-400">{error}</p>}

          {files !== null && files.length === 0 && !scanning ? (
            <p className="text-sm text-zinc-500">{t('projects.noBlendFiles')}</p>
          ) : visibleFiles.length === 0 && !scanning ? (
            <p className="text-sm text-zinc-500">
              {query.trim()
                ? t('projects.noSearchMatches')
                : t('projects.noProjectsInVersion', { version: versionFilter })}
            </p>
          ) : (
            <div
              className="grid gap-3"
              style={{ gridTemplateColumns: `repeat(auto-fill, minmax(${cardSize}px, 1fr))` }}
            >
              {sortedFiles.map((file) => {
                const native = nativeInstallFor(file)
                const selectedId = selectedInstall[file.path]
                const selected =
                  (selectedId ? installedSorted.find((build) => build.id === selectedId) : null) ??
                  native ??
                  installedSorted[0] ??
                  null
                const mismatch =
                  selected != null && (native ? selected.id !== native.id : Boolean(file.blenderVersion))
                return (
                  <div
                    key={file.path}
                    className="relative flex flex-col rounded-xl border border-white/5 bg-surface-panel"
                    onDoubleClick={() => {
                      if (!file.missing && selected) requestOpen(file, selected)
                    }}
                    onContextMenu={(event) => {
                      event.preventDefault()
                      setCardMenuFor(file.path)
                    }}
                  >
                    {file.missing ? (
                      <span
                        className="absolute left-2 top-2 z-10 flex items-center gap-1 rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-semibold text-amber-300 backdrop-blur-sm"
                        title={t('projects.missingHint')}
                      >
                        <WarningIcon className="h-3 w-3" />
                        {t('projects.missing')}
                      </span>
                    ) : (
                      showVersion && (
                        <span
                          className="absolute left-2 top-2 z-10 rounded bg-black/50 px-1.5 py-0.5 text-[10px] font-semibold text-zinc-200 backdrop-blur-sm"
                          title={
                            file.blenderVersion
                              ? t('projects.savedInVersion', { version: file.blenderVersion })
                              : undefined
                          }
                        >
                          {file.blenderVersion ?? t('projects.unknown')}
                        </span>
                      )
                    )}
                    <Dropdown
                      className="absolute right-2 top-2 z-10"
                      open={cardMenuFor === file.path}
                      onClose={() => setCardMenuFor(null)}
                      align="right"
                      menuClassName="min-w-52 overflow-hidden rounded-lg border border-white/10 bg-surface-menu py-1 text-sm shadow-xl"
                      trigger={
                        <button
                          onClick={() => setCardMenuFor(cardMenuFor === file.path ? null : file.path)}
                          title={t('projects.moreActions')}
                          className="rounded-lg bg-black/50 p-1 text-zinc-200 backdrop-blur-sm transition-colors hover:bg-black/70"
                        >
                          <DotsIcon className="h-4 w-4" />
                        </button>
                      }
                    >
                      {file.missing ? (
                        <>
                          <button
                            onClick={() => {
                              setCardMenuFor(null)
                              findMissing(file)
                            }}
                            className="flex w-full items-center gap-2 px-3 py-1.5 text-left font-medium text-blender transition-colors hover:bg-blender/10"
                          >
                            <SearchIcon className="h-4 w-4" />
                            {t('projects.findMissingFile')}
                          </button>
                          <button
                            onClick={() => {
                              setCardMenuFor(null)
                              openRename(file)
                            }}
                            className="block w-full px-3 py-1.5 text-left text-zinc-300 transition-colors hover:bg-white/5"
                          >
                            {t('projects.setDisplayName')}
                          </button>
                          <div className="my-1 border-t border-white/5" />
                          <button
                            onClick={() => {
                              setCardMenuFor(null)
                              removeFromList(file)
                            }}
                            className="block w-full px-3 py-1.5 text-left text-zinc-300 transition-colors hover:bg-white/5"
                          >
                            {t('projects.removeFromList')}
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            onClick={() => {
                              setCardMenuFor(null)
                              projectsApi.reveal(file.path).catch(() => undefined)
                            }}
                            className="block w-full px-3 py-1.5 text-left text-zinc-300 transition-colors hover:bg-white/5"
                          >
                            {t('projects.showInFolder')}
                          </button>
                          <button
                            onClick={() => {
                              setCardMenuFor(null)
                              openRename(file)
                            }}
                            className="block w-full px-3 py-1.5 text-left text-zinc-300 transition-colors hover:bg-white/5"
                          >
                            {t('projects.setDisplayName')}
                          </button>
                          <button
                            onClick={() => {
                              setCardMenuFor(null)
                              changePreview(file)
                            }}
                            className="block w-full px-3 py-1.5 text-left text-zinc-300 transition-colors hover:bg-white/5"
                          >
                            {t('projects.changePreviewImage')}
                          </button>
                          {file.hasCustomPreview && (
                            <button
                              onClick={() => {
                                setCardMenuFor(null)
                                resetPreview(file)
                              }}
                              className="block w-full px-3 py-1.5 text-left text-zinc-300 transition-colors hover:bg-white/5"
                            >
                              {t('projects.resetPreview')}
                            </button>
                          )}
                          <button
                            onClick={() => {
                              setCardMenuFor(null)
                              relocateProject(file)
                            }}
                            className="block w-full px-3 py-1.5 text-left text-zinc-300 transition-colors hover:bg-white/5"
                          >
                            {t('projects.moveProject')}
                          </button>
                          <div className="my-1 border-t border-white/5" />
                          <button
                            onClick={() => {
                              setCardMenuFor(null)
                              removeFromList(file)
                            }}
                            className="block w-full px-3 py-1.5 text-left text-zinc-300 transition-colors hover:bg-white/5"
                          >
                            {t('projects.removeFromList')}
                          </button>
                          <button
                            onClick={() => {
                              setCardMenuFor(null)
                              deleteProjectFile(file)
                            }}
                            className="block w-full px-3 py-1.5 text-left text-red-400 transition-colors hover:bg-red-500/10"
                          >
                            {t('projects.deleteFile')}
                          </button>
                        </>
                      )}
                    </Dropdown>
                    <div className="flex aspect-[4/3] items-center justify-center overflow-hidden rounded-t-xl bg-surface-inset">
                      {file.missing ? (
                        <WarningIcon className="h-10 w-10 text-amber-500/50" />
                      ) : file.thumbnail ? (
                        <img
                          src={file.thumbnail}
                          alt=""
                          className="h-full w-full object-cover"
                          draggable={false}
                        />
                      ) : (
                        <CubeIcon className="h-10 w-10 text-zinc-700" />
                      )}
                    </div>
                    <div className="flex flex-1 flex-col gap-2 p-3">
                      <p
                        className="min-w-0 truncate text-sm font-medium text-zinc-100"
                        title={file.displayName ? `${file.name}\n${file.path}` : file.path}
                      >
                        {file.displayName ?? file.name.replace(/\.blend$/i, '')}
                      </p>
                      {file.missing ? (
                        <p className="truncate text-[11px] font-medium text-amber-400" title={file.path}>
                          {t('projects.fileNotFound')}
                        </p>
                      ) : (
                        <>
                          {(showSize || showDate) && (
                            <p className="text-[11px] text-zinc-500">
                              {[
                                showSize ? formatBytes(file.size) : null,
                                showDate ? new Date(file.mtimeMs).toLocaleDateString() : null
                              ]
                                .filter(Boolean)
                                .join(' · ')}
                            </p>
                          )}
                          {showPath && (
                            <p className="truncate text-[11px] text-zinc-600" title={file.path}>
                              {file.path}
                            </p>
                          )}
                        </>
                      )}
                      <div className="mt-auto flex items-center gap-1.5">
                        {file.missing ? (
                          <button
                            onClick={() => findMissing(file)}
                            className="flex items-center gap-1.5 rounded-lg bg-blender px-3 py-1 text-xs font-medium text-on-accent transition-colors hover:bg-blender/90"
                          >
                            <SearchIcon className="h-3.5 w-3.5" />
                            {t('projects.findFile')}
                          </button>
                        ) : (
                          <>
                        <button
                          onClick={() => requestOpen(file, selected)}
                          disabled={!selected}
                          title={
                            selected
                              ? t('projects.openWithVersion', { version: selected.version })
                              : t('projects.installFirst')
                          }
                          className="rounded-lg bg-blender px-3 py-1 text-xs font-medium text-on-accent transition-colors hover:bg-blender/90 disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          {t('common.open')}
                        </button>
                        {mismatch && (
                          <span
                            title={t('projects.versionMismatch', {
                              fileVersion: file.blenderVersion ?? '—',
                              selectedVersion: selected?.version ?? ''
                            })}
                            className="flex items-center text-amber-400"
                          >
                            <WarningIcon className="h-4 w-4" />
                          </span>
                        )}
                        <Dropdown
                          className="ml-auto"
                          open={menuFor === file.path}
                          onClose={() => setMenuFor(null)}
                          align="right"
                          menuClassName="flex max-h-64 flex-col overflow-hidden rounded-lg border border-white/10 bg-surface-menu py-1 shadow-xl"
                          trigger={
                            <button
                              onClick={() => setMenuFor(menuFor === file.path ? null : file.path)}
                              disabled={installedSorted.length === 0}
                              title={t('projects.chooseVersion')}
                              className="flex items-center gap-1 rounded-lg border border-white/10 px-2 py-1 text-xs font-medium text-zinc-200 transition-colors hover:bg-white/5 disabled:cursor-not-allowed disabled:opacity-40"
                            >
                              {selected ? selected.version : '—'}
                              <ChevronDownIcon className="h-3 w-3" />
                            </button>
                          }
                        >
                          <div className="min-h-0 flex-1 overflow-y-auto">
                            {installedSorted.map((build) => {
                              const isNativeRow = native != null && build.id === native.id
                              const isSelectedRow = selected != null && build.id === selected.id
                              return (
                                <button
                                  key={build.id}
                                  onClick={() => {
                                    setSelectedInstall((prev) => ({ ...prev, [file.path]: build.id }))
                                    setMenuFor(null)
                                  }}
                                  title={`${t('projects.blenderBuildLabel', { version: build.version, cycle: build.releaseCycle })}${isNativeRow ? t('projects.projectVersionSuffix') : ''}`}
                                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-zinc-300 transition-colors hover:bg-white/5"
                                >
                                  <span
                                    className={`h-1.5 w-1.5 shrink-0 rounded-full ${isNativeRow ? 'bg-emerald-400' : 'bg-transparent'}`}
                                  />
                                  {build.version}
                                  {isSelectedRow && (
                                    <CheckIcon className="h-3.5 w-3.5 shrink-0 text-blender" />
                                  )}
                                </button>
                              )
                            })}
                          </div>
                          {file.blenderVersion && !native && onShowInstalls && (
                            <>
                              <div className="my-1 shrink-0 border-t border-white/5" />
                              <button
                                onClick={() => {
                                  setMenuFor(null)
                                  onShowInstalls(file.blenderVersion!)
                                }}
                                className="flex w-full shrink-0 items-center gap-2 px-3 py-1.5 text-left text-xs font-medium text-blender transition-colors hover:bg-blender/10"
                              >
                                <DownloadIcon className="h-3.5 w-3.5" />
                                {t('projects.installVersion', { version: file.blenderVersion })}
                              </button>
                            </>
                          )}
                        </Dropdown>
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>
      )}

      {newProjectOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          onClick={() => !creating && setNewProjectOpen(false)}
        >
          <div
            className="w-full max-w-md rounded-xl border border-white/10 bg-surface-dialog p-5 shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <h2 className="text-base font-semibold text-zinc-100">{t('projects.newProject')}</h2>
            <div className="mt-4 flex flex-col gap-4">
              <label className="flex flex-col gap-1.5">
                <span className="text-xs font-medium text-zinc-400">{t('projects.name')}</span>
                <input
                  value={npName}
                  onChange={(event) => setNpName(event.target.value)}
                  autoFocus
                  placeholder={t('projects.namePlaceholder')}
                  className="rounded-lg border border-white/10 bg-surface-input px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 focus:border-blender/50 focus:outline-none"
                />
              </label>
              <label className="flex flex-col gap-1.5">
                <span className="text-xs font-medium text-zinc-400">{t('projects.blenderVersion')}</span>
                <select
                  value={npInstallId}
                  onChange={(event) => setNpInstallId(event.target.value)}
                  className="rounded-lg border border-white/10 bg-surface-input px-3 py-2 text-sm text-zinc-200 focus:border-blender/50 focus:outline-none"
                >
                  {installedSorted.map((build) => (
                    <option key={build.id} value={build.id}>
                      {t('projects.blenderBuildLabel', {
                        version: build.version,
                        cycle: build.releaseCycle
                      })}
                    </option>
                  ))}
                </select>
              </label>
              <div className="flex flex-col gap-1.5">
                <span className="text-xs font-medium text-zinc-400">{t('projects.location')}</span>
                <div className="flex items-center gap-2">
                  <span
                    className="min-w-0 flex-1 truncate rounded-lg border border-white/10 bg-surface-input px-3 py-2 text-sm text-zinc-400"
                    title={npFolder}
                  >
                    {npFolder || t('projects.noFolderSelected')}
                  </span>
                  <button
                    onClick={pickLocation}
                    className="shrink-0 rounded-lg border border-white/10 px-3 py-2 text-sm font-medium text-zinc-200 transition-colors hover:bg-white/5"
                  >
                    {t('common.browse')}
                  </button>
                </div>
              </div>
              {npError && <p className="text-sm text-red-400">{npError}</p>}
            </div>
            <div className="mt-5 flex justify-end gap-2">
              <button
                onClick={() => setNewProjectOpen(false)}
                disabled={creating}
                className="rounded-lg border border-white/10 px-4 py-1.5 text-sm text-zinc-300 transition-colors hover:bg-white/5 disabled:opacity-50"
              >
                {t('common.cancel')}
              </button>
              <button
                onClick={submitNewProject}
                disabled={creating || !npName.trim() || !npFolder || !npInstallId}
                className="rounded-lg bg-blender px-4 py-1.5 text-sm font-medium text-on-accent transition-colors hover:bg-blender/90 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {creating ? t('projects.creating') : t('projects.create')}
              </button>
            </div>
          </div>
        </div>
      )}

      {renameFor && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
          onClick={() => setRenameFor(null)}
        >
          <div
            className="w-full max-w-sm rounded-xl border border-white/10 bg-surface-dialog p-5 shadow-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <h2 className="text-base font-semibold text-zinc-100">{t('projects.displayName')}</h2>
            <p className="mt-1 truncate text-xs text-zinc-500" title={renameFor.name}>
              {renameFor.name}
            </p>
            <input
              value={renameValue}
              onChange={(event) => setRenameValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') saveDisplayName()
              }}
              autoFocus
              placeholder={t('projects.displayNamePlaceholder')}
              className="mt-3 w-full rounded-lg border border-white/10 bg-surface-input px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 focus:border-blender/50 focus:outline-none"
            />
            <p className="mt-2 text-[11px] text-zinc-500">{t('projects.displayNameHint')}</p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={() => setRenameFor(null)}
                className="rounded-lg border border-white/10 px-4 py-1.5 text-sm text-zinc-300 transition-colors hover:bg-white/5"
              >
                {t('common.cancel')}
              </button>
              <button
                onClick={saveDisplayName}
                className="rounded-lg bg-blender px-4 py-1.5 text-sm font-medium text-on-accent transition-colors hover:bg-blender/90"
              >
                {t('projects.save')}
              </button>
            </div>
          </div>
        </div>
      )}
    </PageLayout>
  )
}

