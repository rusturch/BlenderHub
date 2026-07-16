import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import PageLayout from '../components/PageLayout'
import Dropdown from '../components/Dropdown'
import { FilterSelect } from '../components/FilterSelect'
import { useDialog } from '../components/Dialog'
import { FolderIcon } from '../components/Sidebar'
import SyncOfferDialog from '../components/SyncOfferDialog'
import { cleanErrorMessage, formatBytes, formatDate } from '../lib/format'
import { useTranslation } from '../lib/i18n'
import { getLauncherApi } from '../lib/preview-fallback'
import { uiGet, uiSet } from '../lib/ui-store'
import { minorOf } from '../../../shared/blender-archive'
import { compareVersionsDesc, isSameBuild, isUpdateFor } from '../../../shared/blender-builds'
import type { BlendFileInfo, InstalledBuild, InstallProgress, RemoteBuild } from '../../../shared/types'
import { CycleBadge, ProgressLine } from './installs/cells'
import { FILTER_LABEL_KEYS } from './installs/constants'
import { FolderOpenIcon, GearIcon, InfoIcon, RefreshIcon, TrashIcon } from './installs/icons'
import { installedIdentityKey, locateWithDedup, notesUrlForRow, releaseDateOfRow } from './installs/installs-utils'
import type { DisplayRow } from './installs/types'

export default function InstallsPage({
  onShowProjects,
  initialSearch
}: {
  onShowProjects?: (version: string) => void
  initialSearch?: string
}) {
  const { api, isDesktop } = getLauncherApi()
  const buildsApi = api.builds
  const projectsApi = api.projects
  const { confirm: confirmDialog, alert: alertDialog } = useDialog()
  const { t } = useTranslation()
  const [remote, setRemote] = useState<RemoteBuild[] | null>(null)
  const [remoteError, setRemoteError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [installed, setInstalled] = useState<InstalledBuild[]>([])
  const [filter, setFilter] = useState<string>('all')
  const [query, setQuery] = useState(initialSearch ?? '')
  const [sortKey, setSortKey] = useState<'version' | 'date'>('version')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')
  const [locating, setLocating] = useState(false)
  const [projectFiles, setProjectFiles] = useState<BlendFileInfo[]>([])
  const [projectsPopoverFor, setProjectsPopoverFor] = useState<string | null>(null)
  const [progressById, setProgressById] = useState<Record<string, InstallProgress>>({})
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [showBranch, setShowBranch] = useState(() => uiGet('installs.showBranch') !== '0')
  const [installedFilter, setInstalledFilter] = useState<'all' | 'installed' | 'not-installed'>(
    () => (uiGet('installs.installedFilter') as 'all' | 'installed' | 'not-installed' | undefined) ?? 'all'
  )
  const [syncOffers, setSyncOffers] = useState<
    { minor: string; version: string; settingsSource: string | null; sourceOptions: string[] }[]
  >([])
  const installedRef = useRef<InstalledBuild[]>([])

  useEffect(() => {
    uiSet('installs.showBranch', showBranch ? '1' : '0')
  }, [showBranch])

  useEffect(() => {
    uiSet('installs.installedFilter', installedFilter)
  }, [installedFilter])

  const refreshInstalled = useCallback(async (): Promise<InstalledBuild[]> => {
    if (!buildsApi) return installedRef.current
    try {
      const fresh = await buildsApi.listInstalled()
      installedRef.current = fresh
      setInstalled(fresh)
      return fresh
    } catch {
      return installedRef.current
    }
  }, [buildsApi])

  // Offered once, right when the FIRST build of a major.minor the launcher didn't
  // know about before shows up — that version starts with zero Blender preferences
  // and add-ons. Settings come from the Sync page's "Source"; the add-on set's
  // origin is picked INSIDE the dialog (default set or a concrete version) from the
  // versions that existed before this install. Nothing to pick from and no Sync
  // source → nothing to offer.
  const offerSyncForNewMinors = useCallback(
    async (before: InstalledBuild[], fresh: InstalledBuild[]) => {
      const beforeMinors = new Set(before.map((build) => minorOf(build.version)))
      const newest = new Map<string, InstalledBuild>()
      for (const build of fresh) {
        const minor = minorOf(build.version)
        if (beforeMinors.has(minor)) continue
        const existing = newest.get(minor)
        if (!existing || compareVersionsDesc(build.version, existing.version) < 0) newest.set(minor, build)
      }
      if (newest.size === 0) return
      let settingsSource: string | null = null
      try {
        const cached = await api.settingsSync.getCached()
        const data = cached ?? (await api.settingsSync.scan())
        settingsSource = data.links.sourceMinor ?? null
      } catch {
        // no Sync data yet, or the scan failed — the settings part just isn't offered
      }
      const sourceOptions = [...beforeMinors].sort(compareVersionsDesc)
      if (!settingsSource && sourceOptions.length === 0) return
      setSyncOffers((queue) => [
        ...queue,
        ...[...newest.values()].map((build) => ({
          minor: minorOf(build.version),
          version: build.version,
          settingsSource,
          sourceOptions
        }))
      ])
    },
    [api]
  )

  const refreshProjectFiles = useCallback(async () => {
    try {
      setProjectFiles(await projectsApi.listFiles())
    } catch {
      // preview mode or scan failure — chips just stay hidden
    }
  }, [projectsApi])

  const refreshRemote = useCallback(
    async (force = false) => {
      if (!buildsApi) return
      setRefreshing(true)
      setRemoteError(null)
      try {
        setRemote(await buildsApi.listRemote(force))
      } catch (error) {
        setRemoteError(cleanErrorMessage(error))
      } finally {
        setRefreshing(false)
      }
    },
    [buildsApi]
  )

  useEffect(() => {
    refreshInstalled()
    refreshRemote()
    refreshProjectFiles()
    if (!buildsApi) return
    // refreshProjectFiles is intentionally not in deps — it is stable like the others
    return buildsApi.onInstallProgress((progress) => {
      setProgressById((previous) => ({ ...previous, [progress.buildId]: progress }))
      if (progress.phase === 'done') {
        const before = installedRef.current
        refreshInstalled().then((fresh) => offerSyncForNewMinors(before, fresh))
        setTimeout(() => {
          setProgressById((previous) => {
            const { [progress.buildId]: _finished, ...rest } = previous
            return rest
          })
        }, 4000)
      }
    })
  }, [buildsApi, refreshInstalled, refreshRemote, refreshProjectFiles, offerSyncForNewMinors])

  const startInstall = useCallback(
    async (build: RemoteBuild) => {
      if (!buildsApi) return
      // one copy of an exact build is enough — block a duplicate add with a warning.
      // (a new commit of a rolling build is NOT isSameBuild, so it still installs/replaces)
      const already = installed.some((entry) => entry.remoteId === build.id || isSameBuild(entry, build))
      if (already) {
        await alertDialog(
          t('installs.alreadyInstalled', { version: build.version, cycle: build.releaseCycle })
        )
        return
      }
      setProgressById((previous) => ({
        ...previous,
        [build.id]: { buildId: build.id, phase: 'downloading', receivedBytes: 0, totalBytes: build.fileSize }
      }))
      try {
        await buildsApi.install(build.id)
      } catch (error) {
        setProgressById((previous) => ({
          ...previous,
          [build.id]: { buildId: build.id, phase: 'error', error: cleanErrorMessage(error) }
        }))
      }
    },
    [buildsApi, installed, alertDialog, t]
  )

  const removeInstall = useCallback(
    async (build: InstalledBuild) => {
      if (!buildsApi) return
      const ok = await confirmDialog({
        title: build.managed ? t('installs.confirmUninstallTitle') : t('installs.confirmRemoveTitle'),
        message: build.managed
          ? t('installs.confirmUninstallMessage', { version: build.version, cycle: build.releaseCycle })
          : t('installs.confirmRemoveMessage', { version: build.version }),
        variant: build.managed ? 'danger' : 'none',
        tone: build.managed ? 'danger' : 'default',
        confirmLabel: build.managed ? t('installs.uninstall') : t('common.remove')
      })
      if (!ok) return
      try {
        await buildsApi.uninstall(build.id)
      } catch (error) {
        await alertDialog(cleanErrorMessage(error))
      }
      refreshInstalled()
    },
    [buildsApi, refreshInstalled, confirmDialog, alertDialog, t]
  )

  const locateExisting = useCallback(async () => {
    setLocating(true)
    try {
      const before = installedRef.current
      // the duplicate guard lives in locateWithDedup — shared with the Sync page
      const outcome = await locateWithDedup(buildsApi, before)
      if (outcome) {
        const { added, skippedDuplicates: duplicates } = outcome
        // an empty list means the builds sit in the installs folder and get
        // adopted automatically — refreshing the list picks them up too
        const fresh = await refreshInstalled()
        offerSyncForNewMinors(before, fresh)
        if (duplicates.length > 0) {
          const names = duplicates
            .map((build) => t('installs.buildName', { version: build.version, cycle: build.releaseCycle }))
            .join(', ')
          await alertDialog(
            added.length > 0
              ? t('installs.locateAddedSomeSkipped', { count: added.length, names })
              : t('installs.locateAllSkipped', { names })
          )
        } else if (added.length > 1) {
          await alertDialog(t('installs.locateAdded', { count: added.length }))
        }
      }
    } catch (error) {
      await alertDialog(cleanErrorMessage(error))
    } finally {
      setLocating(false)
    }
  }, [buildsApi, refreshInstalled, alertDialog, offerSyncForNewMinors, t])

  const filters = useMemo(() => {
    const dailyCycles = new Set(
      (remote ?? []).filter((build) => build.source === 'daily').map((build) => build.releaseCycle)
    )
    const cycleTabs = ['stable', 'candidate', 'rc', 'beta', 'alpha'].filter((cycle) => dailyCycles.has(cycle))
    return ['all', ...cycleTabs, 'experimental', 'archive']
  }, [remote])

  const copiesForRemote = useCallback(
    (build: RemoteBuild): InstalledBuild[] =>
      installed.filter((entry) => entry.remoteId === build.id || isSameBuild(entry, build)),
    [installed]
  )

  // installed builds the catalog no longer (or never did) list — an old archive patch
  // once a newer one becomes "the" archive entry, an unusual Located version, etc.
  // Grouped by identity so several copies of the very same orphaned build share one row.
  const orphanGroups = useMemo(() => {
    const claimed = new Set<string>()
    for (const build of remote ?? []) {
      for (const entry of installed) {
        if (entry.remoteId === build.id || isSameBuild(entry, build)) claimed.add(entry.id)
      }
    }
    const groups = new Map<string, InstalledBuild[]>()
    for (const entry of installed) {
      if (claimed.has(entry.id)) continue
      const key = installedIdentityKey(entry)
      const list = groups.get(key) ?? []
      list.push(entry)
      groups.set(key, list)
    }
    return groups
  }, [remote, installed])

  const mergedVisible = useMemo(() => {
    const q = query.trim().toLowerCase()
    const matchesQuery = (version: string, branch: string, cycle: string, commit: string): boolean =>
      !q ||
      version.toLowerCase().includes(q) ||
      branch.toLowerCase().includes(q) ||
      cycle.toLowerCase().includes(q) ||
      commit.toLowerCase().includes(q)

    const rows: DisplayRow[] = []

    // A not-yet-installed catalog build that supersedes installed copies gets no
    // "Install" row — it rides on those copies' rows as an Update button instead.
    const claimed = new Set<string>()
    for (const build of remote ?? []) {
      for (const copy of copiesForRemote(build)) claimed.add(copy.id)
    }
    const updateByCopyId = new Map<string, RemoteBuild>()
    for (const build of remote ?? []) {
      if (copiesForRemote(build).length > 0) continue
      for (const entry of installed) {
        if (claimed.has(entry.id) || !isUpdateFor(build, entry)) continue
        const known = updateByCopyId.get(entry.id)
        const cmp = known ? compareVersionsDesc(build.version, known.version) : 0
        if (!known || cmp < 0 || (cmp === 0 && build.fileMtime > known.fileMtime)) {
          updateByCopyId.set(entry.id, build)
        }
      }
    }

    for (const build of remote ?? []) {
      // PR builds (patch) are special-interest — they live under Experimental only
      const matchesTab =
        filter === 'all'
          ? build.source !== 'patch'
          : filter === 'experimental'
            ? build.source === 'experimental' || build.source === 'patch'
            : filter === 'archive'
              ? build.source === 'archive'
              : build.source === 'daily' && build.releaseCycle === filter
      if (!matchesTab || !matchesQuery(build.version, build.branch, build.releaseCycle, build.commit)) continue
      const copies = copiesForRemote(build)
      if (copies.length === 0) {
        // outdated copies carry this build as their Update button (rendered by the
        // orphan pass below, under All + their own cycle tab) — no "Install" row
        // wherever such a copy is visible, so the line shows up exactly once
        const supersededVisible = installed.some(
          (entry) =>
            updateByCopyId.get(entry.id)?.id === build.id &&
            (filter === 'all' || filter === entry.releaseCycle)
        )
        if (supersededVisible) continue
        // not installed yet → a single "Install" row
        rows.push({
          key: `remote:${build.id}`,
          version: build.version,
          releaseCycle: build.releaseCycle,
          branch: build.branch,
          commit: build.commit,
          remoteBuild: build,
          update: null,
          copy: null
        })
      } else {
        // installed in one or more folders → one row per copy (separate positions)
        for (const copy of copies) {
          rows.push({
            key: `copy:${copy.id}`,
            version: copy.version,
            releaseCycle: copy.releaseCycle,
            branch: copy.branch ?? '',
            commit: copy.commit ?? '',
            remoteBuild: build,
            update: null,
            copy
          })
        }
      }
    }

    for (const copies of orphanGroups.values()) {
      const rep = copies[0]
      // unknown original source (archive/daily/experimental) — only ever shown under
      // All and its own cycle tab, never Experimental/Archive specifically
      const matchesTab = filter === 'all' || filter === rep.releaseCycle
      if (!matchesTab || !matchesQuery(rep.version, rep.branch ?? '', rep.releaseCycle, rep.commit ?? '')) continue
      for (const copy of copies) {
        rows.push({
          key: `copy:${copy.id}`,
          version: copy.version,
          releaseCycle: copy.releaseCycle,
          branch: copy.branch ?? '',
          commit: copy.commit ?? '',
          remoteBuild: null,
          update: updateByCopyId.get(copy.id) ?? null,
          copy
        })
      }
    }

    const byInstalled =
      installedFilter === 'all'
        ? rows
        : rows.filter((row) => (installedFilter === 'installed' ? row.copy !== null : row.copy === null))
    // copies of the same version (equal under the chosen key) keep a stable order by path
    const factor = sortDir === 'asc' ? -1 : 1
    byInstalled.sort((a, b) => {
      const primary =
        sortKey === 'date'
          ? (releaseDateOfRow(b) - releaseDateOfRow(a)) * factor
          : compareVersionsDesc(a.version, b.version) * factor
      return primary || (a.copy?.path ?? '').localeCompare(b.copy?.path ?? '')
    })
    return byInstalled
  }, [remote, installed, filter, query, installedFilter, sortKey, sortDir, copiesForRemote, orphanGroups])

  const projectsByMinor = useMemo(() => {
    const map = new Map<string, BlendFileInfo[]>()
    for (const file of projectFiles) {
      if (file.missing || !file.blenderVersion) continue
      const list = map.get(file.blenderVersion) ?? []
      list.push(file)
      map.set(file.blenderVersion, list)
    }
    return map
  }, [projectFiles])

  // badge column hugs the widest version string in view
  const longestVersion = useMemo(
    () => mergedVisible.reduce((longest, row) => (row.version.length > longest.length ? row.version : longest), ''),
    [mergedVisible]
  )

  return (
    <>
    <PageLayout
      title={t('installs.title')}
      actions={
        <div className="flex items-center gap-2">
          <button
            onClick={() => {
              refreshRemote(true)
              refreshInstalled()
              refreshProjectFiles()
            }}
            disabled={refreshing}
            title={t('installs.refreshHint')}
            className="rounded-lg border border-white/10 p-2 text-zinc-400 transition-colors hover:bg-white/5 hover:text-zinc-200 disabled:opacity-50"
          >
            <RefreshIcon className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
          </button>
          <button
            onClick={locateExisting}
            disabled={locating || !isDesktop}
            title={isDesktop ? t('installs.locateHint') : t('installs.desktopOnly')}
            className="rounded-lg border border-white/10 px-3 py-1.5 text-sm font-medium text-zinc-300 transition-colors hover:bg-white/5 disabled:opacity-50"
          >
            {locating ? t('installs.locating') : t('installs.locate')}
          </button>
        </div>
      }
    >
      <div className="flex flex-col gap-6">
        {!isDesktop && (
          <div className="rounded-xl border border-sky-500/20 bg-sky-500/5 px-4 py-3 text-xs leading-relaxed text-sky-300">
            {t('installs.previewBanner')}
          </div>
        )}
        <section>
          <div className="mb-3 flex flex-wrap items-end gap-2">
            <FilterSelect
              label={t('installs.sort')}
              value={sortKey}
              onChange={setSortKey}
              options={[
                { value: 'date', label: t('installs.sortDate') },
                { value: 'version', label: t('installs.sortVersion') }
              ]}
            />
            <FilterSelect
              label={t('installs.order')}
              value={sortDir}
              onChange={setSortDir}
              options={[
                { value: 'desc', label: t('installs.descending') },
                { value: 'asc', label: t('installs.ascending') }
              ]}
            />
            <FilterSelect
              label={t('installs.installedFilterLabel')}
              value={installedFilter}
              onChange={setInstalledFilter}
              options={[
                { value: 'all', label: t('installs.installedAll') },
                { value: 'installed', label: t('installs.installedOnly') },
                { value: 'not-installed', label: t('installs.notInstalledOnly') }
              ]}
              width="w-32"
            />
            <div className="ml-auto flex items-end gap-2 self-end">
              <input
                type="search"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t('installs.searchPlaceholder')}
                className="w-44 rounded-lg border border-white/10 bg-transparent px-3 py-1.5 text-xs text-zinc-200 placeholder:text-zinc-600 focus:border-blender/50 focus:outline-none"
              />
              <Dropdown
                open={settingsOpen}
                onClose={() => setSettingsOpen(false)}
                align="right"
                menuClassName="w-48 rounded-lg border border-white/10 bg-[#212121] p-1 shadow-xl"
                trigger={
                  <button
                    title={t('installs.displaySettings')}
                    onClick={() => setSettingsOpen((open) => !open)}
                    className="rounded-lg border border-white/10 p-1.5 text-zinc-400 transition-colors hover:bg-white/5 hover:text-zinc-200"
                  >
                    <GearIcon className="h-4 w-4" />
                  </button>
                }
              >
                <p className="px-2 py-1 text-[11px] font-medium uppercase tracking-wide text-zinc-500">
                  {t('installs.show')}
                </p>
                <label className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm text-zinc-300 transition-colors hover:bg-white/5">
                  <input
                    type="checkbox"
                    checked={showBranch}
                    onChange={(event) => setShowBranch(event.target.checked)}
                    className="accent-blender"
                  />
                  {t('installs.branch')}
                </label>
              </Dropdown>
            </div>
          </div>
          <div className="mb-3 flex flex-wrap gap-1">
            {filters.map((tab) => (
              <button
                key={tab}
                onClick={() => setFilter(tab)}
                className={`rounded-full px-3 py-1 text-xs font-medium capitalize transition-colors ${
                  filter === tab
                    ? 'bg-blender/15 text-blender'
                    : 'text-zinc-500 hover:bg-white/5 hover:text-zinc-300'
                }`}
              >
                {t(FILTER_LABEL_KEYS[tab] ?? tab)}
              </button>
            ))}
          </div>

          {remoteError ? (
            <div className="flex items-center justify-between rounded-xl border border-red-500/20 bg-red-500/5 px-4 py-3">
              <p className="text-sm text-red-400">{remoteError}</p>
              <button
                onClick={() => refreshRemote(true)}
                className="rounded-lg border border-red-500/30 px-3 py-1 text-xs font-medium text-red-300 hover:bg-red-500/10"
              >
                {t('common.retry')}
              </button>
            </div>
          ) : remote === null ? (
            <p className="text-sm text-zinc-500">{t('installs.loadingBuilds')}</p>
          ) : mergedVisible.length === 0 ? (
            <p className="text-sm text-zinc-500">
              {query.trim()
                ? t('installs.noSearchMatches')
                : filter === 'experimental'
                  ? t('installs.noExperimentalBuilds')
                  : t('installs.noFilterMatches')}
            </p>
          ) : (
            <div className="overflow-hidden rounded-xl border border-white/5">
              {mergedVisible.map((row, index) => {
                const copy = row.copy
                const isInstalled = copy !== null
                const progressSource = row.remoteBuild ?? row.update
                const progress = progressSource ? progressById[progressSource.id] : undefined
                const inFlight = progress !== undefined && progress.phase !== 'error' && progress.phase !== 'done'
                const notesUrl = notesUrlForRow(row)
                const branchMeta = showBranch
                  ? [row.branch, row.commit ? row.commit.slice(0, 10) : ''].filter(Boolean).join(' · ')
                  : ''
                const sizeDate = row.remoteBuild
                  ? [
                      formatBytes(row.remoteBuild.fileSize),
                      row.remoteBuild.fileMtime > 0 ? formatDate(row.remoteBuild.fileMtime) : ''
                    ]
                      .filter(Boolean)
                      .join(' · ')
                  : ''
                const usedBy = projectsByMinor.get(minorOf(row.version)) ?? []
                const projectsOpen = projectsPopoverFor === row.key
                return (
                  <div
                    key={row.key}
                    className={`flex items-center gap-4 bg-[#131313] px-4 py-3 ${index > 0 ? 'border-t border-white/5' : ''}`}
                  >
                    <div className="w-56 shrink-0">
                      <div className="flex items-center gap-2">
                        <span
                          className={`h-1.5 w-1.5 shrink-0 rounded-full ${isInstalled ? 'bg-emerald-400' : 'bg-transparent'}`}
                          title={isInstalled ? t('installs.installed') : undefined}
                        />
                        <span className="relative shrink-0 text-sm font-semibold text-zinc-100">
                          <span className="invisible">{longestVersion}</span>
                          <span className="absolute inset-y-0 left-0">{row.version}</span>
                        </span>
                        <CycleBadge cycle={row.releaseCycle} />
                        {isInstalled && (
                          <Dropdown
                            className="shrink-0"
                            open={projectsOpen}
                            onClose={() => setProjectsPopoverFor(null)}
                            align="left"
                            menuClassName="w-64 rounded-lg border border-white/10 bg-[#212121] p-2 shadow-xl"
                            trigger={
                              <button
                                onClick={() => setProjectsPopoverFor(projectsOpen ? null : row.key)}
                                className="flex items-center gap-1 rounded bg-white/10 px-1.5 py-0.5 text-[10px] font-semibold text-zinc-300 transition-colors hover:bg-white/20"
                              >
                                <FolderIcon className="h-3 w-3" />
                                {t(
                                  usedBy.length === 1
                                    ? 'installs.projectCountOne'
                                    : 'installs.projectCountMany',
                                  { count: usedBy.length }
                                )}
                              </button>
                            }
                          >
                            <p className="px-2 pb-1 text-[11px] font-medium text-zinc-400">
                              {usedBy.length === 0
                                ? t('installs.noProjectsUseVersion')
                                : t(usedBy.length === 1 ? 'installs.usedByOne' : 'installs.usedByMany', {
                                    count: usedBy.length
                                  })}
                            </p>
                            {usedBy.length > 0 && (
                              <ul className="max-h-48 overflow-y-auto">
                                {usedBy.slice(0, 12).map((file) => (
                                  <li key={file.path} className="truncate px-2 py-1 text-xs text-zinc-300" title={file.path}>
                                    {file.name}
                                  </li>
                                ))}
                                {usedBy.length > 12 && (
                                  <li className="px-2 py-1 text-[11px] text-zinc-500">
                                    {t('installs.andMore', { count: usedBy.length - 12 })}
                                  </li>
                                )}
                              </ul>
                            )}
                            {onShowProjects && (
                              <button
                                onClick={() => {
                                  setProjectsPopoverFor(null)
                                  onShowProjects(minorOf(row.version))
                                }}
                                className="mt-1 w-full rounded-md border border-white/10 px-2 py-1.5 text-xs font-medium text-zinc-200 transition-colors hover:bg-white/5"
                              >
                                {t('installs.viewProjects')}
                              </button>
                            )}
                          </Dropdown>
                        )}
                      </div>
                      {branchMeta && (
                        <p className="truncate text-[11px] text-zinc-500" title={row.branch}>
                          {branchMeta}
                        </p>
                      )}
                    </div>
                    <div className="min-w-0 flex-1">
                      {progress ? (
                        <ProgressLine progress={progress} />
                      ) : copy ? (
                        <p className="truncate text-xs text-zinc-500" title={copy.path}>
                          {copy.path}
                        </p>
                      ) : (
                        <p className="truncate text-xs text-zinc-500">{sizeDate}</p>
                      )}
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      {notesUrl && (
                        <button
                          onClick={() => window.open(notesUrl, '_blank', 'noopener')}
                          title={
                            row.remoteBuild?.source === 'patch'
                              ? t('installs.showPrDetails')
                              : t('installs.releaseNotes')
                          }
                          className="rounded-lg border border-white/10 p-1.5 text-zinc-400 transition-colors hover:bg-white/5 hover:text-zinc-200"
                        >
                          <InfoIcon />
                        </button>
                      )}
                      {copy ? (
                        <>
                          {row.update && !inFlight && (
                            <button
                              onClick={() => row.update && startInstall(row.update)}
                              disabled={!isDesktop}
                              title={
                                isDesktop
                                  ? t('installs.updateHint', {
                                      build: [
                                        t('installs.buildName', {
                                          version: row.update.version,
                                          cycle: row.update.releaseCycle
                                        }),
                                        row.update.fileMtime > 0 ? formatDate(row.update.fileMtime) : ''
                                      ]
                                        .filter(Boolean)
                                        .join(' · ')
                                    })
                                  : t('installs.desktopOnly')
                              }
                              className="rounded-lg border border-blender/40 px-3 py-1 text-xs font-medium text-blender transition-colors hover:bg-blender/10 disabled:cursor-not-allowed disabled:opacity-40"
                            >
                              {t('installs.update')}
                            </button>
                          )}
                          <button
                            onClick={() =>
                              buildsApi.launch(copy.id).catch((error) => alertDialog(cleanErrorMessage(error)))
                            }
                            className="rounded-lg bg-blender px-3 py-1 text-xs font-medium text-white transition-colors hover:bg-blender/90"
                          >
                            {t('installs.launch')}
                          </button>
                          <button
                            title={t('installs.openFolder')}
                            onClick={() => buildsApi.openFolder(copy.id).catch(() => undefined)}
                            className="rounded-lg border border-white/10 p-1.5 text-zinc-400 transition-colors hover:bg-white/5 hover:text-zinc-200"
                          >
                            <FolderOpenIcon />
                          </button>
                          <button
                            title={copy.managed ? t('installs.uninstall') : t('installs.removeFromList')}
                            onClick={() => removeInstall(copy)}
                            className="rounded-lg border border-white/10 p-1.5 text-zinc-400 transition-colors hover:bg-red-500/10 hover:text-red-400"
                          >
                            <TrashIcon />
                          </button>
                        </>
                      ) : inFlight ? null : (
                        <button
                          onClick={() => row.remoteBuild && startInstall(row.remoteBuild)}
                          disabled={!isDesktop}
                          title={isDesktop ? undefined : t('installs.desktopOnly')}
                          className="rounded-lg border border-blender/40 px-3 py-1 text-xs font-medium text-blender transition-colors hover:bg-blender/10 disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          {t('common.install')}
                        </button>
                      )}
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </section>
      </div>
    </PageLayout>
    {syncOffers[0] && (
      <SyncOfferDialog
        version={syncOffers[0].version}
        minor={syncOffers[0].minor}
        settingsSource={syncOffers[0].settingsSource}
        sourceOptions={syncOffers[0].sourceOptions}
        api={api}
        onClose={() => setSyncOffers((queue) => queue.slice(1))}
      />
    )}
    </>
  )
}

