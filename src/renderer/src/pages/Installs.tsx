import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import PageLayout from '../components/PageLayout'
import Dropdown from '../components/Dropdown'
import { FilterSelect } from '../components/FilterSelect'
import { useDialog } from '../components/Dialog'
import { FolderIcon } from '../components/Sidebar'
import RunningBlenderGate from '../components/RunningBlenderGate'
import SyncOfferDialog from '../components/SyncOfferDialog'
import { cleanErrorMessage, formatBytes, formatDate } from '../lib/format'
import { useTranslation } from '../lib/i18n'
import { getLauncherApi } from '../lib/preview-fallback'
import { uiGet, uiSet } from '../lib/ui-store'
import { minorOf } from '../../../shared/blender-archive'
import {
  compareVersionsDesc,
  cycleClass,
  isReleasedCycle,
  isSameBuild,
  isUpdateFor,
  STABLE_CYCLES
} from '../../../shared/blender-builds'
import type {
  BlendFileInfo,
  InstalledBuild,
  InstallProgress,
  RemoteBuild,
  RunningBlender
} from '../../../shared/types'
import { ActionLabel, ProgressLine, ProjectCountLabel } from './installs/cells'
import { BadgeSlot, CycleBadge, LONGEST_CYCLE } from '../components/Badge'
import { FILTER_LABEL_KEYS } from './installs/constants'
import { ChevronDownIcon, DotsIcon, GearIcon, RefreshIcon } from './installs/icons'
import {
  buildMatchesTab,
  installedIdentityKey,
  locateWithDedup,
  notesUrlForBuild,
  notesUrlForRow,
  releaseDateOfRow
} from './installs/installs-utils'
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
  const { confirm: confirmDialog, alert: alertDialog, choose: chooseDialog } = useDialog()
  const { t } = useTranslation()
  const [remote, setRemote] = useState<RemoteBuild[] | null>(null)
  const [remoteError, setRemoteError] = useState<string | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [installed, setInstalled] = useState<InstalledBuild[]>([])
  // opening Installs normally lands on Stable; arriving via a version search (from
  // Projects, Sync or the tray) stays on All so the searched build is not filtered out
  const [filter, setFilter] = useState<string>(initialSearch ? 'all' : 'stable')
  const [query, setQuery] = useState(initialSearch ?? '')
  const [sortKey, setSortKey] = useState<'version' | 'date'>('version')
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc')
  // "Other versions" drawers open per series; in-memory only, resets with the page
  const [expandedSeries, setExpandedSeries] = useState<ReadonlySet<string>>(new Set())
  // shared across top rows and drawer sub-rows — every row/entry key is unique
  const [moreMenuFor, setMoreMenuFor] = useState<string | null>(null)
  const [runningGate, setRunningGate] = useState<{
    minors: string[]
    initial: RunningBlender[]
    resume: () => void
  } | null>(null)
  const [locating, setLocating] = useState(false)
  const [projectFiles, setProjectFiles] = useState<BlendFileInfo[]>([])
  const [projectsPopoverFor, setProjectsPopoverFor] = useState<string | null>(null)
  const [progressById, setProgressById] = useState<Record<string, InstallProgress>>({})
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [showBranch, setShowBranch] = useState(() => uiGet('installs.showBranch') === '1')
  // the count chip ships on by default, on every version row; an explicit '0' turns it
  // off. Its sub-option restricts the chips to installed versions and is off by default.
  const [showProjectCount, setShowProjectCount] = useState(() => uiGet('installs.showProjectCount') !== '0')
  const [projectCountInstalledOnly, setProjectCountInstalledOnly] = useState(
    () => uiGet('installs.projectCountInstalledOnly') === '1'
  )
  const [hideEmptyProjectCount, setHideEmptyProjectCount] = useState(
    () => uiGet('installs.hideEmptyProjectCount') === '1'
  )
  const [showSize, setShowSize] = useState(() => uiGet('installs.showSize') === '1')
  const [installedFilter, setInstalledFilter] = useState<'all' | 'installed' | 'not-installed'>(
    () => (uiGet('installs.installedFilter') as 'all' | 'installed' | 'not-installed' | undefined) ?? 'all'
  )
  const [syncOffers, setSyncOffers] = useState<
    { minor: string; version: string; settingsSource: string | null; sourceOptions: string[] }[]
  >([])
  const installedRef = useRef<InstalledBuild[]>([])
  // ids the user cancelled — their install call rejects, and that is not an error
  const cancelledRef = useRef<Set<string>>(new Set())
  // install ids whose uninstall (trash) is in flight right now
  const [removingIds, setRemovingIds] = useState<ReadonlySet<string>>(new Set())

  useEffect(() => {
    uiSet('installs.showBranch', showBranch ? '1' : '0')
  }, [showBranch])

  useEffect(() => {
    uiSet('installs.showProjectCount', showProjectCount ? '1' : '0')
  }, [showProjectCount])

  useEffect(() => {
    uiSet('installs.projectCountInstalledOnly', projectCountInstalledOnly ? '1' : '0')
  }, [projectCountInstalledOnly])

  useEffect(() => {
    uiSet('installs.hideEmptyProjectCount', hideEmptyProjectCount ? '1' : '0')
  }, [hideEmptyProjectCount])

  useEffect(() => {
    uiSet('installs.showSize', showSize ? '1' : '0')
  }, [showSize])

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
      // a cancelled install leaves no trace: the row goes straight back to Install
      if (progress.phase === 'cancelled') {
        setProgressById((previous) => {
          const { [progress.buildId]: _cancelled, ...rest } = previous
          return rest
        })
        return
      }
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
    async (build: RemoteBuild, keepExisting = false): Promise<boolean> => {
      if (!buildsApi) return false
      // one copy of an exact build is enough — block a duplicate add with a warning.
      // (a new commit of a rolling build is NOT isSameBuild, so it still installs/replaces)
      const already = installed.some((entry) => entry.remoteId === build.id || isSameBuild(entry, build))
      if (already) {
        await alertDialog(
          t('installs.alreadyInstalled', { version: build.version, cycle: build.releaseCycle })
        )
        return false
      }
      setProgressById((previous) => ({
        ...previous,
        [build.id]: { buildId: build.id, phase: 'downloading', receivedBytes: 0, totalBytes: build.fileSize }
      }))
      try {
        await buildsApi.install(build.id, keepExisting)
        return true
      } catch (error) {
        // the rejection of a cancelled install is expected — the progress row is
        // already gone, and surfacing it as an error would contradict the user
        if (cancelledRef.current.delete(build.id)) return false
        setProgressById((previous) => ({
          ...previous,
          [build.id]: { buildId: build.id, phase: 'error', error: cleanErrorMessage(error) }
        }))
        return false
      }
    },
    [buildsApi, installed, alertDialog, t]
  )

  const cancelInstall = useCallback(
    (buildId: string) => {
      if (!buildsApi) return
      cancelledRef.current.add(buildId)
      // drop the row's progress right away — main confirms with a 'cancelled' event
      setProgressById((previous) => {
        const { [buildId]: _dropped, ...rest } = previous
        return rest
      })
      buildsApi.cancelInstall(buildId).catch(() => undefined)
    },
    [buildsApi]
  )

  // Replacing copies out from under a running Blender risks locked folders and a
  // half-retired line — same gate as Add-ons Apply / Sync: run now when the
  // affected minors are closed, otherwise park the continuation in the dialog.
  // trashItem gives no progress callbacks, but it can churn for seconds on a
  // full build — these ids render an indeterminate "Removing…" line meanwhile
  const markRemoving = useCallback((ids: string[], on: boolean) => {
    setRemovingIds((previous) => {
      const next = new Set(previous)
      for (const id of ids) {
        if (on) next.add(id)
        else next.delete(id)
      }
      return next
    })
  }, [])

  const gateOnRunning = useCallback(
    async (minors: string[], run: () => Promise<void>) => {
      let found: RunningBlender[] = []
      try {
        found = await api.builds.listRunning(minors)
      } catch {
        // detection failed — proceed exactly as before the guard existed
      }
      if (found.length > 0) setRunningGate({ minors, initial: found, resume: () => void run() })
      else await run()
    },
    [api]
  )

  // An Update replaces the copies of its line — gate it on a running Blender of
  // that series before starting.
  const startUpdate = useCallback(
    (update: RemoteBuild) => {
      void gateOnRunning([minorOf(update.version)], async () => {
        await startInstall(update)
      })
    },
    [gateOnRunning, startInstall]
  )

  // Every Install goes through here. Whenever the install would displace or
  // shadow existing copies of the series, the user chooses explicitly:
  // "replace" lets the main process retire superseded copies as usual and
  // uninstalls the survivors the user wanted gone; "keep both" installs with
  // keepExisting so nothing is touched. Located copies are never removed.
  const requestInstall = useCallback(
    async (build: RemoteBuild) => {
      if (!buildsApi) return
      const buildReleased = isReleasedCycle(build.releaseCycle)
      const seriesCopies = installed.filter(
        (copy) =>
          copy.managed &&
          STABLE_CYCLES.has(copy.releaseCycle) &&
          minorOf(copy.version) === minorOf(build.version)
      )
      // copies the install auto-retires (mirrors replaceSupersededBuilds)
      const retired = buildReleased
        ? seriesCopies.filter((copy) => {
            const cmp = compareVersionsDesc(copy.version, build.version)
            return cmp > 0 || (cmp === 0 && !isReleasedCycle(copy.releaseCycle))
          })
        : []
      // copies that survive, but the user may want gone: newer ones (a downgrade),
      // and for a candidate install — the released copies of the series it previews
      const survivors = seriesCopies.filter(
        (copy) =>
          compareVersionsDesc(copy.version, build.version) < 0 ||
          (!buildReleased && isReleasedCycle(copy.releaseCycle))
      )
      if (retired.length === 0 && survivors.length === 0) {
        await startInstall(build)
        return
      }
      const current = [...new Set([...retired, ...survivors].map((copy) => copy.version))].join(', ')
      const downgrade = survivors.length > 0 && buildReleased
      const messageKey = !buildReleased
        ? 'installs.candidateInstallMessage'
        : downgrade
          ? 'installs.downgradeMessage'
          : 'installs.upgradeMessage'
      const titleKey = !buildReleased
        ? 'installs.candidateInstallTitle'
        : downgrade
          ? 'installs.downgradeTitle'
          : 'installs.upgradeTitle'
      // a plain upgrade recommends replacing; a downgrade or candidate recommends keeping both
      const replaceKind = downgrade || !buildReleased ? 'danger' : 'primary'
      const keepKind = downgrade || !buildReleased ? 'primary' : 'secondary'
      const choice = await chooseDialog({
        title: t(titleKey, { version: build.version }),
        message: t(messageKey, { version: build.version, current }),
        variant: 'warning',
        buttons: [
          { id: 'cancel', label: t('common.cancel') },
          { id: 'replace', label: t('installs.downgradeReplace', { current }), kind: replaceKind },
          { id: 'keep', label: t('installs.downgradeKeepBoth'), kind: keepKind }
        ]
      })
      if (choice !== 'replace' && choice !== 'keep') return
      if (choice === 'keep') {
        await startInstall(build, true)
        return
      }
      // replacing pulls installed copies out from under a possibly running Blender
      await gateOnRunning([minorOf(build.version)], async () => {
        const ok = await startInstall(build, false)
        if (!ok) return
        markRemoving(survivors.map((copy) => copy.id), true)
        try {
          for (const copy of survivors) {
            try {
              await buildsApi.uninstall(copy.id)
            } catch (error) {
              await alertDialog(cleanErrorMessage(error))
            }
          }
        } finally {
          markRemoving(survivors.map((copy) => copy.id), false)
        }
        refreshInstalled()
      })
    },
    [buildsApi, installed, startInstall, gateOnRunning, markRemoving, chooseDialog, alertDialog, refreshInstalled, t]
  )

  const removeInstall = useCallback(
    async (build: InstalledBuild) => {
      if (!buildsApi || removingIds.has(build.id)) return
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
      markRemoving([build.id], true)
      try {
        await buildsApi.uninstall(build.id)
      } catch (error) {
        await alertDialog(cleanErrorMessage(error))
      } finally {
        markRemoving([build.id], false)
      }
      refreshInstalled()
    },
    [buildsApi, removingIds, markRemoving, refreshInstalled, confirmDialog, alertDialog, t]
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
    // both hosts feed the cycle tabs, by class — the archive is all released
    // builds, so it lands on Stable instead of a source-shaped tab of its own
    const present = new Set(
      (remote ?? [])
        .filter((build) => build.source === 'daily' || build.source === 'archive')
        .map((build) => cycleClass(build.releaseCycle))
    )
    const cycleTabs = ['stable', 'candidate', 'beta', 'alpha'].filter((cycle) => present.has(cycle))
    return ['all', ...cycleTabs, 'experimental']
  }, [remote])

  // newest released (stable/lts) version per minor across ALL sources — used to
  // de-emphasize a candidate's Install button while its series has a released
  // build, and anchor the "Other versions" drawer: the newest released build is
  // the series representative, everything older feeds the drawer
  const releasedNewestByMinor = useMemo(() => {
    const map = new Map<string, RemoteBuild>()
    for (const build of remote ?? []) {
      if (build.source === 'patch' || build.source === 'experimental') continue
      if (!isReleasedCycle(build.releaseCycle)) continue
      const minor = minorOf(build.version)
      const known = map.get(minor)
      if (!known || compareVersionsDesc(build.version, known.version) < 0) map.set(minor, build)
    }
    return map
  }, [remote])

  // every stable-cycle member of a series (released patches and the current
  // candidate), newest first — element 0 is the series representative that owns
  // the top row, the rest render inside the "Other versions" drawer. At equal
  // versions the released build outranks its candidate
  const seriesMembersByMinor = useMemo(() => {
    const map = new Map<string, RemoteBuild[]>()
    for (const build of remote ?? []) {
      if (build.source === 'patch' || build.source === 'experimental') continue
      if (!STABLE_CYCLES.has(build.releaseCycle)) continue
      const minor = minorOf(build.version)
      const list = map.get(minor)
      if (list) list.push(build)
      else map.set(minor, [build])
    }
    for (const list of map.values())
      list.sort(
        (a, b) =>
          compareVersionsDesc(a.version, b.version) ||
          Number(isReleasedCycle(b.releaseCycle)) - Number(isReleasedCycle(a.releaseCycle)) ||
          b.fileMtime - a.fileMtime
      )
    return map
  }, [remote])

  // a series is represented by its newest member VISIBLE on the current tab —
  // on Stable that is the newest released build even while a candidate leads the
  // series on All (members are already sorted newest-first)
  const seriesRepFor = useCallback(
    (minor: string, tab: string): RemoteBuild | undefined =>
      seriesMembersByMinor.get(minor)?.find((member) => buildMatchesTab(member, tab)),
    [seriesMembersByMinor]
  )

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

  // Updates ride installed copies' rows — claimed and orphaned alike (with the
  // full archive history in the catalog, claimed is the norm for old patches).
  // A copy whose line already has a newer installed copy gets no Update nudge —
  // the newer one is right there, and with installed builds excluded from the
  // targets the button would absurdly point at an intermediate patch.
  const updateByCopyId = useMemo(() => {
    const coveredIds = new Set<string>()
    for (const entry of installed) {
      const covered = installed.some((other) => {
        if (other.id === entry.id) return false
        if (!STABLE_CYCLES.has(other.releaseCycle) || !STABLE_CYCLES.has(entry.releaseCycle)) return false
        if (minorOf(other.version) !== minorOf(entry.version)) return false
        if (!isReleasedCycle(other.releaseCycle) && isReleasedCycle(entry.releaseCycle)) return false
        const cmp = compareVersionsDesc(other.version, entry.version)
        return cmp < 0 || (cmp === 0 && isReleasedCycle(other.releaseCycle) && !isReleasedCycle(entry.releaseCycle))
      })
      if (covered) coveredIds.add(entry.id)
    }
    const map = new Map<string, RemoteBuild>()
    for (const build of remote ?? []) {
      if (copiesForRemote(build).length > 0) continue
      for (const entry of installed) {
        if (coveredIds.has(entry.id) || !isUpdateFor(build, entry)) continue
        const known = map.get(entry.id)
        const cmp = known ? compareVersionsDesc(build.version, known.version) : 0
        // equal versions: the released build wins the Update slot over a candidate
        const wins =
          cmp === 0 &&
          (isReleasedCycle(build.releaseCycle) !== isReleasedCycle(known?.releaseCycle ?? '')
            ? isReleasedCycle(build.releaseCycle)
            : build.fileMtime > (known?.fileMtime ?? 0))
        if (!known || cmp < 0 || wins) {
          map.set(entry.id, build)
        }
      }
    }
    return map
  }, [remote, installed, copiesForRemote])

  const mergedVisible = useMemo(() => {
    const q = query.trim().toLowerCase()
    // a concrete x.y.z query pulls matching drawer-only patches into the top list
    const patchQuery = /^\d+\.\d+\.\d+/.test(q)
    const matchesQuery = (version: string, branch: string, cycle: string, commit: string): boolean =>
      !q ||
      version.toLowerCase().includes(q) ||
      branch.toLowerCase().includes(q) ||
      cycle.toLowerCase().includes(q) ||
      commit.toLowerCase().includes(q)

    const matchesTabFor = (build: RemoteBuild): boolean => buildMatchesTab(build, filter)

    // "Installed" means exactly the copies on disk: collapsing would hide them
    // behind a series row that is itself not installed, so the drawer is off and
    // every copy stands on its own line
    const collapseSeries = installedFilter !== 'installed'

    const rows: DisplayRow[] = []
    // update targets advertised by a rendered row: their own Install row is then
    // suppressed — the Update button IS their appearance, one line per build
    const carriedUpdateIds = new Set<string>()

    // pass 1: installed copies the catalog still lists → one row per copy.
    // Collapsed series: copies of non-representative members live inside the
    // "Other versions" drawer with the rest of the series, not the top list —
    // only a concrete x.y.z search surfaces them as top rows
    for (const build of remote ?? []) {
      if (!matchesTabFor(build)) continue
      const copies = copiesForRemote(build)
      if (copies.length === 0) continue
      const seriesRep = seriesRepFor(minorOf(build.version), filter)
      const drawerBound =
        STABLE_CYCLES.has(build.releaseCycle) &&
        build.source !== 'patch' &&
        build.source !== 'experimental' &&
        seriesRep !== undefined &&
        build.id !== seriesRep.id
      if (drawerBound && !patchQuery && collapseSeries) continue
      // claimed copies may differ from the catalog entry in cycle label or commit
      // (an lts copy claimed by an archive "stable" row), and their update rides
      // here — search must see all three
      const copyUpdates = copies.map((copy) => updateByCopyId.get(copy.id) ?? null)
      const matchesRow =
        matchesQuery(build.version, build.branch, build.releaseCycle, build.commit) ||
        copies.some((c) => matchesQuery(c.version, c.branch ?? '', c.releaseCycle, c.commit ?? '')) ||
        copyUpdates.some((u) => u !== null && matchesQuery(u.version, u.branch, u.releaseCycle, u.commit))
      if (!matchesRow) continue
      copies.forEach((copy, index) => {
        const update = copyUpdates[index]
        if (update) carriedUpdateIds.add(update.id)
        rows.push({
          key: `copy:${copy.id}`,
          version: copy.version,
          releaseCycle: copy.releaseCycle,
          branch: copy.branch ?? '',
          commit: copy.commit ?? '',
          remoteBuild: build,
          update,
          copy
        })
      })
    }

    // pass 2: orphans — installed copies the catalog no longer lists
    for (const copies of orphanGroups.values()) {
      const rep = copies[0]
      // unknown original source (archive/daily/experimental) — only ever shown under
      // All and its own cycle tab; class comparison, so an "lts" copy belongs on the
      // stable tab and a mixed stable+lts group cannot flip with its representative
      const matchesTab = filter === 'all' || cycleClass(filter) === cycleClass(rep.releaseCycle)
      if (!matchesTab) continue
      // a stable-cycle orphan of a series the catalog knows collapses into that
      // series' drawer like every other non-representative copy
      const seriesRep = STABLE_CYCLES.has(rep.releaseCycle)
        ? seriesRepFor(minorOf(rep.version), filter)
        : undefined
      if (seriesRep !== undefined && !patchQuery && collapseSeries) continue
      // the superseding build has no Install row of its own (it rides here as the
      // Update button), so searching for the NEW version must surface this row
      const update = updateByCopyId.get(rep.id) ?? null
      const matchesRow =
        matchesQuery(rep.version, rep.branch ?? '', rep.releaseCycle, rep.commit ?? '') ||
        (update !== null && matchesQuery(update.version, update.branch, update.releaseCycle, update.commit))
      if (!matchesRow) continue
      for (const copy of copies) {
        const copyUpdate = updateByCopyId.get(copy.id) ?? null
        if (copyUpdate) carriedUpdateIds.add(copyUpdate.id)
        rows.push({
          key: `copy:${copy.id}`,
          version: copy.version,
          releaseCycle: copy.releaseCycle,
          branch: copy.branch ?? '',
          commit: copy.commit ?? '',
          remoteBuild: null,
          update: copyUpdate,
          copy
        })
      }
    }

    // pass 3: not-installed catalog builds → single Install rows
    for (const build of remote ?? []) {
      if (!matchesTabFor(build)) continue
      if (copiesForRemote(build).length > 0) continue
      // every series member except the tab's representative (the newest member,
      // candidate included) lives in the "Other versions" drawer rather than the
      // top list — a concrete x.y.z search pulls any of them back up
      const rep = seriesRepFor(minorOf(build.version), filter)
      const drawerOnly =
        build.source !== 'patch' &&
        build.source !== 'experimental' &&
        STABLE_CYCLES.has(build.releaseCycle) &&
        rep !== undefined &&
        build.id !== rep.id
      if (drawerOnly && !patchQuery) continue
      // a rendered row already advertises this build as its Update — shown once,
      // unless an explicit x.y.z search asks for the build itself
      if (carriedUpdateIds.has(build.id) && !patchQuery) continue
      if (!matchesQuery(build.version, build.branch, build.releaseCycle, build.commit)) continue
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
  }, [
    remote,
    installed,
    filter,
    query,
    installedFilter,
    sortKey,
    sortDir,
    copiesForRemote,
    orphanGroups,
    seriesRepFor,
    updateByCopyId
  ])

  // exactly one "Other versions" toggle per series — on the first visible row that
  // represents the tab's series representative (its Install row, an installed
  // copy of it, or the outdated copy carrying it as the Update target)
  const drawerRowByKey = useMemo(() => {
    const map = new Map<string, string>()
    // nothing is collapsed under the Installed filter, so there is nothing to open
    if (installedFilter === 'installed') return map
    const seen = new Set<string>()
    for (const row of mergedVisible) {
      const minor = minorOf(row.version)
      if (seen.has(minor)) continue
      const rep = seriesRepFor(minor, filter)
      if (!rep) continue
      // the drawer only ever holds the series' PAST — members newer than this
      // tab's representative (e.g. a daily-served release above the newest archive
      // row on the Archive tab) belong to other tabs, never under an older row
      const hasDrawerContent = (seriesMembersByMinor.get(minor) ?? []).some(
        (member) => member.id !== rep.id && compareVersionsDesc(member.version, rep.version) >= 0
      )
      if (!hasDrawerContent) continue
      const represents =
        row.remoteBuild?.id === rep.id ||
        row.update?.id === rep.id ||
        (row.copy !== null && isSameBuild(row.copy, rep))
      if (!represents) continue
      seen.add(minor)
      map.set(row.key, minor)
    }
    return map
  }, [mergedVisible, seriesMembersByMinor, seriesRepFor, filter, installedFilter])

  const toggleSeries = useCallback((minor: string) => {
    setExpandedSeries((previous) => {
      const next = new Set(previous)
      if (next.has(minor)) next.delete(minor)
      else next.add(minor)
      return next
    })
  }, [])

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
            className="rounded-lg border border-white/10 p-2 text-zinc-400 transition-colors hover:bg-white/10 hover:text-zinc-200 disabled:opacity-50"
          >
            <RefreshIcon className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />
          </button>
          <button
            onClick={locateExisting}
            disabled={locating || !isDesktop}
            title={isDesktop ? t('installs.locateHint') : t('installs.desktopOnly')}
            className="rounded-lg border border-white/10 px-3 py-1.5 text-sm font-medium text-zinc-300 transition-colors hover:bg-white/10 disabled:opacity-50"
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
                menuClassName="w-48 rounded-lg border border-white/10 bg-surface-menu p-1 shadow-xl"
                trigger={
                  <button
                    title={t('installs.displaySettings')}
                    onClick={() => setSettingsOpen((open) => !open)}
                    className="rounded-lg border border-white/10 p-1.5 text-zinc-400 transition-colors hover:bg-white/10 hover:text-zinc-200"
                  >
                    <GearIcon className="h-4 w-4" />
                  </button>
                }
              >
                <p className="px-2 py-1 text-[11px] font-medium uppercase tracking-wide text-zinc-500">
                  {t('installs.show')}
                </p>
                <label className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm text-zinc-300 transition-colors hover:bg-white/10">
                  <input
                    type="checkbox"
                    checked={showBranch}
                    onChange={(event) => setShowBranch(event.target.checked)}
                    className="accent-blender"
                  />
                  {t('installs.branch')}
                </label>
                <label className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm text-zinc-300 transition-colors hover:bg-white/10">
                  <input
                    type="checkbox"
                    checked={showProjectCount}
                    onChange={(event) => setShowProjectCount(event.target.checked)}
                    className="accent-blender"
                  />
                  {t('installs.projectCount')}
                </label>
                <label
                  className={`flex items-center gap-2 rounded py-1.5 pl-7 pr-2 text-sm transition-colors ${
                    showProjectCount
                      ? 'cursor-pointer text-zinc-300 hover:bg-white/10'
                      : 'cursor-not-allowed text-zinc-600'
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={projectCountInstalledOnly}
                    disabled={!showProjectCount}
                    onChange={(event) => setProjectCountInstalledOnly(event.target.checked)}
                    className="accent-blender"
                  />
                  {t('installs.projectCountInstalledOnly')}
                </label>
                <label
                  className={`flex items-center gap-2 rounded py-1.5 pl-7 pr-2 text-sm transition-colors ${
                    showProjectCount
                      ? 'cursor-pointer text-zinc-300 hover:bg-white/10'
                      : 'cursor-not-allowed text-zinc-600'
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={hideEmptyProjectCount}
                    disabled={!showProjectCount}
                    onChange={(event) => setHideEmptyProjectCount(event.target.checked)}
                    className="accent-blender"
                  />
                  {t('installs.projectCountHideEmpty')}
                </label>
                <label className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm text-zinc-300 transition-colors hover:bg-white/10">
                  <input
                    type="checkbox"
                    checked={showSize}
                    onChange={(event) => setShowSize(event.target.checked)}
                    className="accent-blender"
                  />
                  {t('installs.buildSize')}
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
                    ? 'bg-selection/15 text-selection'
                    : 'text-zinc-500 hover:bg-white/10 hover:text-zinc-300'
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
                const updateProgress = row.update ? progressById[row.update.id] : undefined
                const remoteProgress = row.remoteBuild ? progressById[row.remoteBuild.id] : undefined
                // the copy is about to be replaced by its own update: no second
                // Update click, and no acting on files the install is retiring
                const updateBusy =
                  updateProgress !== undefined &&
                  updateProgress.phase !== 'error' &&
                  updateProgress.phase !== 'done'
                const inFlight =
                  remoteProgress !== undefined &&
                  remoteProgress.phase !== 'error' &&
                  remoteProgress.phase !== 'done'
                // only the download is interruptible — past it the archive is being
                // unpacked into place and there is nothing left to call off
                const cancellable =
                  remoteProgress?.phase === 'downloading'
                    ? row.remoteBuild
                    : updateProgress?.phase === 'downloading'
                      ? row.update
                      : null
                const notesUrl = notesUrlForRow(row)
                const branchMeta = showBranch
                  ? [row.branch, row.commit ? row.commit.slice(0, 10) : ''].filter(Boolean).join(' · ')
                  : ''
                const sizeDate = row.remoteBuild
                  ? [
                      showSize ? formatBytes(row.remoteBuild.fileSize) : '',
                      row.remoteBuild.fileMtime > 0 ? formatDate(row.remoteBuild.fileMtime) : ''
                    ]
                      .filter(Boolean)
                      .join(' · ')
                  : ''
                const usedBy = projectsByMinor.get(minorOf(row.version)) ?? []
                const projectsOpen = projectsPopoverFor === row.key
                const removing = copy !== null && removingIds.has(copy.id)
                // visible Update target: the new version, or version + cycle when only
                // the cycle changes (released build superseding its own candidate);
                // rolling updates (same version, new commit) keep the plain verb
                const updateTarget = row.update
                  ? row.update.version !== row.version
                    ? row.update.version
                    : cycleClass(row.update.releaseCycle) !== cycleClass(row.releaseCycle)
                      ? `${row.update.version} ${row.update.releaseCycle}`
                      : null
                  : null
                // a candidate whose series has a released build is the opt-in choice,
                // not the recommended one — its Install goes neutral, accent stays
                // on the released row so each series has one obvious button
                const releasedOfSeries =
                  !isInstalled && row.remoteBuild && cycleClass(row.releaseCycle) === 'candidate'
                    ? (releasedNewestByMinor.get(minorOf(row.version))?.version ?? null)
                    : null
                const drawerMinor = drawerRowByKey.get(row.key) ?? null
                const drawerExpanded = drawerMinor !== null && expandedSeries.has(drawerMinor)
                // the drawer interleaves the series' other catalog versions and every
                // installed copy of them (collapsed from the top list), newest first
                const drawerEntries: {
                  key: string
                  version: string
                  releaseCycle: string
                  build: RemoteBuild | null
                  copy: InstalledBuild | null
                }[] = []
                const drawerRep = drawerMinor !== null ? seriesRepFor(drawerMinor, filter) : undefined
                if (drawerMinor !== null && drawerRep !== undefined) {
                  for (const member of seriesMembersByMinor.get(drawerMinor) ?? []) {
                    if (
                      member.id === row.remoteBuild?.id ||
                      member.id === row.update?.id ||
                      (row.copy !== null && isSameBuild(row.copy, member))
                    )
                      continue
                    // the drawer holds the series' past only — never a member newer
                    // than this tab's representative
                    if (compareVersionsDesc(member.version, drawerRep.version) < 0) continue
                    // ...and only members this tab shows, so Stable never lists a candidate
                    if (!buildMatchesTab(member, filter)) continue
                    const memberCopies = copiesForRemote(member)
                    if (memberCopies.length === 0) {
                      drawerEntries.push({
                        key: `build:${member.id}`,
                        version: member.version,
                        releaseCycle: member.releaseCycle,
                        build: member,
                        copy: null
                      })
                    } else {
                      for (const memberCopy of memberCopies) {
                        drawerEntries.push({
                          key: `copy:${memberCopy.id}`,
                          version: memberCopy.version,
                          releaseCycle: memberCopy.releaseCycle,
                          build: member,
                          copy: memberCopy
                        })
                      }
                    }
                  }
                  for (const group of orphanGroups.values()) {
                    for (const orphan of group) {
                      if (!STABLE_CYCLES.has(orphan.releaseCycle)) continue
                      if (minorOf(orphan.version) !== drawerMinor) continue
                      if (orphan.id === row.copy?.id) continue
                      if (compareVersionsDesc(orphan.version, drawerRep.version) < 0) continue
                      drawerEntries.push({
                        key: `copy:${orphan.id}`,
                        version: orphan.version,
                        releaseCycle: orphan.releaseCycle,
                        build: null,
                        copy: orphan
                      })
                    }
                  }
                  drawerEntries.sort(
                    (a, b) =>
                      compareVersionsDesc(a.version, b.version) ||
                      (a.copy?.path ?? '').localeCompare(b.copy?.path ?? '')
                  )
                }
                const seriesHasInstalled = drawerEntries.some((entry) => entry.copy !== null)
                // the update target draws its own progress when it has a drawer row of
                // its own; otherwise this carrier row is the only place to show it
                const updateShownInDrawer =
                  row.update !== null &&
                  drawerEntries.some((entry) => entry.copy === null && entry.build?.id === row.update?.id)
                const progress = remoteProgress ?? (updateShownInDrawer ? undefined : updateProgress)
                return (
                  <Fragment key={row.key}>
                  <div
                    onClick={(event) => {
                      // the whole row toggles its series drawer; clicks that land on
                      // any button (actions, popover trigger) are theirs alone
                      if (drawerMinor === null) return
                      if ((event.target as HTMLElement).closest('button')) return
                      toggleSeries(drawerMinor)
                    }}
                    className={`flex items-center gap-4 bg-surface-card px-4 py-3 ${index > 0 ? 'border-t border-white/5' : ''} ${
                      drawerMinor !== null ? 'cursor-pointer hover:bg-surface-hover' : ''
                    }`}
                  >
                    <div className="w-56 shrink-0">
                      <div className="flex items-center gap-2">
                        {/* The dot speaks for what the row itself shows: expanded, the
                            installed sub-rows carry their own dots, so it only stays lit
                            for this build. Collapsed, it also stands in for a hidden
                            installed member — marked by a faint arrow below it, out of
                            flow so the dot never shifts. */}
                        <span className="relative h-1.5 w-1.5 shrink-0">
                          <span
                            className={`block h-1.5 w-1.5 rounded-full ${
                              isInstalled || (seriesHasInstalled && !drawerExpanded)
                                ? 'bg-emerald-400'
                                : 'bg-transparent'
                            }`}
                            title={
                              isInstalled || (seriesHasInstalled && !drawerExpanded)
                                ? t('installs.installed')
                                : undefined
                            }
                          />
                          {seriesHasInstalled && !drawerExpanded && (
                            <ChevronDownIcon className="pointer-events-none absolute left-1/2 top-full h-2 w-2 -translate-x-1/2 text-emerald-400/40" />
                          )}
                        </span>
                        <span className="relative shrink-0 text-sm font-semibold text-zinc-100">
                          <span className="invisible">{longestVersion}</span>
                          <span className="absolute inset-y-0 left-0">{row.version}</span>
                        </span>
                        {/* the pill hugs its text; the slot reserves the widest cycle's
                            width so the project chip after it lines up down the list */}
                        <BadgeSlot measure={LONGEST_CYCLE}>
                          <CycleBadge cycle={row.releaseCycle} />
                        </BadgeSlot>
                        {showProjectCount &&
                          (!projectCountInstalledOnly || isInstalled || seriesHasInstalled) &&
                          !(hideEmptyProjectCount && usedBy.length === 0) && (
                          // display:contents keeps layout; the span only fences popover
                          // clicks (its list items are not buttons) off the row toggle
                          <span className="contents" onClick={(event) => event.stopPropagation()}>
                          <Dropdown
                            className="shrink-0"
                            open={projectsOpen}
                            onClose={() => setProjectsPopoverFor(null)}
                            align="left"
                            menuClassName="w-64 rounded-lg border border-white/10 bg-surface-menu p-2 shadow-xl"
                            trigger={
                              <button
                                onClick={() => setProjectsPopoverFor(projectsOpen ? null : row.key)}
                                // an empty count is dimmed — nothing uses this version, so the
                                // chip stays legible but recedes next to the ones that matter
                                className={`flex items-center gap-1 rounded bg-white/10 px-1.5 py-0.5 text-[10px] font-semibold text-zinc-300 transition hover:bg-white/20 ${usedBy.length === 0 ? 'opacity-50 hover:opacity-100' : ''}`}
                              >
                                <FolderIcon className="h-3 w-3 shrink-0" />
                                <ProjectCountLabel count={usedBy.length} />
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
                                className="mt-1 w-full rounded-md border border-white/10 px-2 py-1.5 text-xs font-medium text-zinc-200 transition-colors hover:bg-white/10"
                              >
                                {t('installs.viewProjects')}
                              </button>
                            )}
                          </Dropdown>
                          </span>
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
                        removing ? (
                          <ProgressLine progress={{ buildId: copy.id, phase: 'removing' }} />
                        ) : (
                          <p className="truncate text-xs text-zinc-500" title={copy.path}>
                            {copy.path}
                          </p>
                        )
                      ) : (
                        <p className="truncate text-xs text-zinc-500">{sizeDate}</p>
                      )}
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      {cancellable && (
                        <button
                          onClick={() => cancelInstall(cancellable.id)}
                          className="rounded-lg border border-white/10 px-3 py-1 text-xs font-medium text-zinc-300 transition-colors hover:border-red-500/30 hover:bg-red-500/10 hover:text-red-400"
                        >
                          <ActionLabel>{t('common.cancel')}</ActionLabel>
                        </button>
                      )}
                      {copy ? (
                        <>
                          {row.update && !updateBusy && !removing && (
                            <button
                              onClick={() => row.update && startUpdate(row.update)}
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
                              {updateTarget
                                ? t('installs.updateTo', { target: updateTarget })
                                : t('installs.update')}
                            </button>
                          )}
                          <button
                            disabled={updateBusy || removing}
                            title={updateBusy ? t('installs.busyUpdating') : undefined}
                            onClick={() =>
                              buildsApi.launch(copy.id).catch((error) => alertDialog(cleanErrorMessage(error)))
                            }
                            className="rounded-lg border border-transparent bg-accent-button px-3 py-1 text-xs font-medium text-on-accent transition-colors hover:bg-accent-button-hover disabled:cursor-not-allowed disabled:opacity-40"
                          >
                            <ActionLabel>{t('installs.launch')}</ActionLabel>
                          </button>
                        </>
                      ) : inFlight ? null : (
                        <button
                          onClick={() => row.remoteBuild && requestInstall(row.remoteBuild)}
                          disabled={!isDesktop}
                          title={
                            !isDesktop
                              ? t('installs.desktopOnly')
                              : releasedOfSeries
                                ? t('installs.preReleaseInstallHint', { version: releasedOfSeries })
                                : undefined
                          }
                          className="rounded-lg border border-emerald-500/40 px-3 py-1 text-xs font-medium text-emerald-400 transition-colors hover:bg-emerald-500/10 disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          <ActionLabel>{t('common.install')}</ActionLabel>
                        </button>
                      )}
                      {(notesUrl || copy) && (
                        <Dropdown
                          open={moreMenuFor === row.key}
                          onClose={() => setMoreMenuFor(null)}
                          align="right"
                          menuClassName="min-w-44 overflow-hidden rounded-lg border border-white/10 bg-surface-menu py-1 text-sm shadow-xl"
                          trigger={
                            <button
                              disabled={removing}
                              onClick={() => setMoreMenuFor(moreMenuFor === row.key ? null : row.key)}
                              title={t('installs.moreActions')}
                              className="rounded-lg border border-white/10 p-1.5 text-zinc-400 transition-colors hover:bg-white/10 hover:text-zinc-200 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-zinc-400"
                            >
                              <DotsIcon />
                            </button>
                          }
                        >
                          {notesUrl && (
                            <button
                              onClick={() => {
                                setMoreMenuFor(null)
                                window.open(notesUrl, '_blank', 'noopener')
                              }}
                              className="block w-full px-3 py-1.5 text-left text-zinc-300 transition-colors hover:bg-white/10"
                            >
                              {row.remoteBuild?.source === 'patch'
                                ? t('installs.showPrDetails')
                                : t('installs.releaseNotes')}
                            </button>
                          )}
                          {copy && (
                            <button
                              disabled={updateBusy}
                              onClick={() => {
                                setMoreMenuFor(null)
                                buildsApi.openFolder(copy.id).catch(() => undefined)
                              }}
                              className="block w-full px-3 py-1.5 text-left text-zinc-300 transition-colors hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
                            >
                              {t('installs.openFolder')}
                            </button>
                          )}
                          {copy && (
                            <button
                              disabled={updateBusy}
                              onClick={() => {
                                setMoreMenuFor(null)
                                removeInstall(copy)
                              }}
                              className="block w-full px-3 py-1.5 text-left text-red-400 transition-colors hover:bg-red-500/10 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
                            >
                              {copy.managed ? t('installs.uninstall') : t('installs.removeFromList')}
                            </button>
                          )}
                        </Dropdown>
                      )}
                      {/* plain indicator — the whole row is the toggle; rows without a
                          drawer keep an invisible one so action clusters line up. Its
                          left margin is set to match the row's own right padding (px-4),
                          on top of the shared flex gap — otherwise the bare glyph sits
                          close to its neighbor but far from the row edge on the other side */}
                      {/* collapsed it points left (rotate-90), expanded it turns down;
                          the color stays put in both states */}
                      <ChevronDownIcon
                        className={`ml-2.5 h-4 w-4 shrink-0 text-zinc-500 transition-transform ${
                          drawerMinor === null ? 'invisible' : drawerExpanded ? '' : 'rotate-90'
                        }`}
                      />
                    </div>
                  </div>
                  {drawerExpanded && drawerMinor !== null && (
                    <div className="border-t border-white/5 bg-surface-drawer py-1 pl-10 pr-4">
                      {drawerEntries.map((entry) => {
                        const entryCopy = entry.copy
                        const entryUpdate = entryCopy ? (updateByCopyId.get(entryCopy.id) ?? null) : null
                        // progress renders only on the row of the build being installed —
                        // the update target has its own drawer row, mirroring it on the
                        // carrier would read as two parallel installs
                        const entryProgress = entryCopy
                          ? undefined
                          : entry.build
                            ? progressById[entry.build.id]
                            : undefined
                        const entryInFlight =
                          entryProgress !== undefined &&
                          entryProgress.phase !== 'error' &&
                          entryProgress.phase !== 'done'
                        const entryUpdateProgress = entryUpdate ? progressById[entryUpdate.id] : undefined
                        const entryUpdateBusy =
                          entryUpdateProgress !== undefined &&
                          entryUpdateProgress.phase !== 'error' &&
                          entryUpdateProgress.phase !== 'done'
                        const entryCancellable =
                          entryProgress?.phase === 'downloading'
                            ? entry.build
                            : entryUpdateProgress?.phase === 'downloading'
                              ? entryUpdate
                              : null
                        const entryNotesUrl = notesUrlForBuild(entry.build, entry.version)
                        const entryRemoving = entryCopy !== null && removingIds.has(entryCopy.id)
                        const entryTarget = entryUpdate
                          ? entryUpdate.version !== entry.version
                            ? entryUpdate.version
                            : cycleClass(entryUpdate.releaseCycle) !== cycleClass(entry.releaseCycle)
                              ? `${entryUpdate.version} ${entryUpdate.releaseCycle}`
                              : null
                          : null
                        return (
                          <div key={entry.key} className="flex items-center gap-4 py-1.5">
                            <div className="flex w-44 shrink-0 items-center gap-2">
                              <span
                                className={`h-1.5 w-1.5 shrink-0 rounded-full ${
                                  entryCopy ? 'bg-emerald-400' : 'bg-transparent'
                                }`}
                                title={entryCopy ? t('installs.installed') : undefined}
                              />
                              <span className="text-[13px] font-semibold text-zinc-300">{entry.version}</span>
                              <CycleBadge cycle={entry.releaseCycle} />
                            </div>
                            <div className="min-w-0 flex-1">
                              {entryProgress ? (
                                <ProgressLine progress={entryProgress} />
                              ) : entryCopy ? (
                                entryRemoving ? (
                                  <ProgressLine progress={{ buildId: entryCopy.id, phase: 'removing' }} />
                                ) : (
                                  <p className="truncate text-[11px] text-zinc-600" title={entryCopy.path}>
                                    {entryCopy.path}
                                  </p>
                                )
                              ) : entry.build ? (
                                <p className="truncate text-[11px] text-zinc-600">
                                  {[
                                    showSize ? formatBytes(entry.build.fileSize) : '',
                                    entry.build.fileMtime > 0 ? formatDate(entry.build.fileMtime) : ''
                                  ]
                                    .filter(Boolean)
                                    .join(' · ')}
                                </p>
                              ) : null}
                            </div>
                            <div className="flex shrink-0 items-center gap-1.5">
                              {entryCancellable && (
                                <button
                                  onClick={() => cancelInstall(entryCancellable.id)}
                                  className="rounded-lg border border-white/10 px-3 py-1 text-xs font-medium text-zinc-300 transition-colors hover:border-red-500/30 hover:bg-red-500/10 hover:text-red-400"
                                >
                                  <ActionLabel>{t('common.cancel')}</ActionLabel>
                                </button>
                              )}
                              {entryCopy ? (
                                <>
                                  {entryUpdate && !entryUpdateBusy && !entryRemoving && (
                                    <button
                                      onClick={() => startUpdate(entryUpdate)}
                                      title={t('installs.updateHint', {
                                        build: t('installs.buildName', {
                                          version: entryUpdate.version,
                                          cycle: entryUpdate.releaseCycle
                                        })
                                      })}
                                      className="rounded-lg border border-blender/40 px-3 py-1 text-xs font-medium text-blender transition-colors hover:bg-blender/10"
                                    >
                                      {entryTarget
                                        ? t('installs.updateTo', { target: entryTarget })
                                        : t('installs.update')}
                                    </button>
                                  )}
                                  <button
                                    disabled={entryUpdateBusy || entryRemoving}
                                    title={entryUpdateBusy ? t('installs.busyUpdating') : undefined}
                                    onClick={() =>
                                      buildsApi.launch(entryCopy.id).catch((error) =>
                                        alertDialog(cleanErrorMessage(error))
                                      )
                                    }
                                    className="rounded-lg border border-transparent bg-accent-button px-3 py-1 text-xs font-medium text-on-accent transition-colors hover:bg-accent-button-hover disabled:cursor-not-allowed disabled:opacity-40"
                                  >
                                    <ActionLabel>{t('installs.launch')}</ActionLabel>
                                  </button>
                                </>
                              ) : entryInFlight || !entry.build ? null : (
                                <button
                                  onClick={() => entry.build && requestInstall(entry.build)}
                                  disabled={!isDesktop}
                                  title={
                                    !isDesktop
                                      ? t('installs.desktopOnly')
                                      : cycleClass(entry.releaseCycle) === 'candidate'
                                        ? t('installs.preReleaseInstallHint', {
                                            version: releasedNewestByMinor.get(drawerMinor)?.version ?? ''
                                          })
                                        : undefined
                                  }
                                  className="shrink-0 rounded-lg border border-emerald-500/40 px-3 py-1 text-xs font-medium text-emerald-400 transition-colors hover:bg-emerald-500/10 disabled:cursor-not-allowed disabled:opacity-40"
                                >
                                  <ActionLabel>{t('common.install')}</ActionLabel>
                                </button>
                              )}
                              {/* every sub-row carries the same menu as the top rows, even
                                  when release notes are its only entry — the action cluster
                                  keeps one shape down the drawer */}
                              {(entryNotesUrl || entryCopy) && (
                                <Dropdown
                                  open={moreMenuFor === entry.key}
                                  onClose={() => setMoreMenuFor(null)}
                                  align="right"
                                  menuClassName="min-w-44 overflow-hidden rounded-lg border border-white/10 bg-surface-menu py-1 text-sm shadow-xl"
                                  trigger={
                                    <button
                                      disabled={entryRemoving}
                                      onClick={() =>
                                        setMoreMenuFor(moreMenuFor === entry.key ? null : entry.key)
                                      }
                                      title={t('installs.moreActions')}
                                      className="rounded-lg border border-white/10 p-1.5 text-zinc-400 transition-colors hover:bg-white/10 hover:text-zinc-200 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-zinc-400"
                                    >
                                      <DotsIcon className="h-3.5 w-3.5" />
                                    </button>
                                  }
                                >
                                  {entryNotesUrl && (
                                    <button
                                      onClick={() => {
                                        setMoreMenuFor(null)
                                        window.open(entryNotesUrl, '_blank', 'noopener')
                                      }}
                                      className="block w-full px-3 py-1.5 text-left text-zinc-300 transition-colors hover:bg-white/10"
                                    >
                                      {entry.build?.source === 'patch'
                                        ? t('installs.showPrDetails')
                                        : t('installs.releaseNotes')}
                                    </button>
                                  )}
                                  {entryCopy && (
                                    <button
                                      disabled={entryUpdateBusy}
                                      onClick={() => {
                                        setMoreMenuFor(null)
                                        buildsApi.openFolder(entryCopy.id).catch(() => undefined)
                                      }}
                                      className="block w-full px-3 py-1.5 text-left text-zinc-300 transition-colors hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
                                    >
                                      {t('installs.openFolder')}
                                    </button>
                                  )}
                                  {entryCopy && (
                                    <button
                                      disabled={entryUpdateBusy}
                                      onClick={() => {
                                        setMoreMenuFor(null)
                                        removeInstall(entryCopy)
                                      }}
                                      className="block w-full px-3 py-1.5 text-left text-red-400 transition-colors hover:bg-red-500/10 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-transparent"
                                    >
                                      {entryCopy.managed ? t('installs.uninstall') : t('installs.removeFromList')}
                                    </button>
                                  )}
                                </Dropdown>
                              )}
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  )}
                  </Fragment>
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
    {runningGate && (
      <RunningBlenderGate
        api={api}
        minors={runningGate.minors}
        initial={runningGate.initial}
        onProceed={() => {
          const resume = runningGate.resume
          setRunningGate(null)
          resume()
        }}
        onCancel={() => setRunningGate(null)}
      />
    )}
    </>
  )
}

