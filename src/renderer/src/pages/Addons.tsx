import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import PageLayout from '../components/PageLayout'
import Dropdown from '../components/Dropdown'
import { FilterSelect } from '../components/FilterSelect'
import StickyHScrollbar from '../components/StickyHScrollbar'
import MirrorVScrollbar from '../components/MirrorVScrollbar'
import HScrollEdgeShadows from '../components/HScrollEdgeShadows'
import { useDialog } from '../components/Dialog'
import RunningBlenderGate from '../components/RunningBlenderGate'
import { cleanErrorMessage } from '../lib/format'
import { useTranslation } from '../lib/i18n'
import { getLauncherApi } from '../lib/preview-fallback'
import { uiGet, uiSet } from '../lib/ui-store'
import { groupAddons, removedBundledInfo } from '../../../shared/addon-identity'
import { compareVersionsDesc } from '../../../shared/blender-builds'
import type {
  AddonApplyProgress,
  AddonInfo,
  AddonScanProgress,
  ApplyPlanRequest,
  ExtensionCatalogItem,
  LibraryAddon,
  LibraryInstallProgress,
  RunningBlender,
  VersionAddons
} from '../../../shared/types'
import { SOURCE_TABS, WIDEST_MINOR } from './addons/constants'
import type { AddonTab } from './addons/constants'
import { Badge, BadgeSlot, CYCLE_STYLES, LONGEST_CYCLE } from '../components/Badge'
import {
  buildMatrix,
  installSourceFor,
  unitSourceFor,
  installBlocker,
  supportUnclear,
  sameSource,
  numericVersion,
  moduleOk,
  pendingKey,
  installKey,
  PENDING_SEP
} from './addons/matrix'
import {
  GearIcon,
  FolderOpenIcon,
  InfoIcon,
  TrashIcon,
  TagIcon,
  ChevronDownIcon,
  RefreshIcon
} from './addons/icons'
import { StatusCell, InstallCell } from './addons/cells'
import type { InstallSource, MatrixRow, MatrixUnit } from './addons/types'

function rowMatchesQuery(row: MatrixRow, q: string): boolean {
  return (
    row.name.toLowerCase().includes(q) ||
    row.category.toLowerCase().includes(q) ||
    row.canonicalId.toLowerCase().includes(q) ||
    [...row.perMinor.values()].some((addon) => addon.module.toLowerCase().includes(q))
  )
}

export default function AddonsPage({
  onOpenSettings,
  initialSearch
}: {
  onOpenSettings?: (highlight?: string) => void
  /** pre-filled search (drag-and-drop lands here with the added add-on's name) */
  initialSearch?: string
}) {
  const { api, isDesktop } = getLauncherApi()
  const addonsApi = api.addons
  const { t } = useTranslation()
  const { confirm: confirmDialog, alert: alertDialog } = useDialog()
  const tableScrollRef = useRef<HTMLDivElement>(null)
  const tableInnerRef = useRef<HTMLDivElement>(null)
  const stickyColRef = useRef<HTMLTableCellElement>(null)
  // top offsets (in unscrolled content space) of each body row's separator overlay — see the
  // useLayoutEffect below the JSX-building callbacks, once visibleRows/expandedRows are in scope
  const [rowDividerTops, setRowDividerTops] = useState<number[]>([])
  // bounding the table's own height (rather than letting the whole page scroll past it) is what
  // lets its header stick: `overflow-x-auto` alone makes the browser compute overflow-y as
  // 'auto' too (CSS visible->auto coupling), but that only becomes a REAL scroll container —
  // the one `position: sticky` binds to — once the box has a height to overflow against.
  const [maxTableHeight, setMaxTableHeight] = useState<number | undefined>(undefined)
  useLayoutEffect(() => {
    const recompute = () => {
      const el = tableScrollRef.current
      if (!el) return
      const top = el.getBoundingClientRect().top
      // 24 = PageLayout's bottom padding (pb-6): without the bar the card ends flush with
      // it; the attached bar below carries -mb-4 and paints INTO that padding (the scroll
      // clip is the padding box), so the page never gains a scroll while the card+bar
      // reach ~8px from the window edge instead of hovering 40px above it
      const available = Math.max(240, Math.floor(window.innerHeight - top - 24))
      setMaxTableHeight((previous) => (previous === available ? previous : available))
    }
    recompute()
    window.addEventListener('resize', recompute)
    return () => window.removeEventListener('resize', recompute)
  })
  const [data, setData] = useState<VersionAddons[] | null>(null)
  const [scanning, setScanning] = useState(false)
  // silent background rescan on page open — only the Rescan button reflects it
  const [refreshing, setRefreshing] = useState(false)
  const autoScanStarted = useRef(false)
  const [scanProgress, setScanProgress] = useState<AddonScanProgress | null>(null)
  const [applying, setApplying] = useState(false)
  const [applyProgress, setApplyProgress] = useState<AddonApplyProgress | null>(null)
  const [installProgress, setInstallProgress] = useState<LibraryInstallProgress | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState(initialSearch ?? '')
  // a drop-initiated visit starts on All: the added add-on's row may fold into any
  // source tab (and can even move once a catalog loads), All shows it regardless
  const [tab, setTab] = useState<AddonTab>(initialSearch ? 'all' : 'user')
  // Sort/filter selects mirroring the Installs toolbar. Persisted like the Projects ones:
  // the page unmounts on every tab switch, so plain state would reset on each visit.
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>(() =>
    uiGet('addons.sortDir') === 'desc' ? 'desc' : 'asc'
  )
  const [enabledFilter, setEnabledFilter] = useState<'all' | 'enabled' | 'disabled'>(() => {
    const stored = uiGet('addons.enabledFilter')
    return stored === 'enabled' || stored === 'disabled' ? stored : 'all'
  })
  useEffect(() => {
    uiSet('addons.sortDir', sortDir)
  }, [sortDir])
  useEffect(() => {
    uiSet('addons.enabledFilter', enabledFilter)
  }, [enabledFilter])
  // Blender-style "Show Tags" filter: a category is visible unless it's in this set
  const [hiddenCategories, setHiddenCategories] = useState<Set<string>>(() => new Set())
  const [categoryMenuOpen, setCategoryMenuOpen] = useState(false)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [showTabCounts, setShowTabCounts] = useState(() => uiGet('addons.showTabCounts') === '1')
  const [showLegend, setShowLegend] = useState(() => uiGet('addons.showLegend') !== '0')
  const [showVersionCount, setShowVersionCount] = useState(
    () => uiGet('addons.showVersionCount') === '1'
  )
  const [showDescription, setShowDescription] = useState(
    () => uiGet('addons.showDescription') === '1'
  )
  const [showVersionBadge, setShowVersionBadge] = useState(
    () => uiGet('addons.showVersionBadge') !== '0'
  )
  useEffect(() => {
    uiSet('addons.showTabCounts', showTabCounts ? '1' : '0')
  }, [showTabCounts])
  useEffect(() => {
    uiSet('addons.showLegend', showLegend ? '1' : '0')
  }, [showLegend])
  useEffect(() => {
    uiSet('addons.showVersionCount', showVersionCount ? '1' : '0')
  }, [showVersionCount])
  useEffect(() => {
    uiSet('addons.showDescription', showDescription ? '1' : '0')
  }, [showDescription])
  useEffect(() => {
    uiSet('addons.showVersionBadge', showVersionBadge ? '1' : '0')
  }, [showVersionBadge])
  // the minor whose version-header dropdown is open
  const [versionMenu, setVersionMenu] = useState<string | null>(null)
  // "clipboard" of the version-header menu: the add-on set copied from one version,
  // pasted into another as staged enables/installs (applied with the usual Apply)
  const [copiedSet, setCopiedSet] = useState<{ minor: string; groupIds: string[] } | null>(null)
  const [pending, setPending] = useState<Map<string, boolean>>(() => new Map())
  const [pendingInstall, setPendingInstall] = useState<Map<string, InstallSource>>(() => new Map())
  const [library, setLibrary] = useState<LibraryAddon[]>([])
  const [libraryAdding, setLibraryAdding] = useState(false)
  // rows unfolded via the leading ▸ arrow — reveals the description and version/library sub-rows
  const [expandedRows, setExpandedRows] = useState<Set<string>>(() => new Set())
  const [superhiveConnected, setSuperhiveConnected] = useState(false)
  const [superhiveCatalog, setSuperhiveCatalog] = useState<ExtensionCatalogItem[]>([])
  const [superhiveError, setSuperhiveError] = useState<string | null>(null)
  // no token needed for the public blender.org catalog — "connected" here just means
  // the last fetch succeeded (starts false/red until the first attempt resolves)
  const [blenderOrgConnected, setBlenderOrgConnected] = useState(false)
  const [blenderOrgCatalog, setBlenderOrgCatalog] = useState<ExtensionCatalogItem[]>([])
  const [blenderOrgError, setBlenderOrgError] = useState<string | null>(null)
  const [uninstalling, setUninstalling] = useState(false)
  // open gate dialog: the operation stalled because these Blender versions are running
  const [runningGate, setRunningGate] = useState<{
    minors: string[]
    initial: RunningBlender[]
    resume: () => void
  } | null>(null)

  const busy = scanning || applying || libraryAdding || uninstalling

  const loadSuperhiveCatalog = useCallback(async () => {
    setSuperhiveError(null)
    try {
      setSuperhiveCatalog(await addonsApi.superhiveList())
    } catch (err) {
      setSuperhiveError(cleanErrorMessage(err))
    }
  }, [addonsApi])

  const loadBlenderOrgCatalog = useCallback(async () => {
    setBlenderOrgError(null)
    try {
      setBlenderOrgCatalog(await addonsApi.blenderOrgList())
      setBlenderOrgConnected(true)
    } catch (err) {
      setBlenderOrgConnected(false)
      setBlenderOrgError(cleanErrorMessage(err))
    }
  }, [addonsApi])

  useEffect(() => {
    if (superhiveConnected) loadSuperhiveCatalog()
  }, [superhiveConnected, loadSuperhiveCatalog])

  // main's op-lock rejects a scan colliding with another headless operation (e.g. a
  // sync apply) — for AUTOMATIC scans that's routine, not an error worth a banner
  const opLockBusy = (message: string): boolean => /is already running/.test(message)

  const runScan = useCallback(
    async (auto = false) => {
      setScanning(true)
      setError(null)
      setScanProgress(null)
      try {
        setData(await addonsApi.scan())
        setPending(new Map())
        setPendingInstall(new Map())
        if (superhiveConnected) loadSuperhiveCatalog()
        loadBlenderOrgCatalog()
        addonsApi.libraryList().then(setLibrary).catch(() => {})
      } catch (err) {
        const message = cleanErrorMessage(err)
        if (!auto || !opLockBusy(message)) setError(message)
      } finally {
        setScanning(false)
        setScanProgress(null)
      }
    },
    [addonsApi, superhiveConnected, loadSuperhiveCatalog, loadBlenderOrgCatalog]
  )

  // silent rescan underneath the cached table: no busy overlay, and staged edits
  // survive — only the toggles that still differ from the fresh real state are kept
  const refreshScan = useCallback(async () => {
    setRefreshing(true)
    try {
      const fresh = await addonsApi.scan()
      setData(fresh)
      setPending((previous) => {
        if (previous.size === 0) return previous
        const next = new Map<string, boolean>()
        for (const [key, desired] of previous) {
          const [minor, module] = key.split(PENDING_SEP)
          const addon = fresh
            .find((version) => version.minor === minor)
            ?.addons.find((candidate) => candidate.module === module)
          if (addon && !addon.missing && addon.enabled !== desired) next.set(key, desired)
        }
        return next
      })
      addonsApi.libraryList().then(setLibrary).catch(() => {})
    } catch (err) {
      const message = cleanErrorMessage(err)
      if (!opLockBusy(message)) setError(message)
    } finally {
      setRefreshing(false)
    }
  }, [addonsApi])

  useEffect(() => {
    addonsApi.getCached().then((cached) => {
      if (cached) setData(cached)
      if (!isDesktop || autoScanStarted.current) return
      autoScanStarted.current = true
      // the page keeps itself fresh: full scan UI when nothing is cached yet,
      // a silent refresh underneath the cached table otherwise
      if (cached) void refreshScan()
      else void runScan(true)
    })
    addonsApi.libraryList().then(setLibrary).catch(() => {})
    addonsApi
      .superhiveStatus()
      .then((status) => setSuperhiveConnected(status.connected))
      .catch(() => {})
    loadBlenderOrgCatalog()
    const offScan = addonsApi.onScanProgress(setScanProgress)
    const offApply = addonsApi.onApplyProgress(setApplyProgress)
    const offLibrary = addonsApi.onLibraryProgress(setInstallProgress)
    // the background auto-backup finished storing new files after a scan/apply
    const offChanged = addonsApi.onLibraryChanged(() => {
      addonsApi.libraryList().then(setLibrary).catch(() => {})
    })
    return () => {
      offScan()
      offApply()
      offLibrary()
      offChanged()
    }
  }, [addonsApi, api.builds])

  const superhivePkgIds = useMemo(
    () => new Set(superhiveCatalog.map((item) => item.pkgId)),
    [superhiveCatalog]
  )
  const rows = useMemo(
    () =>
      data
        ? buildMatrix(groupAddons(data, { superhivePkgIds }), superhiveCatalog, blenderOrgCatalog, library, superhivePkgIds)
        : [],
    [data, superhiveCatalog, blenderOrgCatalog, library, superhivePkgIds]
  )
  const countBySource = useMemo(() => {
    const counts: Record<AddonTab, number> = { all: rows.length, user: 0, superhive: 0, blender_org: 0, builtin: 0 }
    // a row is counted in every tab it belongs to — counts can overlap by design
    for (const row of rows) for (const src of row.sources) counts[src]++
    return counts
  }, [rows])

  // categories available in the current tab — the filter offers only choices that exist there
  const categories = useMemo(() => {
    const set = new Set<string>()
    for (const row of rows) if ((tab === 'all' || row.sources.has(tab)) && row.category) set.add(row.category)
    return [...set].sort((a, b) => a.localeCompare(b))
  }, [rows, tab])

  const visibleRows = useMemo(() => {
    const q = query.trim().toLowerCase()
    const filtered = rows.filter((row) => {
      if (tab !== 'all' && !row.sources.has(tab)) return false
      if (row.category && hiddenCategories.has(row.category)) return false
      if (enabledFilter !== 'all') {
        // same three states the cell legend uses: a row is enabled when a real copy is
        // on in some version, disabled when copies exist but all are off. Rows with no
        // copy at all (catalog/library-only) are neither — they show under All only.
        const installed = [...row.perMinor.values()].filter((addon) => !addon.missing)
        const enabled = installed.some((addon) => addon.enabled)
        if (enabledFilter === 'enabled' ? !enabled : enabled || installed.length === 0) return false
      }
      return !q || rowMatchesQuery(row, q)
    })
    // the select drives a plain alphabetical order — buildMatrix's own
    // enabled-first grouping would read as "why isn't this sorted?" next to it
    const factor = sortDir === 'asc' ? 1 : -1
    return [...filtered].sort((a, b) => a.name.localeCompare(b.name) * factor)
  }, [rows, tab, query, hiddenCategories, enabledFilter, sortDir])

  const okMinors = useMemo(
    () => new Set((data ?? []).filter((version) => !version.error).map((version) => version.minor)),
    [data]
  )
  // the widest badge label actually on screen — the badge slot reserves only this, so the
  // columns stay even without padding every one out to the theoretical longest cycle word
  const widestVersionBadge = useMemo(
    () =>
      (data ?? []).reduce((widest, version) => {
        const label = (version.error ? t('addons.errorBadge') : version.releaseCycle) ?? ''
        return label.length > widest.length ? label : widest
      }, ''),
    [data, t]
  )

  const toggleCell = useCallback((minor: string, addon: AddonInfo) => {
    if (!moduleOk(addon.module)) return
    setPending((previous) => {
      const next = new Map(previous)
      const key = pendingKey(minor, addon.module)
      const current = next.get(key) ?? addon.enabled
      const desired = !current
      if (desired === addon.enabled) next.delete(key)
      else next.set(key, desired)
      return next
    })
  }, [])

  const stageInstall = useCallback((minor: string, key: string, src: InstallSource) => {
    if (installBlocker(src, minor)) return
    setPendingInstall((previous) => {
      const next = new Map(previous)
      if (next.has(key)) next.delete(key)
      else next.set(key, src)
      return next
    })
  }, [])

  // pick which VERSION installs into a column — one per Blender, so choosing another version for the
  // same column replaces the previous pick; clicking the current pick again cancels it
  const pickInstall = useCallback((minor: string, key: string, src: InstallSource) => {
    if (installBlocker(src, minor)) return
    setPendingInstall((previous) => {
      const next = new Map(previous)
      if (sameSource(next.get(key), src)) next.delete(key)
      else next.set(key, src)
      return next
    })
  }, [])

  // drop a staged install for a column (used by the "released" installed cell to undo a switch)
  const cancelInstall = useCallback((key: string) => {
    setPendingInstall((previous) => {
      if (!previous.has(key)) return previous
      const next = new Map(previous)
      next.delete(key)
      return next
    })
  }, [])

  const toggleInstall = useCallback(
    (minor: string, row: MatrixRow) => {
      const src = installSourceFor(row, minor) // best source for THIS version (repo vs stored copy)
      if (!src) return
      stageInstall(minor, installKey(minor, row.groupId), src)
    },
    [stageInstall]
  )

  const toggleExpanded = useCallback((groupId: string) => {
    setExpandedRows((previous) => {
      const next = new Set(previous)
      if (next.has(groupId)) next.delete(groupId)
      else next.add(groupId)
      return next
    })
  }, [])

  // the row switch means "active in EVERY version it can be" — so it both enables installed copies
  // and stages installs into the versions where it is missing but installable. `activatable` is the
  // set of such columns (installed non-core cell, or an empty cell the row has a source for),
  // computed in the render where data/installVia are in scope.
  const toggleRowEverywhere = useCallback(
    (row: MatrixRow, activatable: { minor: string; addon?: AddonInfo; src?: InstallSource }[], currentlyOn: boolean) => {
      const turnOn = !currentlyOn
      setPending((previous) => {
        const next = new Map(previous)
        for (const { minor, addon } of activatable) {
          if (!addon) continue
          const key = pendingKey(minor, addon.module)
          if (turnOn === addon.enabled) next.delete(key)
          else next.set(key, turnOn)
        }
        return next
      })
      setPendingInstall((previous) => {
        const next = new Map(previous)
        for (const { minor, src } of activatable) {
          if (!src) continue // only the empty-but-installable columns (each with its own best source)
          const key = installKey(minor, row.groupId)
          if (turnOn) next.set(key, src)
          else next.delete(key)
        }
        return next
      })
    },
    []
  )

  // snapshot which add-ons are effectively ON in a version (staged toggles included)
  const copyEnabledSet = useCallback(
    (minor: string) => {
      const groupIds: string[] = []
      for (const row of rows) {
        const addon = row.perMinor.get(minor)
        if (!addon || addon.missing || addon.origin === 'core' || !moduleOk(addon.module)) continue
        if (pending.get(pendingKey(minor, addon.module)) ?? addon.enabled) groupIds.push(row.groupId)
      }
      setCopiedSet({ minor, groupIds })
    },
    [rows, pending]
  )

  // stage the copied set onto a version: enable what is installed, tick an install for
  // what is missing (same per-version best source as the empty-cell checkboxes). Purely
  // additive — nothing outside the copied set is disabled. Applied with the usual Apply.
  const pasteSet = useCallback(
    (minor: string) => {
      if (!copiedSet) return
      const byId = new Map(rows.map((row) => [row.groupId, row]))
      setPending((previous) => {
        const next = new Map(previous)
        for (const groupId of copiedSet.groupIds) {
          const addon = byId.get(groupId)?.perMinor.get(minor)
          if (!addon || addon.missing || addon.origin === 'core' || !moduleOk(addon.module)) continue
          const key = pendingKey(minor, addon.module)
          if (addon.enabled) next.delete(key)
          else next.set(key, true)
        }
        return next
      })
      setPendingInstall((previous) => {
        const next = new Map(previous)
        for (const groupId of copiedSet.groupIds) {
          const row = byId.get(groupId)
          if (!row || row.perMinor.get(minor)) continue
          const src = installSourceFor(row, minor)
          if (src) next.set(installKey(minor, row.groupId), src)
        }
        return next
      })
    },
    [copiedSet, rows]
  )

  const launchVersion = useCallback(
    (installId: string) => {
      api.builds.launch(installId).catch((err) => setError(cleanErrorMessage(err)))
    },
    [api.builds]
  )

  const pendingCount = pending.size + pendingInstall.size

  // A running Blender re-saves its in-memory preferences on top of whatever our
  // headless run writes (ghost add-on entries). Operations that write prefs go
  // through this gate: run now when the affected minors are closed, otherwise park
  // the continuation in the RunningBlenderGate dialog.
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
    [api.builds]
  )

  const applyChanges = useCallback(async () => {
    if (!data || pendingCount === 0) return
    const versions = new Set<string>()
    for (const key of pending.keys()) versions.add(key.split(PENDING_SEP)[0])
    for (const key of pendingInstall.keys()) versions.add(key.split(PENDING_SEP)[0])
    // dropped built-ins are unsupported carry-forwards — call it out before launching Blender
    const unsupported = [...pendingInstall.values()].some((src) => src.unsupported)
    // installs into Blender versions the add-on never declared support for (reddish squares)
    const undeclared = [...pendingInstall.entries()].some(
      ([key, src]) => !src.unsupported && supportUnclear(src, key.split(PENDING_SEP)[0])
    )
    // a pick that lands where a different removable copy already sits switches versions there
    const replaces = [...pendingInstall.keys()].some((key) => {
      const [minor, groupId] = key.split(PENDING_SEP)
      const occ = rows.find((r) => r.groupId === groupId)?.perMinor.get(minor)
      return Boolean(occ && !occ.missing && (occ.origin === 'user' || occ.origin === 'extension'))
    })
    const ok = await confirmDialog({
      title: t('addons.applyConfirmTitle'),
      message:
        t('addons.applyConfirmMessage', { versions: [...versions].sort(compareVersionsDesc).join(', ') }) +
        (replaces ? t('addons.applyNoteReplaces') : '') +
        (unsupported ? t('addons.applyNoteUnsupported') : '') +
        (undeclared ? t('addons.applyNoteUndeclared') : ''),
      confirmLabel: t('common.apply')
    })
    if (!ok) return
    const run = async (): Promise<void> => {
      setApplying(true)
      setError(null)
      const failures: string[] = []
      try {
        // ONE plan, ONE call: main resolves the sources (downloads/packs in parallel) and then
        // runs a single headless Blender per affected version doing all its operations at once.
        const rowsById = new Map(rows.map((r) => [r.groupId, r]))
        const plan: ApplyPlanRequest = { installs: [], uninstalls: [], enable: [], disable: [] }
        // pretty names for failure lines — results echo the source id, not the display name
        const labels = new Map<string, string>()
        for (const [key, src] of pendingInstall) {
          const [minor, groupId] = key.split(PENDING_SEP)
          // a staged install landing where a DIFFERENT copy of this add-on sits is a version
          // switch: the sitting copy is uninstalled first, in the same Blender run
          const occupant = rowsById.get(groupId)?.perMinor.get(minor)
          if (occupant && !occupant.missing && (occupant.origin === 'user' || occupant.origin === 'extension')) {
            plan.uninstalls.push({ minor, module: occupant.module })
          }
          labels.set(src.id, rowsById.get(groupId)?.name ?? src.id)
          plan.installs.push(
            src.kind === 'backup'
              ? { minor, kind: src.kind, id: src.id, module: src.module, sourceMinor: src.sourceMinor }
              : { minor, kind: src.kind, id: src.id }
          )
        }
        for (const [key, desired] of pending) {
          const [minor, module] = key.split(PENDING_SEP)
          ;(desired ? plan.enable : plan.disable).push({ minor, module })
        }
        const hadBackups = plan.installs.some((request) => request.kind === 'backup')

        const outcome = await addonsApi.applyPlan(plan)
        for (const result of outcome.results) {
          if (result.op === 'install' && result.status !== 'ok') {
            failures.push(
              t('addons.failInstallLine', {
                name: labels.get(result.id) ?? result.id,
                minor: result.minor,
                detail: result.detail ?? result.status
              })
            )
          } else if (result.op === 'uninstall' && result.status === 'error') {
            // 'skipped' = nothing was there to remove, which is fine for a switch
            failures.push(
              t('addons.failUninstallLine', { minor: result.minor, detail: result.detail ?? result.status })
            )
          } else if ((result.op === 'enable' || result.op === 'disable') && result.status === 'error') {
            failures.push(
              t('addons.failToggleLine', {
                id: result.id,
                minor: result.minor,
                detail: result.detail ?? t('addons.failed')
              })
            )
          }
        }
        if (outcome.data) setData([...outcome.data])
        if (outcome.libraryChanged || hadBackups) setLibrary(await addonsApi.libraryList())
        setPending(new Map())
        setPendingInstall(new Map())
        if (failures.length > 0) await alertDialog(t('addons.applyFailures', { failures: failures.join('\n') }))
      } catch (err) {
        setError(cleanErrorMessage(err))
      } finally {
        setApplying(false)
        setApplyProgress(null)
        setInstallProgress(null)
      }
    }
    await gateOnRunning([...versions], run)
  }, [addonsApi, data, rows, pending, pendingInstall, pendingCount, gateOnRunning, confirmDialog, alertDialog, t])

  const addToLibrary = useCallback(async () => {
    setLibraryAdding(true)
    try {
      const result = await addonsApi.libraryAdd()
      if (!result) return // dialog canceled
      if (result.added.length > 0) setLibrary(await addonsApi.libraryList())
      // duplicates are a silent skip; only real failures warrant an alert
      if (result.failed.length > 0) {
        const context: string[] = []
        if (result.added.length > 0) context.push(t('addons.addedCount', { count: result.added.length }))
        if (result.skipped.length > 0)
          context.push(t('addons.alreadyInLibrary', { count: result.skipped.length }))
        const head = context.length > 0 ? `${context.join(', ')}.\n\n` : ''
        const failTail = result.failed.map((f) => `• ${f.fileName}: ${f.error}`).join('\n')
        await alertDialog(`${head}${t('addons.couldNotAdd', { failures: failTail })}`)
      }
    } catch (err) {
      await alertDialog(cleanErrorMessage(err))
    } finally {
      setLibraryAdding(false)
    }
  }, [addonsApi, alertDialog, t])

  // fully remove one version of an add-on: delete its files from the Blender versions where it is
  // installed (headless, via Blender's own remove operators) AND drop the stored Library copy.
  // `targets` are the exact (minor, module) install sites; `libId` the stored file, if any.
  const uninstallVersion = useCallback(
    async (name: string, addonVersion: string, targets: { minor: string; module: string }[], libId: string | null) => {
      if (targets.length === 0 && !libId) return
      const minors = [...new Set(targets.map((target) => target.minor))].sort(compareVersionsDesc)
      const parts: string[] = []
      if (minors.length) parts.push(t('addons.uninstallDeletePart', { minors: minors.join(', ') }))
      if (libId) parts.push(t('addons.uninstallLibraryPart'))
      const ok = await confirmDialog({
        title: t('addons.uninstallConfirmTitle', {
          name: `${name}${addonVersion && addonVersion !== '?' ? ` v${addonVersion}` : ''}`
        }),
        message: `${t('addons.uninstallConfirmMessage', { actions: parts.join(t('addons.andSeparator')) })}${
          minors.length ? t('addons.uninstallCloseWarning') : ''
        }`,
        variant: 'danger',
        tone: 'danger',
        confirmLabel: t('addons.uninstall')
      })
      if (!ok) return
      const run = async (): Promise<void> => {
        setUninstalling(true)
        setError(null)
        try {
          if (targets.length > 0) {
            const outcome = await addonsApi.uninstall(targets)
            if (outcome.data) setData([...outcome.data])
            const failures = outcome.results.filter((result) => result.status !== 'removed')
            if (failures.length > 0) {
              // Blender copy still there → keep the Library backup rather than leave it unrecoverable
              await alertDialog(
                t('addons.keptLibraryCopy', {
                  failures: failures
                    .map((result) =>
                      t('addons.blenderFailLine', { minor: result.minor, detail: result.detail ?? result.status })
                    )
                    .join('\n')
                })
              )
              return
            }
          }
          if (libId) setLibrary(await addonsApi.libraryRemove(libId))
        } catch (err) {
          await alertDialog(cleanErrorMessage(err))
        } finally {
          setUninstalling(false)
        }
      }
      // a library-only removal touches no Blender configs — no need to gate it
      if (minors.length > 0) await gateOnRunning(minors, run)
      else await run()
    },
    [addonsApi, gateOnRunning, confirmDialog, alertDialog, t]
  )

  const applyProgressActive = applyProgress ?? installProgress

  const headerActions = (
    <div className="flex items-center gap-2">
      {pendingCount > 0 && (
        <>
          <button
            onClick={() => {
              setPending(new Map())
              setPendingInstall(new Map())
            }}
            disabled={busy}
            className="rounded-lg border border-white/10 px-3 py-1.5 text-sm font-medium text-zinc-300 transition-colors hover:bg-white/10 disabled:opacity-50"
          >
            {t('common.discard')}
          </button>
          <button
            onClick={applyChanges}
            disabled={busy || refreshing}
            className="rounded-lg bg-accent-button px-3 py-1.5 text-sm font-medium text-on-accent transition-colors hover:bg-accent-button-hover disabled:opacity-50"
          >
            {applying ? t('addons.applying') : t('addons.applyCount', { count: pendingCount })}
          </button>
        </>
      )}
      <button
        onClick={() => runScan()}
        disabled={busy || refreshing || !isDesktop}
        title={isDesktop ? t('addons.rescanTitle') : t('addons.desktopOnly')}
        className="rounded-lg border border-white/10 p-2 text-icon transition-colors hover:bg-white/10 hover:text-icon-hover disabled:opacity-50"
      >
        <RefreshIcon className={`h-4 w-4 ${scanning || refreshing ? 'animate-spin' : ''}`} />
      </button>
      <button
        onClick={addToLibrary}
        disabled={busy || !isDesktop}
        title={isDesktop ? t('addons.addFileTitle') : t('addons.desktopOnly')}
        className="rounded-lg border border-white/10 px-3 py-1.5 text-sm font-medium text-zinc-300 transition-colors hover:bg-white/10 disabled:opacity-50"
      >
        {libraryAdding ? t('addons.adding') : t('addons.addFile')}
      </button>
    </div>
  )

  // Row-separator lines REPLACE each row's `border-t` (removed from the tr classes): a border owned
  // by the (non-positioned) <table>'s collapse rendering paints below any explicitly z-indexed
  // sibling, so the edge-scroll shadow (z-10) was swallowing it exactly like it dims the checkboxes.
  // These overlays sit at z-11 — above the body shadow band, still below the sticky header (z-20).
  // Coordinates: row.top − inner.top is already the offset in inner's content space regardless of
  // the current scroll (both rects shift together) — adding scrollTop would double-count it.
  // The ResizeObserver re-measures on any height change inside the table (expanding a row, toggling
  // a display setting, a background refresh changing the row set) without watching each cause.
  useLayoutEffect(() => {
    const inner = tableInnerRef.current
    if (!inner) return
    const recompute = () => {
      const innerTop = inner.getBoundingClientRect().top
      // skip the first row: its top boundary is the header's own separator (the inset
      // box-shadow on the th cells) — an overlay there would double the line at rest
      const tops = Array.from(inner.querySelectorAll('tbody tr'))
        .slice(1)
        .map((row) => Math.round(row.getBoundingClientRect().top - innerTop))
      setRowDividerTops((previous) =>
        previous.length === tops.length && previous.every((value, index) => value === tops[index])
          ? previous
          : tops
      )
    }
    recompute()
    const observer = new ResizeObserver(recompute)
    observer.observe(inner)
    return () => observer.disconnect()
  }, [data, visibleRows])

  return (
    <PageLayout title={t('addons.title')} actions={headerActions} scrollTargetRef={tableScrollRef}>
      <div className="flex flex-col gap-4">
        {!isDesktop && (
          <div className="rounded-xl border border-sky-500/20 bg-sky-500/5 px-4 py-3 text-xs leading-relaxed text-sky-300">
            {t('addons.browserPreviewNote')}
          </div>
        )}
        {error && (
          <div className="rounded-xl border border-red-500/20 bg-red-500/5 px-4 py-3 text-sm text-red-400">
            {error}
          </div>
        )}
        {superhiveConnected && superhiveError && (
          <div className="rounded-xl border border-amber-500/20 bg-amber-500/5 px-4 py-3 text-xs text-amber-400">
            {t('addons.superhivePrefix', { error: superhiveError })}
          </div>
        )}

        <section>
          {/* same toolbar shape as Installs: sort/filter selects on the left, search and
              display settings on the right, source tabs on their own row underneath */}
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            {data && data.length > 0 ? (
              <>
                <div className="flex flex-wrap items-end gap-2">
                  <FilterSelect
                    label={t('addons.order')}
                    value={sortDir}
                    onChange={setSortDir}
                    options={[
                      { value: 'asc', label: t('addons.ascending') },
                      { value: 'desc', label: t('addons.descending') }
                    ]}
                    fit
                  />
                  <FilterSelect
                    label={t('addons.stateFilterLabel')}
                    value={enabledFilter}
                    onChange={setEnabledFilter}
                    options={[
                      { value: 'all', label: t('addons.stateAll') },
                      { value: 'enabled', label: t('addons.stateEnabled') },
                      { value: 'disabled', label: t('addons.stateDisabled') }
                    ]}
                    fit
                  />
                </div>
                <div className="flex items-center gap-2">
                  {categories.length > 0 && (
                    <Dropdown
                      open={categoryMenuOpen}
                      onClose={() => setCategoryMenuOpen(false)}
                      align="left"
                      menuClassName="w-80 rounded-lg border border-white/10 bg-surface-menu p-3 shadow-xl"
                      trigger={
                        <button
                          onClick={() => setCategoryMenuOpen((open) => !open)}
                          title={t('addons.filterByCategory')}
                          className={`flex items-center gap-1 rounded-lg border border-white/10 p-1.5 transition-colors hover:bg-white/10 ${
                            hiddenCategories.size > 0 ? 'text-blender' : 'text-icon hover:text-icon-hover'
                          }`}
                        >
                          <TagIcon className="h-4 w-4" />
                          <ChevronDownIcon className="h-3 w-3" />
                        </button>
                      }
                    >
                      <div className="mb-2 flex items-center justify-between">
                        <span className="text-xs font-medium text-zinc-400">{t('addons.showTags')}</span>
                        <div className="flex items-center gap-1.5 text-xs text-zinc-500">
                          <span>{t('addons.select')}</span>
                          <button
                            onClick={() => setHiddenCategories(new Set())}
                            className="rounded bg-white/5 px-2 py-0.5 font-medium text-zinc-300 transition-colors hover:bg-white/10"
                          >
                            {t('addons.all')}
                          </button>
                          <button
                            onClick={() => setHiddenCategories(new Set(categories))}
                            className="rounded bg-white/5 px-2 py-0.5 font-medium text-zinc-300 transition-colors hover:bg-white/10"
                          >
                            {t('addons.none')}
                          </button>
                        </div>
                      </div>
                      <div className="grid grid-cols-2 gap-x-3 gap-y-0.5">
                        {categories.map((category) => (
                          <label
                            key={category}
                            className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 text-sm text-zinc-300 transition-colors hover:bg-white/10"
                          >
                            <input
                              type="checkbox"
                              checked={!hiddenCategories.has(category)}
                              onChange={(event) => {
                                setHiddenCategories((previous) => {
                                  const next = new Set(previous)
                                  if (event.target.checked) next.delete(category)
                                  else next.add(category)
                                  return next
                                })
                              }}
                              className="accent-blender"
                            />
                            <span className="truncate">{category}</span>
                          </label>
                        ))}
                      </div>
                    </Dropdown>
                  )}
                  <input
                    type="search"
                    value={query}
                    onChange={(event) => setQuery(event.target.value)}
                    placeholder={t('addons.searchPlaceholder')}
                    className="w-44 rounded-lg border border-white/10 bg-transparent px-3 py-1.5 text-xs text-zinc-200 placeholder:text-zinc-600 focus:border-blender/50 focus:outline-none"
                  />
                  <Dropdown
                    open={settingsOpen}
                    onClose={() => setSettingsOpen(false)}
                    align="right"
                    menuClassName="w-56 rounded-lg border border-white/10 bg-surface-menu p-1 shadow-xl"
                    trigger={
                      <button
                        title={t('addons.displaySettings')}
                        onClick={() => setSettingsOpen((open) => !open)}
                        className="rounded-lg border border-white/10 p-1.5 text-icon transition-colors hover:bg-white/10 hover:text-icon-hover"
                      >
                        <GearIcon className="h-4 w-4" />
                      </button>
                    }
                  >
                    <p className="px-2 py-1 text-[11px] font-medium uppercase tracking-wide text-zinc-500">
                      {t('addons.show')}
                    </p>
                    <label className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm text-zinc-300 transition-colors hover:bg-white/10">
                      <input
                        type="checkbox"
                        checked={showTabCounts}
                        onChange={(event) => setShowTabCounts(event.target.checked)}
                        className="accent-blender"
                      />
                      {t('addons.showTabCounts')}
                    </label>
                    <label className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm text-zinc-300 transition-colors hover:bg-white/10">
                      <input
                        type="checkbox"
                        checked={showLegend}
                        onChange={(event) => setShowLegend(event.target.checked)}
                        className="accent-blender"
                      />
                      {t('addons.showLegend')}
                    </label>
                    <label className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm text-zinc-300 transition-colors hover:bg-white/10">
                      <input
                        type="checkbox"
                        checked={showVersionCount}
                        onChange={(event) => setShowVersionCount(event.target.checked)}
                        className="accent-blender"
                      />
                      {t('addons.showVersionCount')}
                    </label>
                    <label className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm text-zinc-300 transition-colors hover:bg-white/10">
                      <input
                        type="checkbox"
                        checked={showDescription}
                        onChange={(event) => setShowDescription(event.target.checked)}
                        className="accent-blender"
                      />
                      {t('addons.showDescriptions')}
                    </label>
                    <label className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm text-zinc-300 transition-colors hover:bg-white/10">
                      <input
                        type="checkbox"
                        checked={showVersionBadge}
                        onChange={(event) => setShowVersionBadge(event.target.checked)}
                        className="accent-blender"
                      />
                      {t('addons.showVersionBadge')}
                    </label>
                  </Dropdown>
                </div>
              </>
            ) : (
              <h2 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">{t('addons.title')}</h2>
            )}
          </div>
          {data && data.length > 0 && (
            <div className="mb-3 flex flex-wrap gap-1">
              {SOURCE_TABS.map(({ key, labelKey }) => {
                const dotOn = key === 'superhive' ? superhiveConnected : key === 'blender_org' ? blenderOrgConnected : null
                const dotTitle =
                  key === 'superhive'
                    ? superhiveConnected
                      ? t('addons.superhiveDotConnected')
                      : t('addons.superhiveDotDisconnected')
                    : key === 'blender_org'
                      ? (blenderOrgConnected ? t('addons.blenderOrgDotConnected') : (blenderOrgError ?? t('addons.blenderOrgDotUnreachable')))
                      : undefined
                return (
                  <button
                    key={key}
                    onClick={() => setTab(key)}
                    className={`flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium transition-colors ${
                      tab === key ? 'bg-selection text-selection-text' : 'text-zinc-500 hover:bg-white/10 hover:text-zinc-300'
                    }`}
                  >
                    {dotOn !== null && (
                      <span
                        role={key === 'superhive' && !superhiveConnected ? 'button' : undefined}
                        onClick={
                          key === 'superhive' && !superhiveConnected
                            ? (event) => {
                                event.stopPropagation()
                                onOpenSettings?.('superhive')
                              }
                            : undefined
                        }
                        title={dotTitle}
                        className={`h-1.5 w-1.5 shrink-0 rounded-full ${dotOn ? 'bg-emerald-400' : 'bg-red-400'} ${
                          key === 'superhive' && !superhiveConnected ? 'cursor-pointer' : ''
                        }`}
                      />
                    )}
                    {t(labelKey)}
                    {showTabCounts && ` (${countBySource[key]})`}
                  </button>
                )
              })}
            </div>
          )}

          {(scanning || applying) && applyProgressActive && (
            <div className="mb-4 rounded-xl border border-white/10 bg-surface-card px-4 py-3">
              <div className="mb-2 h-1.5 w-full overflow-hidden rounded-full bg-white/10">
                <div
                  className="h-full rounded-full bg-blender transition-[width] duration-200"
                  style={{ width: `${((applyProgressActive.index + 1) / applyProgressActive.total) * 100}%` }}
                />
              </div>
              <p className="text-xs text-zinc-400">
                {scanning
                  ? t('addons.progressReading', { minor: applyProgressActive.minor })
                  : t('addons.progressApplying', { minor: applyProgressActive.minor })}{' '}
                ({Math.min(applyProgressActive.index + 1, applyProgressActive.total)}/{applyProgressActive.total})
              </p>
            </div>
          )}
          {scanning && scanProgress && !applyProgressActive && (
            <div className="mb-4 rounded-xl border border-white/10 bg-surface-card px-4 py-3">
              <div className="mb-2 h-1.5 w-full overflow-hidden rounded-full bg-white/10">
                <div
                  className="h-full rounded-full bg-blender transition-[width] duration-200"
                  style={{ width: `${((scanProgress.index + (scanProgress.phase === 'done' ? 1 : 0)) / scanProgress.total) * 100}%` }}
                />
              </div>
              <p className="text-xs text-zinc-400">
                {t('addons.progressReading', { minor: scanProgress.minor })} (
                {Math.min(scanProgress.index + 1, scanProgress.total)}/{scanProgress.total})
              </p>
            </div>
          )}

          {data === null ? (
            !scanning && (
              <p className="text-sm text-zinc-500">{t('addons.scanIntro')}</p>
            )
          ) : data.length === 0 ? (
            <p className="text-sm text-zinc-500">{t('addons.noVersionsInstalled')}</p>
          ) : (
            <>
              {showLegend && (
                <div className="mb-3 flex flex-wrap items-center gap-4 text-[11px] text-zinc-500">
                  <span className="flex items-center gap-1.5">
                    <span className="inline-block h-2.5 w-2.5 rounded-full bg-[var(--blender-brand)]" /> {t('addons.legendEnabled')}
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className="inline-block h-2.5 w-2.5 rounded-full border border-zinc-600" /> {t('addons.legendDisabled')}
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className="inline-block h-2.5 w-2.5 rounded-sm border border-dashed border-zinc-600" /> {t('addons.legendNotInstalled')}
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className="inline-block h-2.5 w-2.5 rounded-full bg-amber-400" /> {t('addons.legendPendingToggle')}
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className="inline-block h-2.5 w-2.5 rounded-sm bg-amber-400" /> {t('addons.legendPendingInstall')}
                  </span>
                </div>
              )}

              <div className="relative">
                {/* bottomInset 0: this card hides its native horizontal bar (see below),
                    so the shadow can run to the card's bottom edge */}
                <HScrollEdgeShadows targetRef={tableScrollRef} stickyRef={stickyColRef} bottomInset={0} />
                <div
                  ref={tableScrollRef}
                  className="no-native-h-scrollbar no-native-v-scrollbar overflow-x-auto overflow-y-auto rounded-xl border border-white/5"
                  style={{ maxHeight: maxTableHeight }}
                >
                {/* w-fit: the wrapper hugs the table's real (overflowing) width, so the
                    absolute row-divider overlays below span every column, not just the
                    visible viewport slice */}
                <div ref={tableInnerRef} className="relative w-fit min-w-full">
                <table className="w-full border-collapse text-sm">
                  <thead>
                    {/* the header's separator is an inset box-shadow on the CELLS, not a
                        border-b on the row: collapsed table borders paint on the table's own
                        layer and stay at the row's in-flow position — the border would sit
                        still while the sticky cells scroll away from it. A box-shadow paints
                        inside each cell's box and moves (sticks) with it. */}
                    <tr className="bg-surface-card">
                      {/* header cells sit at z-20: above the body's sticky-left cells (z-10)
                          and the row-divider overlays (z-11) scrolling under them, while the
                          HEADER band of the edge shadow (z-30, split in HScrollEdgeShadows)
                          still dims the version labels on horizontal scroll like the cells.
                          The corner is z-30 — strictly above the version cells: at an equal z
                          the later-DOM version headers would paint over it while sliding past
                          on horizontal scroll (the shadow band never overlaps the corner). */}
                      {/* w-full soaks the table's free width into the name column: without it
                          auto layout splits the slack between the version columns, so a couple of
                          installed versions each get a few hundred px of empty cell. With the slack
                          parked here every version column shrinks to its own content instead, which
                          is why the label and badge below each carry their widest sample invisibly.
                          Once enough versions are installed that those columns stop fitting, the
                          table overflows into its horizontal scroll, as it already did. */}
                      <th ref={stickyColRef} className="sticky left-0 top-0 z-30 w-full bg-surface-card px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-zinc-500 header-hairline">
                        {t('addons.colAddon')}
                      </th>
                      {/* p-0 + w-full trigger: the WHOLE header cell is the click target,
                          not just the label — the padding area must not be dead space */}
                      {data.map((version) => (
                        <th key={version.minor} className="sticky top-0 z-20 bg-surface-card p-0 text-center align-bottom header-hairline">
                          <Dropdown
                            className="w-full"
                            open={versionMenu === version.minor}
                            onClose={() => setVersionMenu(null)}
                            align="left"
                            menuClassName="w-44 rounded-lg border border-white/10 bg-surface-menu p-1 shadow-xl"
                            trigger={
                              <button
                                onClick={() =>
                                  setVersionMenu((open) => (open === version.minor ? null : version.minor))
                                }
                                title={version.error ? version.error : `${version.version}${version.scanMethod === 'blender' ? t('addons.deepScannedSuffix') : t('addons.configReadSuffix')}`}
                                className="flex w-full flex-col items-center gap-1 px-2 py-2.5 transition-colors hover:bg-white/10"
                              >
                                <span className="grid text-sm font-semibold tabular-nums text-zinc-200">
                                  <span className="invisible col-start-1 row-start-1">{WIDEST_MINOR}</span>
                                  <span className="col-start-1 row-start-1 text-center">{version.minor}</span>
                                </span>
                                {showVersionBadge && (
                                  <BadgeSlot align="center" size="sm" measure={widestVersionBadge || LONGEST_CYCLE}>
                                    <Badge
                                      size="sm"
                                      tone={version.error ? 'bg-amber-500/15 text-amber-400' : CYCLE_STYLES[version.releaseCycle] ?? undefined}
                                    >
                                      {version.error ? t('addons.errorBadge') : version.releaseCycle}
                                    </Badge>
                                  </BadgeSlot>
                                )}
                              </button>
                            }
                          >
                            <button
                              onClick={() => {
                                copyEnabledSet(version.minor)
                                setVersionMenu(null)
                              }}
                              className="w-full rounded px-2 py-1.5 text-left text-sm text-zinc-300 transition-colors hover:bg-white/10"
                            >
                              {t('addons.copySet')}
                            </button>
                            {copiedSet && copiedSet.minor !== version.minor && (
                              <button
                                onClick={() => {
                                  pasteSet(version.minor)
                                  setVersionMenu(null)
                                }}
                                className="w-full rounded px-2 py-1.5 text-left text-sm text-zinc-300 transition-colors hover:bg-white/10"
                              >
                                {t('addons.pasteSet')}
                              </button>
                            )}
                            <div className="my-1 border-t border-white/5" />
                            <button
                              onClick={() => {
                                launchVersion(version.installId)
                                setVersionMenu(null)
                              }}
                              disabled={busy}
                              className="w-full rounded px-2 py-1.5 text-left text-sm text-zinc-300 transition-colors hover:bg-white/10 disabled:opacity-50"
                            >
                              {t('addons.launchVersion')}
                            </button>
                          </Dropdown>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {visibleRows.length === 0 ? (
                      <tr>
                        <td colSpan={data.length + 1} className="px-4 py-6 text-center text-sm text-zinc-500">
                          {query.trim() || hiddenCategories.size > 0
                            ? t('addons.emptySearch')
                            : tab === 'all'
                              ? t('addons.emptyAll')
                              : tab === 'user'
                                ? t('addons.emptyUser')
                                : tab === 'superhive'
                                  ? superhiveConnected
                                    ? t('addons.emptySuperhive')
                                    : t('addons.emptySuperhiveConnect')
                                  : tab === 'blender_org'
                                    ? t('addons.emptyBlenderOrg')
                                    : t('addons.emptyBuiltin')}
                          {tab === 'superhive' &&
                            !superhiveConnected &&
                            !query.trim() &&
                            hiddenCategories.size === 0 && (
                              <button
                                onClick={() => onOpenSettings?.('superhive')}
                                className="ml-1.5 rounded text-selection underline-offset-2 transition-colors hover:underline"
                              >
                                {t('addons.emptySuperhiveOpenSettings')}
                              </button>
                            )}
                        </td>
                      </tr>
                    ) : (
                      visibleRows.map((row) => {
                        const cells = [...row.perMinor.entries()].filter(([minor]) => okMinors.has(minor))
                        // every column where the add-on CAN be active: an installed toggleable copy
                        // (non-core, files present, valid module) OR an empty cell the row has a source for.
                        // The row switch means "active in all of these", so it drives both enable and install.
                        const activatable: { minor: string; addon?: AddonInfo; src?: InstallSource }[] = []
                        for (const version of data) {
                          if (version.error || !okMinors.has(version.minor)) continue
                          const addon = row.perMinor.get(version.minor)
                          if (addon) {
                            if (addon.origin === 'core' || addon.missing || !moduleOk(addon.module)) continue
                            activatable.push({ minor: version.minor, addon })
                          } else {
                            const src = installSourceFor(row, version.minor)
                            if (src) activatable.push({ minor: version.minor, src })
                          }
                        }
                        const activatableOnCount = activatable.filter(({ minor, addon }) =>
                          addon
                            ? (pending.get(pendingKey(minor, addon.module)) ?? addon.enabled)
                            : pendingInstall.has(installKey(minor, row.groupId))
                        ).length
                        const rowOn = activatable.length > 0 && activatableOnCount === activatable.length
                        const rowSome = activatableOnCount > 0 && activatableOnCount < activatable.length
                        const libraryFiles = row.libraryFiles ?? []
                        // one sub-row per add-on VERSION (installed and/or stored). Each can install that
                        // version into any compatible Blender the user picks — so the choice is theirs.
                        const units = new Map<string, MatrixUnit>()
                        const ensureVersionUnit = (version: string | null, libEntry?: LibraryAddon): MatrixUnit => {
                          const v = version ?? '?'
                          const key = `ver:${v}`
                          let unit = units.get(key)
                          if (!unit) {
                            unit = { key, label: v === '?' ? t('addons.noVersion') : `v${v}`, version, cells: [], removable: [] }
                            units.set(key, unit)
                          }
                          if (libEntry && !unit.libEntry) unit.libEntry = libEntry
                          return unit
                        }
                        for (const file of libraryFiles) ensureVersionUnit(file.version ?? null, file)
                        for (const cell of cells) {
                          const addon = cell[1]
                          if (addon.origin === 'core') continue // core stays on the main row (always on)
                          const unit = ensureVersionUnit(addon.version ?? null)
                          unit.cells.push(cell)
                          if ((addon.origin === 'user' || addon.origin === 'extension') && !addon.missing && moduleOk(addon.module))
                            unit.removable.push(cell)
                        }
                        const unitRows = [...units.values()].sort((a, b) => {
                          const av = numericVersion(a.version)
                          const bv = numericVersion(b.version)
                          if (av && bv) return compareVersionsDesc(av, bv)
                          if (Boolean(av) !== Boolean(bv)) return av ? -1 : 1 // versioned above 'no version'
                          return a.label.localeCompare(b.label)
                        })
                        const newestUnitKey = unitRows[0]?.key
                        // expand when there's more than one version, a stored file, or a removable copy
                        const showSubRows =
                          unitRows.length > 1 || libraryFiles.length > 0 || unitRows.some((unit) => unit.removable.length > 0)
                        const subCount = unitRows.length
                        const hasDescription = showDescription && Boolean(row.description)
                        // one arrow (leading position) reveals description + the per-unit sub-rows
                        const expandable = hasDescription || showSubRows
                        const isExpanded = expandedRows.has(row.groupId)
                        const descExpanded = hasDescription && isExpanded
                        // a former built-in Blender dropped with no blender.org/core replacement
                        const removed = removedBundledInfo(row.canonicalId)
                        return (
                          <Fragment key={row.groupId}>
                          {/* row separators are painted by the divider overlays after the
                              table, not border-t — see the rowDividerTops effect. The row
                              itself stays transparent so the dots sit on the darker page
                              background, like the Sync matrix; only the sticky name cell
                              keeps its own opaque fill for the horizontal-scroll overlap. */}
                          <tr>
                            <td
                              onClick={
                                expandable
                                  ? (event) => {
                                      // the whole name cell toggles the row (same pattern as an
                                      // Installs series row); clicks that land on its own controls
                                      // (the arrow button, the row checkbox) are theirs alone
                                      if ((event.target as HTMLElement).closest('button, input')) return
                                      toggleExpanded(row.groupId)
                                    }
                                  : undefined
                              }
                              className={`sticky left-0 z-10 bg-surface-card px-4 py-2.5 ${
                                expandable ? 'cursor-pointer hover:bg-surface-hover' : ''
                              }`}
                            >
                              <div className="flex items-center gap-2">
                                {/* plain indicator, Installs-style — the whole name cell is the
                                    toggle; rows with nothing to unfold keep an invisible one so
                                    the names line up. Collapsed it points right (-rotate-90),
                                    expanded it turns down; the color stays put in both states. */}
                                <ChevronDownIcon
                                  className={`h-4 w-4 shrink-0 text-zinc-500 transition-transform ${
                                    !expandable ? 'invisible' : isExpanded ? '' : '-rotate-90'
                                  }`}
                                />
                                {isDesktop && activatable.length > 0 && (
                                  <input
                                    type="checkbox"
                                    className="shrink-0 accent-blender"
                                    ref={(el) => {
                                      if (el) el.indeterminate = rowSome
                                    }}
                                    checked={rowOn}
                                    onChange={() => toggleRowEverywhere(row, activatable, rowOn)}
                                    disabled={busy}
                                    title={rowOn ? t('addons.rowOnEverywhere') : t('addons.rowTurnOnEverywhere')}
                                  />
                                )}
                                <span className="truncate text-sm text-zinc-200" title={row.name}>
                                  {row.name}
                                </span>
                                {showVersionCount && subCount > 1 && (
                                  <span
                                    className="shrink-0 text-[10px] font-medium text-zinc-600"
                                    title={t('addons.versionCountHint', { count: subCount })}
                                  >
                                    {subCount}
                                  </span>
                                )}
                                {removed && (
                                  <span
                                    className="shrink-0 rounded bg-red-500/15 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-red-300"
                                    title={t('addons.removedBadgeTitle', { note: removed.note })}
                                  >
                                    {t('addons.removedBadge')}
                                  </span>
                                )}
                                {/* the add-on's own page, when it declares one. stopPropagation:
                                    the whole name cell is the expand toggle */}
                                {row.website && (
                                  <button
                                    onClick={(event) => {
                                      event.stopPropagation()
                                      window.open(row.website!, '_blank', 'noopener')
                                    }}
                                    title={t('addons.openWebsite', { url: row.website })}
                                    className="shrink-0 rounded p-0.5 text-icon transition-colors hover:bg-white/10 hover:text-icon-hover"
                                  >
                                    <InfoIcon className="h-3.5 w-3.5" />
                                  </button>
                                )}
                              </div>
                            </td>
                            {data.map((version) => {
                              const addon = row.perMinor.get(version.minor)
                              // best source for THIS version — a repo build where it fits, a stored copy where it doesn't
                              const src = !addon && !version.error ? installSourceFor(row, version.minor) : null
                              const installable = Boolean(src)
                              const warn = src ? supportUnclear(src, version.minor) : false
                              let hint: string | undefined
                              if (src) {
                                const libEntry =
                                  src.kind === 'library' ? (row.libraryFiles ?? []).find((f) => f.id === src.id) : undefined
                                const what =
                                  src.kind === 'superhive'
                                    ? t('addons.whatSuperhive')
                                    : src.kind === 'blender_org'
                                      ? t('addons.whatBlenderOrg')
                                      : src.kind === 'backup'
                                        ? src.unsupported
                                          ? t('addons.whatOldBuiltin')
                                          : t('addons.whatCopyFromBlender', { minor: src.sourceMinor ?? '' })
                                        : libEntry?.version
                                          ? t('addons.whatStoredVersion', { version: libEntry.version })
                                          : t('addons.whatStoredCopy')
                                const lines = [t('addons.hereOnApply', { verb: t('addons.installsWhat', { what }) })]
                                if (src.unsupported) lines.push(t('addons.unsupportedMayNotWork'))
                                else if (warn)
                                  lines.push(t('addons.noDeclaredSupport', { minor: version.minor }))
                                hint = lines.join('\n')
                              }
                              // why the dash is a dash
                              const absentHint =
                                !addon && !version.error && !src
                                  ? row.installVia || (row.libraryFiles?.length ?? 0) > 0
                                    ? t('addons.absentNoSource')
                                    : row.sources.has('builtin')
                                      ? t('addons.absentNotShipped', { minor: version.minor })
                                      : t('addons.absentNothingToInstallFrom')
                                  : undefined
                              const isCore = addon?.origin === 'core'
                              return (
                                <td key={version.minor} className="px-3 py-2.5 text-center">
                                  {isExpanded && showSubRows && !isCore ? (
                                    // sub-rows are unfolded: the real control lives on them. A row
                                    // expanded only for its description keeps its cells live.
                                    // Where the collapsed cell was a dot/tick BUTTON, the stand-in
                                    // is a disabled button with the same box — a bare text glyph
                                    // has different line metrics and the row visibly changes height
                                    // on expand (verified empirically; span lookalikes with the same
                                    // padding do not match either — buttons export their baseline
                                    // differently). Dash cells are text in both states, so the plain
                                    // span keeps their parity.
                                    (addon && !isCore) || installable ? (
                                      <button
                                        disabled
                                        title={t('addons.managedBelow')}
                                        className="rounded p-1 disabled:cursor-default"
                                      >
                                        <span className="inline-block h-2.5 w-2.5 overflow-hidden text-center leading-[10px] text-zinc-700">
                                          ·
                                        </span>
                                      </button>
                                    ) : (
                                      <span className="text-zinc-700" title={t('addons.managedBelow')}>
                                        –
                                      </span>
                                    )
                                  ) : installable ? (
                                    <InstallCell
                                      staged={pendingInstall.has(installKey(version.minor, row.groupId))}
                                      disabled={busy || !isDesktop}
                                      onToggle={() => toggleInstall(version.minor, row)}
                                      warn={warn}
                                      hint={hint}
                                    />
                                  ) : (
                                    <StatusCell
                                      addon={addon}
                                      versionError={version.error}
                                      pending={addon ? pending.get(pendingKey(version.minor, addon.module)) : undefined}
                                      disabled={busy || !isDesktop}
                                      replaced={Boolean(addon) && pendingInstall.has(installKey(version.minor, row.groupId))}
                                      onToggle={
                                        addon && pendingInstall.has(installKey(version.minor, row.groupId))
                                          ? () => cancelInstall(installKey(version.minor, row.groupId))
                                          : () => addon && toggleCell(version.minor, addon)
                                      }
                                      absentHint={absentHint}
                                    />
                                  )}
                                </td>
                              )
                            })}
                          </tr>
                          {descExpanded && (
                            <tr className="bg-surface-inset">
                              <td colSpan={data.length + 1} className="p-0">
                                {/* the cell spans the whole (wider-than-viewport) table — the text
                                    block pins itself to the visible left edge while scrolling.
                                    z-[11] + an opaque bg keep it above the edge-scroll shadow (z-10)
                                    that would dim it, while the row-divider overlays (same z-11 but
                                    later in the DOM) and the header (z-20) still paint above it. */}
                                <div className="sticky left-0 z-[11] max-w-2xl bg-surface-inset px-4 py-2 pl-10 text-xs leading-relaxed text-zinc-400">
                                  {row.description}
                                </div>
                              </td>
                            </tr>
                          )}
                          {/* unfolded: one sub-row per install unit — a specific version (installed/stored)
                              or a repo — so it's obvious which version installs into which Blender */}
                          {isExpanded &&
                            showSubRows &&
                            unitRows.map((unit) => {
                              const hasInstalled = unit.cells.length > 0
                              const tag =
                                hasInstalled && unit.libEntry
                                  ? t('addons.tagInstalledInLibrary')
                                  : hasInstalled
                                    ? t('addons.tagInstalled')
                                    : t('addons.tagInLibrary')
                              const canUninstall = unit.removable.length > 0 || Boolean(unit.libEntry)
                              const isNewest = unit.key === newestUnitKey
                              return (
                                <tr key={`${row.groupId}#${unit.key}`} className="bg-surface-inset">
                                  <td className="sticky left-0 z-10 bg-surface-inset py-2 pl-12 pr-4">
                                    <div className="flex items-center gap-2">
                                      <span className="text-xs text-zinc-400">{unit.label}</span>
                                      <span className="text-[10px] text-zinc-600">{tag}</span>
                                      {isDesktop && unit.libEntry && (
                                        <button
                                          onClick={() => addonsApi.libraryReveal(unit.libEntry!.id).catch(() => undefined)}
                                          title={t('addons.revealStored')}
                                          className="shrink-0 rounded border border-white/10 p-1 text-zinc-500 transition-colors hover:bg-white/10 hover:text-zinc-200"
                                        >
                                          <FolderOpenIcon className="h-3 w-3" />
                                        </button>
                                      )}
                                      {isDesktop && canUninstall && (
                                        <button
                                          onClick={() =>
                                            uninstallVersion(
                                              row.name,
                                              unit.version ?? '?',
                                              unit.removable.map(([minor, addon]) => ({ minor, module: addon.module })),
                                              unit.libEntry?.id ?? null
                                            )
                                          }
                                          disabled={busy || refreshing}
                                          title={
                                            unit.removable.length > 0 && unit.libEntry
                                              ? t('addons.deleteFromBlenderAndLibrary', {
                                                  minors: unit.removable.map(([m]) => m).join(', ')
                                                })
                                              : unit.removable.length > 0
                                                ? t('addons.deleteFromBlender', {
                                                    minors: unit.removable.map(([m]) => m).join(', ')
                                                  })
                                                : t('addons.removeStoredCopy')
                                          }
                                          className="shrink-0 rounded border border-red-500/30 p-1 text-red-300 transition-colors hover:bg-red-500/10 disabled:opacity-50"
                                        >
                                          <TrashIcon className="h-3 w-3" />
                                        </button>
                                      )}
                                    </div>
                                  </td>
                                  {data.map((version) => {
                                    // installed AS THIS version here → toggle it. But if another version
                                    // was ticked to install in this same column, this copy will be
                                    // uninstalled first — show it "released" (hollow) instead of enabled.
                                    const here = unit.cells.find(([minor]) => minor === version.minor)
                                    if (here) {
                                      const cellAddon = here[1]
                                      const colKey = installKey(version.minor, row.groupId)
                                      const replacedHere = pendingInstall.has(colKey)
                                      return (
                                        <td key={version.minor} className="px-3 py-2 text-center">
                                          <StatusCell
                                            addon={cellAddon}
                                            versionError={version.error}
                                            pending={pending.get(pendingKey(version.minor, cellAddon.module))}
                                            disabled={busy || !isDesktop}
                                            replaced={replacedHere}
                                            onToggle={
                                              replacedHere
                                                ? () => cancelInstall(colKey)
                                                : () => toggleCell(version.minor, cellAddon)
                                            }
                                          />
                                        </td>
                                      )
                                    }
                                    if (version.error || !okMinors.has(version.minor)) {
                                      return (
                                        <td key={version.minor} className="px-3 py-2 text-center">
                                          <span className="text-zinc-800">–</span>
                                        </td>
                                      )
                                    }
                                    // occupied by a DIFFERENT version → offer to switch (reinstall) to
                                    // THIS one, provided the sitting copy is ours to remove and this
                                    // version fits. On Apply the old copy is uninstalled first.
                                    const occupant = row.perMinor.get(version.minor)
                                    const occupantRemovable =
                                      occupant && !occupant.missing && (occupant.origin === 'user' || occupant.origin === 'extension')
                                    const src = unitSourceFor(row, unit, version.minor, isNewest)
                                    if (!src || (occupant && !occupantRemovable)) {
                                      // can't offer it: this version doesn't fit here, or the sitting copy
                                      // is built-in / core and we won't swap it out
                                      return (
                                        <td key={version.minor} className="px-3 py-2 text-center">
                                          <span
                                            className="text-zinc-800"
                                            title={
                                              occupant
                                                ? t('addons.cantSwapBuiltin', { minor: version.minor, label: unit.label })
                                                : t('addons.cantInstallInto', { minor: version.minor, label: unit.label })
                                            }
                                          >
                                            –
                                          </span>
                                        </td>
                                      )
                                    }
                                    const warn = supportUnclear(src, version.minor)
                                    const key = installKey(version.minor, row.groupId)
                                    const what =
                                      src.kind === 'superhive'
                                        ? t('addons.whatSuperhive')
                                        : src.kind === 'blender_org'
                                          ? t('addons.whatBlenderOrg')
                                          : src.kind === 'backup'
                                            ? t('addons.whatCopyFromBlender', { minor: src.sourceMinor ?? '' })
                                            : t('addons.whatStoredLabel', { label: unit.label })
                                    const verb = occupant
                                      ? t('addons.replacesInstalledWith', { version: occupant.version ?? '?', what })
                                      : t('addons.installsWhat', { what })
                                    return (
                                      <td key={version.minor} className="px-3 py-2 text-center">
                                        <InstallCell
                                          staged={sameSource(pendingInstall.get(key), src)}
                                          disabled={busy || !isDesktop}
                                          onToggle={() => pickInstall(version.minor, key, src)}
                                          warn={warn}
                                          hint={
                                            warn
                                              ? t('addons.hereOnApplyNoSupport', { verb, minor: version.minor })
                                              : t('addons.hereOnApply', { verb })
                                          }
                                        />
                                      </td>
                                    )
                                  })}
                                </tr>
                              )
                            })}
                          </Fragment>
                        )
                      })
                    )}
                  </tbody>
                </table>
                {rowDividerTops.map((top, index) => (
                  <div
                    key={index}
                    aria-hidden
                    className="pointer-events-none absolute left-0 right-0 z-[11] h-px bg-white/5"
                    style={{ top }}
                  />
                ))}
                </div>
                </div>
                {/* the vertical mirror of the card's hidden native bar: −right-6 (24px =
                    PageLayout's pr-3.5 + its reserved scrollbar gutter) lands it in the
                    same gutter column where a page-scrolling list (Installs) shows its
                    own bar; top/bottom-px align its client box with the card's (inside
                    the 1px border) so the 1:1 scrollTop sync spans both ranges exactly */}
                <MirrorVScrollbar
                  targetRef={tableScrollRef}
                  className="absolute -right-6 top-px bottom-px w-2.5"
                />
              </div>
              {/* the horizontal mirror, attached right under the card; -mb-4 folds its
                  16px into PageLayout's pb-6 so it doesn't push the page into scrolling
                  (see the maxTableHeight comment) */}
              <StickyHScrollbar targetRef={tableScrollRef} variant="attached" className="-mb-4" />
            </>
          )}
        </section>
      </div>
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
    </PageLayout>
  )
}

