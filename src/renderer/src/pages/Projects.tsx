import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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
import { CubeIcon, WarningIcon, SearchIcon, RefreshIcon, PlusIcon, ChevronDownIcon, DotsIcon, CheckIcon, GearIcon, PanelLeftIcon } from './projects/icons'
import { fileNameOf, readFlag } from './projects/projects-utils'
import { buildProjectTree, isUnderKey } from './projects/tree'
import FolderTree from './projects/FolderTree'
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

// Tree selection and fold state survive tab switches the same way, but deliberately
// not a launcher restart — no stale paths ever land in ui-state.json.
let treeSelectedSnapshot: string | null = null
let treeExpandedSnapshot: Set<string> | null = null

// Drop flows land on a freshly remounted page; a restored tree filter could hide
// the just-added file, so App clears the snapshot before remounting.
export function clearProjectsTreeSelection(): void {
  treeSelectedSnapshot = null
}

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
  // set only when the menu was summoned by right-click — then it opens at the cursor
  // instead of under the "⋮" button
  const [cardMenuAt, setCardMenuAt] = useState<{ x: number; y: number } | null>(null)
  // single click marks a card; double click is what opens it
  const [selectedCard, setSelectedCard] = useState<string | null>(null)
  const [missingOpen, setMissingOpen] = useState(false)
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
  const [treeVisible, setTreeVisible] = useState(() => readFlag('projects.treeVisible', false))
  const [treeCounts, setTreeCounts] = useState(() => readFlag('projects.treeCounts', false))
  const [treeGuides, setTreeGuides] = useState(() => readFlag('projects.treeGuides', true))
  const [treeSelected, setTreeSelected] = useState<string | null>(treeSelectedSnapshot)
  const [treeExpanded, setTreeExpanded] = useState<Set<string> | null>(treeExpandedSnapshot)

  useEffect(() => {
    uiSet('projects.showDate', showDate ? '1' : '0')
    uiSet('projects.showSize', showSize ? '1' : '0')
    uiSet('projects.showPath', showPath ? '1' : '0')
    uiSet('projects.showVersion', showVersion ? '1' : '0')
    uiSet('projects.cardSize', String(cardSize))
    uiSet('projects.treeVisible', treeVisible ? '1' : '0')
    uiSet('projects.treeCounts', treeCounts ? '1' : '0')
    uiSet('projects.treeGuides', treeGuides ? '1' : '0')
  }, [showDate, showSize, showPath, showVersion, cardSize, treeVisible, treeCounts, treeGuides])

  useEffect(() => {
    treeSelectedSnapshot = treeSelected
    treeExpandedSnapshot = treeExpanded
  }, [treeSelected, treeExpanded])

  // Guarded by a sequence number: optimistic patches (rename/duplicate/delete) kick a
  // background reconcile scan, and a stale response from an earlier scan must not
  // overwrite state that a newer patch or scan already produced.
  const refreshSeqRef = useRef(0)
  const refreshFiles = useCallback(async () => {
    const seq = ++refreshSeqRef.current
    setScanning(true)
    setError(null)
    try {
      // folder availability is re-checked along with the files, so the
      // unavailable-folder banner reacts to a drive coming back or a rescan
      const [freshFolders, fresh] = await Promise.all([
        projectsApi.listFolders(),
        projectsApi.listFiles()
      ])
      if (seq === refreshSeqRef.current) {
        setFolders(freshFolders)
        setFiles(fresh)
      }
    } catch (cause) {
      if (seq === refreshSeqRef.current) setError(cleanErrorMessage(cause))
    } finally {
      if (seq === refreshSeqRef.current) setScanning(false)
    }
  }, [projectsApi])

  // Apply a local edit to the loaded list right away — the full rescan that follows
  // only reconciles, so file operations feel instant.
  const patchFiles = useCallback((updater: (prev: BlendFileInfo[]) => BlendFileInfo[]) => {
    refreshSeqRef.current++
    setFiles((prev) => (prev ? updater(prev) : prev))
  }, [])

  useEffect(() => {
    ;(async () => {
      try {
        setInstalled(await buildsApi.listInstalled())
      } catch {
        // preview mode — the list stays empty
      }
      await refreshFiles()
    })()
  }, [buildsApi, refreshFiles])

  useEffect(() => {
    if (files !== null) lastLoaded = { folders, files, installed }
  }, [folders, files, installed])

  const addFolder = useCallback(async () => {
    try {
      const updated = await projectsApi.addFolder()
      // an active tree filter would hide the new folder's projects
      if (updated.length !== folders.length) setTreeSelected(null)
      setFolders(updated)
      await refreshFiles()
    } catch (cause) {
      await alertDialog(cleanErrorMessage(cause))
    }
  }, [projectsApi, folders.length, refreshFiles, alertDialog])

  const addFile = useCallback(async () => {
    try {
      const added = await projectsApi.addFile()
      if (added) {
        // an active tree filter would hide the just-added file
        setTreeSelected(null)
        await refreshFiles()
      }
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
      // the fresh project may live outside the currently selected tree node
      setTreeSelected(null)
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
        // a missing file has nothing left on disk; an existing one stays there
        message: t(file.missing ? 'projects.removeFromListMessage' : 'projects.untrackFileMessage', {
          name: file.name
        }),
        confirmLabel: t('common.remove')
      })
      if (!ok) return
      try {
        await projectsApi.removeFromList(file.path)
        patchFiles((prev) => prev.filter((known) => known.path !== file.path))
        void refreshFiles()
      } catch (cause) {
        await alertDialog(cleanErrorMessage(cause))
      }
    },
    [projectsApi, refreshFiles, patchFiles, confirmDialog, alertDialog, t]
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
        patchFiles((prev) => prev.filter((known) => known.path !== file.path))
        void refreshFiles()
      } catch (cause) {
        await alertDialog(cleanErrorMessage(cause))
      }
    },
    [projectsApi, refreshFiles, patchFiles, confirmDialog, alertDialog, t]
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

  const duplicateFile = useCallback(
    async (file: BlendFileInfo) => {
      try {
        const copy = await projectsApi.duplicateFile(file.path)
        patchFiles((prev) => {
          const entry: BlendFileInfo = {
            ...file,
            path: copy.path,
            name: fileNameOf(copy.path),
            mtimeMs: copy.mtimeMs,
            size: copy.size
          }
          const index = prev.findIndex((known) => known.path === file.path)
          return index < 0
            ? [...prev, entry]
            : [...prev.slice(0, index + 1), entry, ...prev.slice(index + 1)]
        })
        void refreshFiles()
      } catch (cause) {
        await alertDialog(cleanErrorMessage(cause))
      }
    },
    [projectsApi, refreshFiles, patchFiles, alertDialog]
  )

  const openRename = useCallback((file: BlendFileInfo) => {
    setRenameFor(file)
    setRenameValue(file.name.replace(/\.blend$/i, ''))
  }, [])

  const saveRename = useCallback(async () => {
    if (!renameFor) return
    const trimmed = renameValue.trim()
    if (!trimmed) return
    try {
      const oldPath = renameFor.path
      const renamed = await projectsApi.renameFile(oldPath, trimmed)
      setRenameFor(null)
      patchFiles((prev) =>
        prev.map((known) =>
          known.path === oldPath ? { ...known, path: renamed, name: fileNameOf(renamed) } : known
        )
      )
      void refreshFiles()
    } catch (cause) {
      await alertDialog(cleanErrorMessage(cause))
    }
  }, [renameFor, renameValue, projectsApi, refreshFiles, patchFiles, alertDialog])

  const missingFiles = useMemo(
    () =>
      (files ?? [])
        .filter((file) => file.missing)
        .sort((a, b) => a.name.localeCompare(b.name) || a.path.localeCompare(b.path)),
    [files]
  )
  const missingFolders = useMemo(() => folders.filter((folder) => folder.missing), [folders])

  const removeAllMissing = useCallback(async () => {
    const ok = await confirmDialog({
      title: t('projects.removeAllMissingTitle'),
      message: t('projects.removeAllMissingMessage', { count: missingFiles.length }),
      confirmLabel: t('common.remove')
    })
    if (!ok) return
    try {
      await projectsApi.removeMissing()
      patchFiles((prev) => prev.filter((file) => !file.missing))
      void refreshFiles()
    } catch (cause) {
      await alertDialog(cleanErrorMessage(cause))
    }
  }, [missingFiles.length, projectsApi, refreshFiles, patchFiles, confirmDialog, alertDialog, t])

  const relinkAllMissing = useCallback(async () => {
    try {
      const result = await projectsApi.relinkMissing()
      if (!result) return
      await refreshFiles()
      await alertDialog({
        title: t('projects.relinkDoneTitle'),
        message:
          result.relinked > 0
            ? t('projects.relinkResult', { relinked: result.relinked, total: result.total })
            : t('projects.relinkNoneFound')
      })
    } catch (cause) {
      await alertDialog(cleanErrorMessage(cause))
    }
  }, [projectsApi, refreshFiles, alertDialog, t])

  const relocateMissingFolder = useCallback(
    async (folder: ProjectFolder) => {
      try {
        const updated = await projectsApi.relocateFolder(folder.path)
        if (!updated) return
        setFolders(updated)
        void refreshFiles()
      } catch (cause) {
        await alertDialog(cleanErrorMessage(cause))
      }
    },
    [projectsApi, refreshFiles, alertDialog]
  )

  const removeUnavailableFolder = useCallback(
    async (folder: ProjectFolder) => {
      const ok = await confirmDialog({
        title: t('projects.removeFolderTitle'),
        message: t('projects.removeFolderMessage', { path: folder.path }),
        confirmLabel: t('common.remove')
      })
      if (!ok) return
      try {
        setFolders(await projectsApi.removeFolder(folder.path))
        void refreshFiles()
      } catch (cause) {
        await alertDialog(cleanErrorMessage(cause))
      }
    },
    [projectsApi, refreshFiles, confirmDialog, alertDialog, t]
  )

  const versions = useMemo(() => {
    const present = new Set<string>()
    for (const file of files ?? []) if (file.blenderVersion) present.add(file.blenderVersion)
    // an externally-set filter (from "View projects") must stay selectable in the dropdown
    if (versionFilter !== 'all') present.add(versionFilter)
    return ['all', ...[...present].sort(compareVersionsDesc)]
  }, [files, versionFilter])

  // built from the full live list, not the filtered one — the panel must not
  // reshuffle while a search is being typed
  const tree = useMemo(() => buildProjectTree(files ?? [], folders), [files, folders])

  // Validated synchronously on render — a stale selection must not filter the grid
  // for even a single frame. When compression absorbed the selected folder into a
  // deeper chain node (its last direct file vanished), the selection follows that
  // heir instead of dropping the filter; a node that is really gone falls back to
  // "All projects" — never an inexplicably empty grid.
  const effectiveTreeSelected = useMemo(() => {
    if (!treeSelected || tree.nodeKeys.has(treeSelected)) return treeSelected
    const heirs = [...tree.nodeKeys].filter((key) => isUnderKey(key, treeSelected))
    return heirs.sort((a, b) => a.length - b.length)[0] ?? null
  }, [tree, treeSelected])

  // reconcile the stored value so the module snapshot and future renders agree
  useEffect(() => {
    if (files !== null && effectiveTreeSelected !== treeSelected) {
      setTreeSelected(effectiveTreeSelected)
    }
  }, [files, effectiveTreeSelected, treeSelected])

  // first tree after a fresh start: roots expanded, deeper levels folded
  useEffect(() => {
    if (treeExpanded === null && tree.nodes.length > 0) {
      setTreeExpanded(new Set(tree.nodes.map((node) => node.key)))
    }
  }, [tree, treeExpanded])

  const toggleTreeNode = useCallback((key: string) => {
    setTreeExpanded((prev) => {
      const next = new Set(prev ?? [])
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  // hiding the panel clears the filter — an invisible active filter is exactly
  // the kind of forgotten state this page tries hard not to have
  const toggleTreePanel = useCallback(() => {
    if (treeVisible) setTreeSelected(null)
    setTreeVisible(!treeVisible)
  }, [treeVisible])

  const visibleFiles = useMemo(() => {
    const q = query.trim().toLowerCase()
    // missing files live in the strip above the grid, never among the cards
    return (files ?? []).filter((file) => {
      if (file.missing) return false
      if (effectiveTreeSelected) {
        const key = tree.keyOfFile.get(file.path)
        if (!key || !isUnderKey(key, effectiveTreeSelected)) return false
      }
      if (versionFilter !== 'all' && file.blenderVersion !== versionFilter) return false
      if (q && !file.name.toLowerCase().includes(q)) return false
      return true
    })
  }, [files, tree, effectiveTreeSelected, versionFilter, query])

  const sortedFiles = useMemo(() => {
    const factor = sortDir === 'asc' ? -1 : 1
    return [...visibleFiles].sort((a, b) => {
      let cmp = 0
      if (sortKey === 'name') cmp = b.name.localeCompare(a.name) * factor
      else if (sortKey === 'date') cmp = (b.mtimeMs - a.mtimeMs) * factor
      else if (sortKey === 'size') cmp = (b.size - a.size) * factor
      else {
        // version: files without a detected version always sort last
        if (!a.blenderVersion && !b.blenderVersion) cmp = 0
        else if (!a.blenderVersion) return 1
        else if (!b.blenderVersion) return -1
        else cmp = compareVersionsDesc(a.blenderVersion, b.blenderVersion) * factor
      }
      if (cmp !== 0) return cmp
      // deterministic tiebreaker: with ties left to array order, an optimistic insert
      // and the reconcile scan could place the same card differently (visible jump)
      return a.name.localeCompare(b.name) || a.path.localeCompare(b.path)
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
            className="rounded-lg border border-white/10 p-2 text-icon transition-colors hover:bg-white/10 hover:text-icon-hover disabled:opacity-50"
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
                className="flex items-center gap-1 rounded-lg border border-white/10 px-3 py-1.5 text-sm font-medium text-zinc-200 transition-colors hover:bg-white/10 disabled:opacity-50"
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
              className="block w-full px-3 py-1.5 text-left text-sm text-zinc-300 transition-colors hover:bg-white/10"
            >
              {t('projects.addFolder')}
            </button>
            <button
              onClick={() => {
                setAddMenuOpen(false)
                addFile()
              }}
              className="block w-full px-3 py-1.5 text-left text-sm text-zinc-300 transition-colors hover:bg-white/10"
            >
              {t('projects.addFile')}
            </button>
          </Dropdown>
          <button
            onClick={openNewProject}
            disabled={!isDesktop || noInstalls}
            title={noInstalls ? t('projects.installFirst') : undefined}
            className="flex items-center gap-1 rounded-lg bg-accent-button px-3 py-1.5 text-sm font-medium text-on-accent transition-colors hover:bg-accent-button-hover disabled:cursor-not-allowed disabled:opacity-40"
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
        <div className="flex gap-4">
          {treeVisible && (
            <FolderTree
              nodes={tree.nodes}
              selected={effectiveTreeSelected}
              expanded={treeExpanded ?? new Set()}
              showCounts={treeCounts}
              showGuides={treeGuides}
              onSelect={setTreeSelected}
              onToggle={toggleTreeNode}
            />
          )}
          <div className="flex min-w-0 flex-1 flex-col gap-4">
          {missingFolders.map((folder) => (
            <div
              key={folder.path}
              className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-xl border border-amber-500/30 bg-amber-500/10 px-4 py-3"
            >
              <WarningIcon className="h-5 w-5 shrink-0 text-amber-400" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-amber-300">
                  {t('projects.folderUnavailable', { name: folder.name })}
                </p>
                <p className="truncate text-xs text-amber-200/70" title={folder.path}>
                  {folder.path}
                </p>
                <p className="mt-0.5 text-[11px] text-zinc-400">
                  {t('projects.folderUnavailableHint')}
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <button
                  onClick={() => relocateMissingFolder(folder)}
                  className="rounded-lg bg-accent-button px-3 py-1.5 text-xs font-medium text-on-accent transition-colors hover:bg-accent-button-hover"
                >
                  {t('projects.locateFolder')}
                </button>
                <button
                  onClick={() => removeUnavailableFolder(folder)}
                  className="rounded-lg border border-white/10 px-3 py-1.5 text-xs text-zinc-300 transition-colors hover:bg-white/10"
                >
                  {t('projects.removeFolderAction')}
                </button>
              </div>
            </div>
          ))}

          {missingFiles.length > 0 && (
            <div className="rounded-xl border border-amber-500/30 bg-amber-500/10">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
                <button
                  onClick={() => setMissingOpen((open) => !open)}
                  className="flex min-w-0 flex-1 items-center gap-2 text-left"
                >
                  <WarningIcon className="h-5 w-5 shrink-0 text-amber-400" />
                  <span className="truncate text-sm font-medium text-amber-300">
                    {t('projects.missingCount', { count: missingFiles.length })}
                  </span>
                  <ChevronDownIcon
                    className={`h-3.5 w-3.5 shrink-0 text-amber-400/80 transition-transform ${missingOpen ? 'rotate-180' : ''}`}
                  />
                </button>
                <div className="flex shrink-0 items-center gap-2">
                  <button
                    onClick={relinkAllMissing}
                    className="flex items-center gap-1.5 rounded-lg border border-white/10 px-3 py-1.5 text-xs text-zinc-200 transition-colors hover:bg-white/10"
                  >
                    <SearchIcon className="h-3.5 w-3.5" />
                    {t('projects.relinkInFolder')}
                  </button>
                  <button
                    onClick={removeAllMissing}
                    className="rounded-lg border border-white/10 px-3 py-1.5 text-xs text-zinc-200 transition-colors hover:bg-white/10"
                  >
                    {t('projects.removeAllMissing')}
                  </button>
                </div>
              </div>
              {missingOpen && (
                <div className="max-h-64 overflow-y-auto border-t border-amber-500/20 p-1.5">
                  {missingFiles.map((file) => (
                    <div
                      key={file.path}
                      className="flex items-center gap-3 rounded-lg px-2.5 py-1.5 transition-colors hover:bg-white/5"
                    >
                      <div className="min-w-0 flex-1">
                        <p className="truncate text-sm text-zinc-200">
                          {file.name.replace(/\.blend$/i, '')}
                        </p>
                        <p className="truncate text-[11px] text-zinc-500" title={file.path}>
                          {file.path}
                        </p>
                      </div>
                      <button
                        onClick={() => findMissing(file)}
                        className="shrink-0 rounded-lg border border-white/10 px-2.5 py-1 text-xs text-zinc-200 transition-colors hover:bg-white/10"
                      >
                        {t('projects.findFile')}
                      </button>
                      <button
                        onClick={() => removeFromList(file)}
                        className="shrink-0 rounded-lg border border-white/10 px-2.5 py-1 text-xs text-zinc-400 transition-colors hover:bg-white/10 hover:text-zinc-200"
                      >
                        {t('projects.removeFromList')}
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          <div className="flex flex-wrap items-end gap-2">
            <button
              title={t('projects.treeToggle')}
              onClick={toggleTreePanel}
              className={`self-end rounded-lg border border-white/10 p-1.5 transition-colors hover:bg-white/10 ${
                treeVisible ? 'bg-white/10 text-icon-selected' : 'text-icon hover:text-icon-hover'
              }`}
            >
              <PanelLeftIcon className="h-4 w-4" />
            </button>
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
                    className="rounded-lg border border-white/10 p-1.5 text-icon transition-colors hover:bg-white/10 hover:text-icon-hover"
                  >
                    <GearIcon className="h-4 w-4" />
                  </button>
                }
              >
                <p className="px-2 py-1 text-[11px] font-medium uppercase tracking-wide text-zinc-500">
                  {t('projects.showOnCards')}
                </p>
                <label className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm text-zinc-300 transition-colors hover:bg-white/10">
                  <input
                    type="checkbox"
                    checked={showDate}
                    onChange={(event) => setShowDate(event.target.checked)}
                    className="accent-blender"
                  />
                  {t('projects.date')}
                </label>
                <label className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm text-zinc-300 transition-colors hover:bg-white/10">
                  <input
                    type="checkbox"
                    checked={showSize}
                    onChange={(event) => setShowSize(event.target.checked)}
                    className="accent-blender"
                  />
                  {t('projects.fileSize')}
                </label>
                <label className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm text-zinc-300 transition-colors hover:bg-white/10">
                  <input
                    type="checkbox"
                    checked={showPath}
                    onChange={(event) => setShowPath(event.target.checked)}
                    className="accent-blender"
                  />
                  {t('projects.path')}
                </label>
                <label className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm text-zinc-300 transition-colors hover:bg-white/10">
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
                  {t('projects.treeToggle')}
                </p>
                <label className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm text-zinc-300 transition-colors hover:bg-white/10">
                  <input
                    type="checkbox"
                    checked={treeCounts}
                    onChange={(event) => setTreeCounts(event.target.checked)}
                    className="accent-blender"
                  />
                  {t('projects.treeFileCounts')}
                </label>
                <label className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm text-zinc-300 transition-colors hover:bg-white/10">
                  <input
                    type="checkbox"
                    checked={treeGuides}
                    onChange={(event) => setTreeGuides(event.target.checked)}
                    className="accent-blender"
                  />
                  {t('projects.treeGuides')}
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

          {files !== null && files.length - missingFiles.length === 0 && !scanning ? (
            // nothing but missing entries or an unavailable folder — the strip and
            // banner above already explain the situation, a "no files" line would lie
            missingFiles.length === 0 && missingFolders.length === 0 ? (
              <p className="text-sm text-zinc-500">{t('projects.noBlendFiles')}</p>
            ) : null
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
                    className={`group relative flex cursor-pointer flex-col rounded-xl border transition-all duration-150 ${
                      selectedCard === file.path
                        ? 'border-card-outline bg-card-hover shadow-lg shadow-black/40 ring-1 ring-card-outline/40'
                        : 'border-white/5 bg-surface-panel hover:border-card-outline/40 hover:bg-card-hover hover:shadow-lg hover:shadow-black/40'
                    }`}
                    onClick={() => setSelectedCard(file.path)}
                    onDoubleClick={() => {
                      if (selected) requestOpen(file, selected)
                    }}
                    onContextMenu={(event) => {
                      event.preventDefault()
                      setSelectedCard(file.path)
                      setCardMenuAt({ x: event.clientX, y: event.clientY })
                      setCardMenuFor(file.path)
                    }}
                  >
                    {/* the version to open with, over the thumbnail: picking one here is the
                        only version control on the card now that Open is gone */}
                    {showVersion && (
                      <div className="absolute left-2 top-2 z-10 flex items-center gap-1">
                        <Dropdown
                          open={menuFor === file.path}
                          onClose={() => setMenuFor(null)}
                          align="left"
                          menuClassName="flex max-h-64 flex-col overflow-hidden rounded-lg border border-white/10 bg-surface-menu py-1 shadow-xl"
                          trigger={
                            <button
                              onClick={() => setMenuFor(menuFor === file.path ? null : file.path)}
                              disabled={installedSorted.length === 0}
                              title={t('projects.chooseVersion')}
                              // py-1 + leading-4 gives the same 16px line box the "⋮" gets
                              // from its icon, so both corners of the card match in height
                              className="flex items-center gap-1 rounded-lg border border-white/10 bg-surface-card/80 px-2 py-1 text-[11px] font-semibold leading-4 text-foreground backdrop-blur-sm transition-colors hover:bg-surface-card disabled:cursor-not-allowed disabled:opacity-40"
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
                                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-zinc-300 transition-colors hover:bg-white/10"
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
                        {mismatch && (
                          <span
                            title={t('projects.versionMismatch', {
                              fileVersion: file.blenderVersion ?? '—',
                              selectedVersion: selected?.version ?? ''
                            })}
                            className="flex items-center rounded-lg border border-white/10 bg-surface-card/80 p-1 text-amber-400 backdrop-blur-sm"
                          >
                            <WarningIcon className="h-4 w-4" />
                          </span>
                        )}
                      </div>
                    )}
                    <Dropdown
                      className="absolute right-2 top-2 z-10"
                      open={cardMenuFor === file.path}
                      onClose={() => setCardMenuFor(null)}
                      align={cardMenuAt ? 'left' : 'right'}
                      at={cardMenuFor === file.path ? cardMenuAt : null}
                      menuClassName="min-w-52 overflow-hidden rounded-lg border border-white/10 bg-surface-menu py-1 text-sm shadow-xl"
                      trigger={
                        <button
                          onClick={() => {
                            // button press keeps the old behaviour: anchored under it
                            setCardMenuAt(null)
                            setCardMenuFor(cardMenuFor === file.path ? null : file.path)
                          }}
                          title={t('projects.moreActions')}
                          className="rounded-lg border border-white/10 bg-surface-card/80 p-1 text-icon backdrop-blur-sm transition-colors hover:bg-surface-card hover:text-icon-hover"
                        >
                          <DotsIcon className="h-4 w-4" />
                        </button>
                      }
                    >
                      <button
                        onClick={() => {
                          setCardMenuFor(null)
                          projectsApi.reveal(file.path).catch(() => undefined)
                        }}
                        className="block w-full px-3 py-1.5 text-left text-zinc-300 transition-colors hover:bg-white/10"
                      >
                        {t('projects.showInFolder')}
                      </button>
                      <button
                        onClick={() => {
                          setCardMenuFor(null)
                          openRename(file)
                        }}
                        className="block w-full px-3 py-1.5 text-left text-zinc-300 transition-colors hover:bg-white/10"
                      >
                        {t('projects.renameFile')}
                      </button>
                      <button
                        onClick={() => {
                          setCardMenuFor(null)
                          duplicateFile(file)
                        }}
                        className="block w-full px-3 py-1.5 text-left text-zinc-300 transition-colors hover:bg-white/10"
                      >
                        {t('projects.duplicateFile')}
                      </button>
                      <button
                        onClick={() => {
                          setCardMenuFor(null)
                          changePreview(file)
                        }}
                        className="block w-full px-3 py-1.5 text-left text-zinc-300 transition-colors hover:bg-white/10"
                      >
                        {t('projects.changePreviewImage')}
                      </button>
                      {file.hasCustomPreview && (
                        <button
                          onClick={() => {
                            setCardMenuFor(null)
                            resetPreview(file)
                          }}
                          className="block w-full px-3 py-1.5 text-left text-zinc-300 transition-colors hover:bg-white/10"
                        >
                          {t('projects.resetPreview')}
                        </button>
                      )}
                      <button
                        onClick={() => {
                          setCardMenuFor(null)
                          relocateProject(file)
                        }}
                        className="block w-full px-3 py-1.5 text-left text-zinc-300 transition-colors hover:bg-white/10"
                      >
                        {t('projects.moveProject')}
                      </button>
                      {file.tracked && (
                        <button
                          onClick={() => {
                            setCardMenuFor(null)
                            removeFromList(file)
                          }}
                          className="block w-full px-3 py-1.5 text-left text-zinc-300 transition-colors hover:bg-white/10"
                        >
                          {t('projects.removeFromList')}
                        </button>
                      )}
                      <div className="my-1 border-t border-white/5" />
                      <button
                        onClick={() => {
                          setCardMenuFor(null)
                          deleteProjectFile(file)
                        }}
                        className="block w-full px-3 py-1.5 text-left text-red-400 transition-colors hover:bg-red-500/10"
                      >
                        {t('projects.deleteFile')}
                      </button>
                    </Dropdown>
                    <div className="flex aspect-[4/3] items-center justify-center overflow-hidden rounded-t-xl bg-surface-inset">
                      {file.thumbnail ? (
                        <img
                          src={file.thumbnail}
                          alt=""
                          className="h-full w-full object-cover transition-transform duration-200 group-hover:scale-105"
                          draggable={false}
                        />
                      ) : (
                        <CubeIcon className="h-10 w-10 text-zinc-700" />
                      )}
                    </div>
                    <div className="flex flex-1 flex-col gap-2 p-3">
                      <p
                        className="min-w-0 truncate text-sm font-medium text-zinc-100"
                        title={file.path}
                      >
                        {file.name.replace(/\.blend$/i, '')}
                      </p>
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
                    </div>
                  </div>
                )
              })}
            </div>
          )}
          </div>
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
                    className="shrink-0 rounded-lg border border-white/10 px-3 py-2 text-sm font-medium text-zinc-200 transition-colors hover:bg-white/10"
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
                className="rounded-lg border border-white/10 px-4 py-1.5 text-sm text-zinc-300 transition-colors hover:bg-white/10 disabled:opacity-50"
              >
                {t('common.cancel')}
              </button>
              <button
                onClick={submitNewProject}
                disabled={creating || !npName.trim() || !npFolder || !npInstallId}
                className="rounded-lg bg-accent-button px-4 py-1.5 text-sm font-medium text-on-accent transition-colors hover:bg-accent-button-hover disabled:cursor-not-allowed disabled:opacity-40"
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
            <h2 className="text-base font-semibold text-zinc-100">{t('projects.renameTitle')}</h2>
            <p className="mt-1 truncate text-xs text-zinc-500" title={renameFor.name}>
              {renameFor.name}
            </p>
            <input
              value={renameValue}
              onChange={(event) => setRenameValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') saveRename()
              }}
              autoFocus
              className="mt-3 w-full rounded-lg border border-white/10 bg-surface-input px-3 py-2 text-sm text-zinc-200 placeholder:text-zinc-600 focus:border-blender/50 focus:outline-none"
            />
            <p className="mt-2 text-[11px] text-zinc-500">{t('projects.renameHint')}</p>
            <div className="mt-4 flex justify-end gap-2">
              <button
                onClick={() => setRenameFor(null)}
                className="rounded-lg border border-white/10 px-4 py-1.5 text-sm text-zinc-300 transition-colors hover:bg-white/10"
              >
                {t('common.cancel')}
              </button>
              <button
                onClick={saveRename}
                disabled={!renameValue.trim()}
                className="rounded-lg bg-accent-button px-4 py-1.5 text-sm font-medium text-on-accent transition-colors hover:bg-accent-button-hover disabled:cursor-not-allowed disabled:opacity-40"
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

