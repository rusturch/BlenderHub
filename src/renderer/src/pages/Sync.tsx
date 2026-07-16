import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import PageLayout from '../components/PageLayout'
import Dropdown from '../components/Dropdown'
import StickyHScrollbar from '../components/StickyHScrollbar'
import HScrollEdgeShadows from '../components/HScrollEdgeShadows'
import { useDialog } from '../components/Dialog'
import RunningBlenderGate from '../components/RunningBlenderGate'
import { cleanErrorMessage, formatBytes, formatDateNumeric } from '../lib/format'
import { getLauncherApi } from '../lib/preview-fallback'
import { useTranslation } from '../lib/i18n'
import { uiGet, uiSet } from '../lib/ui-store'
import { compareVersionsDesc } from '../../../shared/blender-builds'
import { HIDDEN_SYNC_COMPONENT_IDS } from '../../../shared/types'
import type { RunningBlender, SettingsBackupInfo, SyncApplyProgress, SyncCellStatus, SyncComponentId, SyncScanResult, SyncVersionColumn } from '../../../shared/types'
import { locateWithDedup } from './installs/installs-utils'
import { PENDING_SEP, cellKey, labelOf, hasAnySettings } from './sync/sync-utils'
import { CYCLE_STYLES, COMPONENT_ROWS, PHASE_LABEL_KEYS } from './sync/constants'
import { FolderOpenIcon, TrashIcon, GearIcon, RefreshIcon } from './sync/icons'
import { SyncCell } from './sync/cells'
import type { CellFace } from './sync/types'

export default function SyncPage({ onShowInstalls }: { onShowInstalls?: (version: string) => void }) {
  const { api, isDesktop } = getLauncherApi()
  const syncApi = api.settingsSync
  const { confirm: confirmDialog, alert: alertDialog } = useDialog()
  const { t } = useTranslation()
  const tableScrollRef = useRef<HTMLDivElement>(null)
  const stickyColRef = useRef<HTMLTableCellElement>(null)

  const [data, setData] = useState<SyncScanResult | null>(null)
  const [backups, setBackups] = useState<SettingsBackupInfo[]>([])
  const [scanning, setScanning] = useState(false)
  const [applying, setApplying] = useState(false)
  const [restoring, setRestoring] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [applyProgress, setApplyProgress] = useState<SyncApplyProgress | null>(null)
  const [source, setSource] = useState<string | null>(null)
  // A source switch persists immediately (the auto-rescan reads main's persisted
  // source to compute the new source's real statuses). This snapshots the state from
  // BEFORE the switch so Discard can put it back — captured once per editing burst,
  // cleared on Apply. null = the current source is the committed baseline.
  const [sourceUndo, setSourceUndo] = useState<{ source: string | null; links: Set<string> } | null>(null)
  // persistent links as main knows them (sync-state.json); they survive Apply/restart
  const [serverLinks, setServerLinks] = useState<Set<string>>(new Set())
  // link clicks NOT yet committed — true = link on Apply, false = unlink on Apply.
  // Nothing (not even bookkeeping) changes until Apply; Discard drops these.
  const [pendingLinks, setPendingLinks] = useState<Map<string, boolean>>(new Map())
  // drift conditions per linked cell, from the last scan
  const [statuses, setStatuses] = useState<Map<string, SyncCellStatus>>(new Map())
  // drifted cells the user chose to overwrite on the next Apply (session-only)
  const [forcePush, setForcePush] = useState<Set<string>>(new Set())
  // drift-panel items whose change list is unfolded (collapsed by default)
  const [expandedChanges, setExpandedChanges] = useState<Set<string>>(new Set())
  const [settingsOpen, setSettingsOpen] = useState(false)
  // opt-in: source edits propagate to linked versions right after the scan that
  // noticed them, no Apply click (see maybeAutoApply)
  const [autoApplySource, setAutoApplySource] = useState(() => uiGet('sync.autoApplySource') === '1')
  const autoApplySourceRef = useRef(autoApplySource)
  autoApplySourceRef.current = autoApplySource
  const autoApplyBusyRef = useRef(false)
  // open gate dialog: the operation stalled because these Blender versions are running
  const [runningGate, setRunningGate] = useState<{
    minors: string[]
    initial: RunningBlender[]
    resume: () => void
  } | null>(null)
  // the minor whose version-header dropdown is open
  const [versionMenu, setVersionMenu] = useState<string | null>(null)
  // "clipboard" of the version-header menu: the linked-component set copied from one
  // version, pasted into another as staged link clicks (applied with the usual Apply)
  const [copiedSet, setCopiedSet] = useState<{ minor: string; components: SyncComponentId[] } | null>(null)
  const [showPrefDate, setShowPrefDate] = useState(() => uiGet('sync.showPrefDate') !== '0')
  const [showCycleBadge, setShowCycleBadge] = useState(() => uiGet('sync.showCycleBadge') !== '0')
  useEffect(() => {
    uiSet('sync.showPrefDate', showPrefDate ? '1' : '0')
  }, [showPrefDate])
  useEffect(() => {
    uiSet('sync.showCycleBadge', showCycleBadge ? '1' : '0')
  }, [showCycleBadge])
  useEffect(() => {
    uiSet('sync.autoApplySource', autoApplySource ? '1' : '0')
  }, [autoApplySource])

  // what the matrix shows and Apply commits: persisted links + pending clicks
  const linked = useMemo(() => {
    const next = new Set(serverLinks)
    for (const [key, add] of pendingLinks) {
      if (add) next.add(key)
      else next.delete(key)
    }
    return next
  }, [serverLinks, pendingLinks])

  const busy = scanning || applying || restoring
  const columns = useMemo(() => data?.columns ?? [], [data])
  const sourceCol = useMemo(() => columns.find((column) => column.minor === source) ?? null, [columns, source])

  /** fold a scan result into all local state (links + statuses come from main) */
  const absorb = useCallback((result: SyncScanResult) => {
    setData(result)
    const cells = new Set<string>()
    for (const [minor, components] of Object.entries(result.links.cells)) {
      // parked components may linger in old persisted links — never surface them
      for (const id of components) {
        if (!HIDDEN_SYNC_COMPONENT_IDS.includes(id)) cells.add(cellKey(minor, id))
      }
    }
    setServerLinks(cells)
    // pending clicks the persisted state now already satisfies are done
    setPendingLinks((prev) => {
      const next = new Map([...prev].filter(([key, add]) => cells.has(key) !== add))
      return next.size === prev.size ? prev : next
    })
    if (result.links.sourceMinor) setSource(result.links.sourceMinor)
    const map = new Map<string, SyncCellStatus>()
    for (const status of result.statuses) map.set(cellKey(status.minor, status.component), status)
    setStatuses(map)
    // staged overwrites stay while an explicit push still makes sense for the cell
    // (drifted or conflicted) — resolved/auto-copied states drop theirs
    setForcePush((prev) => {
      const next = new Set(
        [...prev].filter((key) => {
          const condition = map.get(key)?.condition
          return condition === 'targetChanged' || condition === 'conflict'
        })
      )
      return next.size === prev.size ? prev : next
    })
  }, [])

  const persistLinks = useCallback(
    (nextSource: string | null, cells: Set<string>) => {
      const map: Record<string, SyncComponentId[]> = {}
      for (const key of cells) {
        const [minor, id] = key.split(PENDING_SEP) as [string, SyncComponentId]
        ;(map[minor] ??= []).push(id)
      }
      return syncApi.setLinks({ sourceMinor: nextSource, cells: map })
    },
    [syncApi]
  )

  // main's op-lock rejects a scan colliding with another headless operation (a previous
  // still-running scan, an add-ons apply) — for AUTOMATIC scans that's routine, not an
  // error worth a banner (same pattern as the Add-ons page)
  const opLockBusy = (message: string): boolean => /is already running/.test(message)

  // The opt-in shortcut around Apply: components the SOURCE changed are copied to their
  // linked versions right after the scan that noticed it. Strictly `sourceChanged` cells
  // of PERSISTED links — staged clicks, never-synced links, drift and conflicts keep the
  // manual flow, and the link bookkeeping is not touched. Targets with a running Blender
  // are skipped silently (a headless write would be clobbered; they stay amber for a
  // manual, gated Apply). Backups happen exactly like a manual Apply.
  const maybeAutoApply = useCallback(
    async (result: SyncScanResult) => {
      if (!autoApplySourceRef.current || !isDesktop || autoApplyBusyRef.current) return
      const src = result.links.sourceMinor
      if (!src) return
      const byMinor = new Map<string, SyncComponentId[]>()
      for (const status of result.statuses) {
        if (status.condition !== 'sourceChanged') continue
        if (HIDDEN_SYNC_COMPONENT_IDS.includes(status.component)) continue
        if (status.minor === src) continue
        if (!(result.links.cells[status.minor] ?? []).includes(status.component)) continue
        const column = result.columns.find((candidate) => candidate.minor === status.minor)
        if (!column?.installed) continue
        const list = byMinor.get(status.minor)
        if (list) list.push(status.component)
        else byMinor.set(status.minor, [status.component])
      }
      if (byMinor.size === 0) return
      autoApplyBusyRef.current = true
      try {
        let running: RunningBlender[] = []
        try {
          running = await api.builds.listRunning([...byMinor.keys()])
        } catch {
          // detection failed — same fallback as the manual gate: assume nothing runs
        }
        for (const entry of running) byMinor.delete(entry.minor)
        if (byMinor.size === 0) return
        const order = new Map(COMPONENT_ROWS.map((row, index) => [row.id, index]))
        const targets = [...byMinor.entries()]
          .sort((a, b) => compareVersionsDesc(a[0], b[0]))
          .map(([minor, components]) => ({
            minor,
            components: components.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0))
          }))
        setApplying(true)
        setError(null)
        try {
          const outcome = await syncApi.apply({ sourceMinor: src, targets })
          absorb(outcome.data)
          setBackups(await syncApi.listBackups())
          const failures = outcome.results.filter((entry) => entry.status === 'error')
          if (failures.length > 0) {
            // a banner, not a modal — nobody clicked anything
            setError(
              failures
                .map((failure) =>
                  t('sync.failureLine', {
                    minor: failure.minor,
                    component: labelOf(failure.component, t),
                    detail: failure.detail ?? failure.status
                  })
                )
                .join('; ')
            )
          }
        } catch (err) {
          const message = cleanErrorMessage(err)
          // busy = another op holds the lock right now; the next scan simply retries
          if (!opLockBusy(message)) setError(message)
        } finally {
          setApplying(false)
          setApplyProgress(null)
        }
      } finally {
        autoApplyBusyRef.current = false
      }
    },
    [api.builds, syncApi, isDesktop, absorb, t]
  )

  const runScan = useCallback(
    async (auto = false) => {
      setScanning(true)
      setError(null)
      try {
        const fresh = await syncApi.scan()
        absorb(fresh)
        void maybeAutoApply(fresh)
      } catch (err) {
        const message = cleanErrorMessage(err)
        if (!auto || !opLockBusy(message)) setError(message)
      } finally {
        setScanning(false)
      }
    },
    [syncApi, absorb, maybeAutoApply]
  )

  useEffect(() => {
    syncApi
      .getCached()
      .then((cached) => cached && absorb(cached))
      .catch(() => {})
    syncApi.listBackups().then(setBackups).catch(() => {})
    // pure fs stats — cheap enough to always refresh on opening the tab
    if (isDesktop) void runScan(true)
    return syncApi.onApplyProgress(setApplyProgress)
  }, [syncApi, isDesktop, runScan, absorb])

  // default source = the installed version whose preferences were saved most recently
  // (only until a source is chosen — a chosen one is persisted and comes back via links)
  useEffect(() => {
    if (!data) return
    setSource((prev) => {
      if (prev && data.columns.some((column) => column.minor === prev)) return prev
      let best: SyncVersionColumn | null = null
      for (const column of data.columns) {
        if (!column.installed || !hasAnySettings(column)) continue
        if (!best || (column.userprefMtimeMs ?? -1) > (best.userprefMtimeMs ?? -1)) best = column
      }
      return best?.minor ?? data.columns.find((column) => hasAnySettings(column))?.minor ?? null
    })
  }, [data])

  const visibleRows = useMemo(
    () => COMPONENT_ROWS.filter((row) => columns.some((column) => column.components[row.id]?.present)),
    [columns]
  )

  // every installed non-source version is a potential target — linking decides per cell
  const eligibleMinors = useMemo(
    () => columns.filter((column) => column.installed && column.minor !== source).map((column) => column.minor),
    [columns, source]
  )

  const rowEligible = useCallback(
    (id: SyncComponentId): string[] => ((sourceCol?.components[id]?.present ?? false) ? eligibleMinors : []),
    [sourceCol, eligibleMinors]
  )

  // linked cells that Apply would actually copy: never-synced, source-updated, or staged
  // overwrites. In-sync cells rest; drifted/conflicted ones wait for a decision.
  const actionableKeys = useMemo(
    () =>
      [...linked].filter((key) => {
        const [minor, id] = key.split(PENDING_SEP) as [string, SyncComponentId]
        const column = columns.find((candidate) => candidate.minor === minor)
        if (!column?.installed || minor === source) return false
        if (!(sourceCol?.components[id]?.present ?? false)) return false
        if (forcePush.has(key)) return true
        const condition = statuses.get(key)?.condition
        return condition === undefined || condition === 'new' || condition === 'sourceChanged'
      }),
    [linked, columns, source, sourceCol, forcePush, statuses]
  )
  const pendingUnlinkCount = useMemo(
    () => [...pendingLinks.values()].filter((add) => !add).length,
    [pendingLinks]
  )
  // Apply commits everything at once: the copies AND the link bookkeeping
  const pendingCount = actionableKeys.length + pendingUnlinkCount

  // what Discard takes back: uncommitted link clicks, staged overwrites, and a source
  // switch made since the last Apply. The clicks/overwrites are purely local; the source
  // switch was persisted, so undoing it re-writes main's state (and rescans).
  const discardableCount = pendingLinks.size + forcePush.size + (sourceUndo ? 1 : 0)

  const discardChanges = useCallback(() => {
    setPendingLinks(new Map())
    setForcePush(new Set())
    if (sourceUndo) {
      setSource(sourceUndo.source)
      setServerLinks(new Set(sourceUndo.links))
      setStatuses(new Map()) // stale — the rescan below brings the restored source's history
      setSourceUndo(null)
      void persistLinks(sourceUndo.source, sourceUndo.links)
        .catch(() => {}) // rescan re-syncs the UI from main's state anyway
        .finally(() => void runScan(true))
    }
  }, [sourceUndo, persistLinks, runScan])

  // drifted cells that need the user's decision
  const driftItems = useMemo(() => {
    const order = new Map(COMPONENT_ROWS.map((row, index) => [row.id, index]))
    return [...statuses.values()]
      .filter(
        (status) =>
          linked.has(cellKey(status.minor, status.component)) &&
          (status.condition === 'targetChanged' || status.condition === 'conflict')
      )
      .sort(
        (a, b) =>
          compareVersionsDesc(a.minor, b.minor) ||
          (order.get(a.component) ?? 0) - (order.get(b.component) ?? 0)
      )
  }, [statuses, linked])

  const faceOf = useCallback(
    (key: string): CellFace | null => {
      if (pendingLinks.get(key) === false) return 'unlink'
      if (!linked.has(key)) return null
      if (forcePush.has(key)) return 'push'
      return statuses.get(key)?.condition ?? 'new'
    },
    [pendingLinks, linked, forcePush, statuses]
  )

  const toggleCell = useCallback(
    (id: SyncComponentId, minor: string) => {
      const key = cellKey(minor, id)
      const desired = !linked.has(key)
      setPendingLinks((prev) => {
        const next = new Map(prev)
        if (serverLinks.has(key) === desired) next.delete(key) // back to the persisted state
        else next.set(key, desired)
        return next
      })
      if (!desired) {
        setForcePush((prev) => (prev.has(key) ? new Set([...prev].filter((k) => k !== key)) : prev))
      }
    },
    [linked, serverLinks]
  )

  // the row checkbox = "keep this component linked in ALL versions"
  const toggleRowAll = useCallback(
    (id: SyncComponentId) => {
      const minors = rowEligible(id)
      if (minors.length === 0) return
      const all = minors.every((minor) => linked.has(cellKey(minor, id)))
      setPendingLinks((prev) => {
        const next = new Map(prev)
        for (const minor of minors) {
          const key = cellKey(minor, id)
          const desired = !all
          if (serverLinks.has(key) === desired) next.delete(key)
          else next.set(key, desired)
        }
        return next
      })
    },
    [rowEligible, linked, serverLinks]
  )

  // snapshot which components are effectively linked for a version (staged clicks included)
  const copyLinkedSet = useCallback(
    (minor: string) => {
      const components = COMPONENT_ROWS.filter((row) => linked.has(cellKey(minor, row.id))).map((row) => row.id)
      setCopiedSet({ minor, components })
    },
    [linked]
  )

  // stage the copied set onto a version: link every component the source can provide.
  // Purely additive — nothing outside the copied set is unlinked. Applied with Apply.
  const pasteLinkedSet = useCallback(
    (minor: string) => {
      if (!copiedSet || minor === source) return
      setPendingLinks((prev) => {
        const next = new Map(prev)
        for (const id of copiedSet.components) {
          if (!(sourceCol?.components[id]?.present ?? false)) continue
          const key = cellKey(minor, id)
          if (serverLinks.has(key)) next.delete(key)
          else next.set(key, true)
        }
        return next
      })
    },
    [copiedSet, source, sourceCol, serverLinks]
  )

  const launchVersion = useCallback(
    (installId: string) => {
      api.builds.launch(installId).catch((err) => setError(cleanErrorMessage(err)))
    },
    [api.builds]
  )

  // A running Blender re-saves its preferences over whatever we copy into its config
  // (and Apply's headless fixup races it) — operations that write a version's settings
  // go through this gate: run now when the affected minors are closed, otherwise park
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

  // the fallback for versions the catalog does not carry: point at an existing install
  const locateVersion = useCallback(async () => {
    try {
      const before = await api.builds.listInstalled()
      // same duplicate guard as the Installs page's Locate button
      const outcome = await locateWithDedup(api.builds, before)
      if (!outcome) return // folder dialog cancelled
      await runScan()
      if (outcome.skippedDuplicates.length > 0) {
        const names = outcome.skippedDuplicates
          .map((build) => t('installs.buildName', { version: build.version, cycle: build.releaseCycle }))
          .join(', ')
        await alertDialog(
          outcome.added.length > 0
            ? t('installs.locateAddedSomeSkipped', { count: outcome.added.length, names })
            : t('installs.locateAllSkipped', { names })
        )
      }
    } catch (err) {
      await alertDialog(cleanErrorMessage(err))
    }
  }, [api.builds, runScan, alertDialog, t])

  // Switching the source keeps the user's intent: a row linked for ALL versions stays
  // "all versions" relative to the new source (the old source becomes a target, the new
  // one stops being one); hand-picked partial rows only lose the new source's own cell;
  // rows the new source lacks keep their links untouched (cells go inert, nothing lost).
  // Main keeps each source's sync history, so the auto-rescan below restores the real
  // statuses instead of a wall of amber.
  const changeSource = useCallback(
    async (next: string) => {
      if (next === source) return
      // remember the committed state so Discard can undo the switch — only on the first
      // switch of a burst, so Discard reverts all the way back, not just one step
      setSourceUndo((prev) => prev ?? { source, links: new Set(serverLinks) })
      const nextCol = columns.find((column) => column.minor === next)
      const rebuilt = new Set<string>()
      for (const row of COMPONENT_ROWS) {
        const rowKeys = [...linked].filter((key) => key.split(PENDING_SEP)[1] === row.id)
        if (!(nextCol?.components[row.id]?.present ?? false)) {
          for (const key of rowKeys) rebuilt.add(key)
          continue
        }
        const oldEligible = rowEligible(row.id)
        const staged = oldEligible.filter((minor) => linked.has(cellKey(minor, row.id)))
        const wasAll = oldEligible.length > 0 && staged.length === oldEligible.length
        if (wasAll) {
          for (const column of columns) {
            if (column.installed && column.minor !== next) rebuilt.add(cellKey(column.minor, row.id))
          }
        } else {
          for (const key of rowKeys) {
            if (key.split(PENDING_SEP)[0] !== next) rebuilt.add(key)
          }
        }
      }
      setSource(next)
      // a source switch commits the re-aimed links right away (its auto-rescan
      // depends on the persisted state)
      setServerLinks(rebuilt)
      setPendingLinks(new Map())
      setStatuses(new Map()) // stale — the rescan below brings the new source's history
      setForcePush(new Set()) // staged overwrites were decisions relative to the old source
      try {
        await persistLinks(next, rebuilt)
      } catch {
        // persistence failed — the rescan below re-syncs the UI from main's state anyway
      }
      void runScan(true)
    },
    [columns, source, serverLinks, linked, rowEligible, persistLinks, runScan]
  )

  const applyChanges = useCallback(async () => {
    if (!source || pendingCount === 0) return
    const byMinor = new Map<string, SyncComponentId[]>()
    for (const key of actionableKeys) {
      const [minor, id] = key.split(PENDING_SEP) as [string, SyncComponentId]
      const list = byMinor.get(minor)
      if (list) list.push(id)
      else byMinor.set(minor, [id])
    }
    const order = new Map(COMPONENT_ROWS.map((row, index) => [row.id, index]))
    const targetsPayload = [...byMinor.entries()]
      .sort((a, b) => compareVersionsDesc(a[0], b[0]))
      .map(([minor, components]) => ({
        minor,
        components: components.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0))
      }))
    const backward = targetsPayload.map(({ minor }) => minor).filter((minor) => compareVersionsDesc(minor, source) > 0)
    const touchesPrefs = targetsPayload.some(({ components }) => components.includes('preferences'))
    const ok = await confirmDialog({
      title: targetsPayload.length > 0 ? t('sync.copySettingsTitle') : t('sync.applyLinkChangesTitle'),
      message: (
        <span className="block space-y-2">
          {targetsPayload.length > 0 && (
            <span className="block">
              {t('sync.fromBlender', { source })}
              {targetsPayload.map(({ minor, components }) => (
                <span key={minor} className="mt-1 block">
                  • <span className="text-zinc-100">{minor}</span> —{' '}
                  {components.map((component) => labelOf(component, t)).join(', ')}
                </span>
              ))}
            </span>
          )}
          {targetsPayload.length > 0 && <span className="block">{t('sync.applyBackupNotice')}</span>}
          {pendingUnlinkCount > 0 && (
            <span className="block text-xs leading-relaxed text-zinc-500">
              {t(pendingUnlinkCount > 1 ? 'sync.alsoUnlinksMany' : 'sync.alsoUnlinksOne', {
                count: pendingUnlinkCount
              })}
            </span>
          )}
          {backward.length > 0 && (
            <span className="block rounded-lg border border-amber-500/20 bg-amber-500/5 p-2 text-xs leading-relaxed text-amber-400">
              {t('sync.olderThanSourceWarning', { versions: backward.join(', ') })}
            </span>
          )}
          {touchesPrefs && (
            <span className="block text-xs leading-relaxed text-zinc-500">
              {t('sync.addonsNotAffected')}
            </span>
          )}
        </span>
      ),
      confirmLabel: t('common.apply')
    })
    if (!ok) return
    const run = async (): Promise<void> => {
      setApplying(true)
      setError(null)
      try {
        // commit the link bookkeeping first — the engine's baselines key off the
        // persisted links, and "nothing changes until Apply" includes the links
        await persistLinks(source, linked)
        setServerLinks(new Set(linked))
        setPendingLinks(new Map())
        setSourceUndo(null) // this source is now the committed baseline
        if (targetsPayload.length > 0) {
          const outcome = await syncApi.apply({ sourceMinor: source, targets: targetsPayload })
          absorb(outcome.data)
          setBackups(await syncApi.listBackups())
          const failures = outcome.results.filter((result) => result.status !== 'ok')
          if (failures.length > 0) {
            await alertDialog({
              title: t('sync.someItemsFailed'),
              message: (
                <span className="block whitespace-pre-line">
                  {failures
                    .map((result) =>
                      t('sync.failureLine', {
                        minor: result.minor,
                        component: labelOf(result.component, t),
                        detail: result.detail ?? result.status
                      })
                    )
                    .join('\n')}
                </span>
              )
            })
          }
        } else {
          await runScan() // unlink-only apply: refresh links/statuses from main
        }
      } catch (err) {
        setError(cleanErrorMessage(err))
      } finally {
        setApplying(false)
        setApplyProgress(null)
      }
    }
    // an unlink-only apply touches no Blender configs — no need to gate it
    if (targetsPayload.length > 0) await gateOnRunning(targetsPayload.map(({ minor }) => minor), run)
    else await run()
  }, [
    source,
    actionableKeys,
    pendingCount,
    pendingUnlinkCount,
    linked,
    persistLinks,
    runScan,
    gateOnRunning,
    syncApi,
    confirmDialog,
    alertDialog,
    absorb,
    t
  ])

  /** drift resolution: copy the drifted version's component INTO the source */
  const pullIntoSource = useCallback(
    async (item: SyncCellStatus) => {
      if (!source) return
      const ok = await confirmDialog({
        title: t('sync.copyIntoSourceTitle'),
        message: t('sync.copyIntoSourceMessage', {
          component: labelOf(item.component, t),
          minor: item.minor,
          source
        }),
        variant: 'warning',
        confirmLabel: t('sync.copyIntoSourceConfirm')
      })
      if (!ok) return
      const run = async (): Promise<void> => {
        setRestoring(true)
        setError(null)
        try {
          const outcome = await syncApi.apply({
            sourceMinor: item.minor,
            targets: [{ minor: source, components: [item.component] }]
          })
          const failures = outcome.results.filter((result) => result.status === 'error')
          // the pulled pair is now a true sync point — record it, then refresh everything
          absorb(await syncApi.recordSyncPoint(item.minor, item.component))
          setBackups(await syncApi.listBackups())
          if (failures.length > 0) {
            await alertDialog(
              t('sync.someItemsFailedList', {
                items: failures
                  .map((result) =>
                    t('sync.failureLineShort', {
                      component: labelOf(result.component, t),
                      detail: result.detail ?? result.status
                    })
                  )
                  .join('\n')
              })
            )
          }
        } catch (err) {
          setError(cleanErrorMessage(err))
        } finally {
          setRestoring(false)
          setApplyProgress(null)
        }
      }
      // this writes INTO the source version — gate on it being closed
      await gateOnRunning([source], run)
    },
    [source, syncApi, gateOnRunning, confirmDialog, alertDialog, absorb, t]
  )

  const restoreOne = useCallback(
    async (backup: SettingsBackupInfo) => {
      const ok = await confirmDialog({
        title: t('sync.restoreDialogTitle', { minor: backup.minor }),
        message: t('sync.restoreDialogMessage', {
          components: backup.components.map((component) => labelOf(component, t)).join(', '),
          minor: backup.minor,
          date: new Date(backup.createdAt).toLocaleString()
        }),
        variant: 'danger',
        tone: 'danger',
        confirmLabel: t('common.restore')
      })
      if (!ok) return
      const run = async (): Promise<void> => {
        setRestoring(true)
        setError(null)
        try {
          const outcome = await syncApi.restoreBackup(backup.id)
          absorb(outcome.data)
          setBackups(await syncApi.listBackups())
          const failures = outcome.results.filter((result) => result.status === 'error')
          if (failures.length > 0) {
            await alertDialog(
              t('sync.someItemsNotRestored', {
                items: failures
                  .map((result) =>
                    t('sync.failureLineShort', {
                      component: labelOf(result.component, t),
                      detail: result.detail ?? result.status
                    })
                  )
                  .join('\n')
              })
            )
          }
        } catch (err) {
          setError(cleanErrorMessage(err))
        } finally {
          setRestoring(false)
          setApplyProgress(null)
        }
      }
      // restored files would be overwritten when that Blender exits — gate on it
      await gateOnRunning([backup.minor], run)
    },
    [syncApi, gateOnRunning, confirmDialog, alertDialog, absorb, t]
  )

  const deleteOne = useCallback(
    async (backup: SettingsBackupInfo) => {
      const ok = await confirmDialog({
        title: t('sync.deleteBackupTitle'),
        message: t('sync.deleteBackupMessage', {
          minor: backup.minor,
          date: new Date(backup.createdAt).toLocaleString()
        }),
        variant: 'danger',
        tone: 'danger',
        confirmLabel: t('common.delete')
      })
      if (!ok) return
      setRestoring(true)
      try {
        setBackups(await syncApi.deleteBackup(backup.id))
      } catch (err) {
        await alertDialog(cleanErrorMessage(err))
      } finally {
        setRestoring(false)
      }
    },
    [syncApi, confirmDialog, alertDialog, t]
  )

  const deleteAllBackups = useCallback(async () => {
    if (backups.length === 0) return
    const ok = await confirmDialog({
      title: t('sync.deleteAllBackupsTitle'),
      message: t('sync.deleteAllBackupsMessage', { count: backups.length }),
      variant: 'danger',
      tone: 'danger',
      confirmLabel: t('common.delete')
    })
    if (!ok) return
    setRestoring(true)
    try {
      let fresh = backups
      for (const backup of backups) {
        fresh = await syncApi.deleteBackup(backup.id)
      }
      setBackups(fresh)
    } catch (err) {
      await alertDialog(cleanErrorMessage(err))
      setBackups(await syncApi.listBackups())
    } finally {
      setRestoring(false)
    }
  }, [backups, syncApi, confirmDialog, alertDialog, t])

  const headerActions = (
    <div className="flex items-center gap-2">
      {discardableCount > 0 && (
        <button
          onClick={discardChanges}
          disabled={busy}
          title={t('sync.discardHint')}
          className="rounded-lg border border-white/10 px-3 py-1.5 text-sm font-medium text-zinc-300 transition-colors hover:bg-white/5 disabled:opacity-50"
        >
          {t('common.discard')}
        </button>
      )}
      {pendingCount > 0 && (
        <button
          onClick={applyChanges}
          disabled={busy || !isDesktop}
          className="rounded-lg bg-blender px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-blender/90 disabled:opacity-50"
        >
          {applying ? t('sync.applying') : t('sync.applyCount', { count: pendingCount })}
        </button>
      )}
      <button
        onClick={() => void runScan()}
        disabled={busy || !isDesktop}
        title={isDesktop ? t('sync.rescanHint') : t('sync.desktopOnlyHint')}
        className="rounded-lg border border-white/10 p-2 text-zinc-400 transition-colors hover:bg-white/5 hover:text-zinc-200 disabled:opacity-50"
      >
        <RefreshIcon className={`h-4 w-4 ${scanning ? 'animate-spin' : ''}`} />
      </button>
    </div>
  )

  return (
    <PageLayout title={t('sync.pageTitle')} actions={headerActions}>
      <div className="flex flex-col gap-4">
        {!isDesktop && (
          <div className="rounded-xl border border-sky-500/20 bg-sky-500/5 px-4 py-3 text-xs leading-relaxed text-sky-300">
            {t('sync.browserPreviewNotice')}
          </div>
        )}
        {error && (
          <div className="rounded-xl border border-red-500/20 bg-red-500/5 px-4 py-3 text-sm text-red-400">
            {error}
          </div>
        )}

        <section>
          {driftItems.length > 0 && (
            <div className="mb-4 flex flex-col gap-2 rounded-xl border border-amber-500/20 bg-amber-500/5 px-4 py-3">
              <p className="text-xs font-semibold uppercase tracking-wide text-amber-400">
                {t('sync.changesSinceLastSync')}
              </p>
              {driftItems.map((item) => {
                const key = cellKey(item.minor, item.component)
                const staged = forcePush.has(key)
                return (
                  <div key={key} className="flex flex-wrap items-center gap-2">
                    <div className="min-w-0 flex-1">
                      <p className="text-sm text-zinc-200">
                        Blender {item.minor} · {labelOf(item.component, t)}
                        <span className="text-zinc-400">{t('sync.modifiedInThatVersion')}</span>
                        {item.condition === 'conflict' && (
                          <span className="ml-1.5 rounded bg-red-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-red-400">
                            {t('sync.conflictSourceChangedToo')}
                          </span>
                        )}
                      </p>
                      {item.changes && item.changes.length > 0 ? (
                        <>
                          <button
                            onClick={() =>
                              setExpandedChanges((prev) => {
                                const next = new Set(prev)
                                if (next.has(key)) next.delete(key)
                                else next.add(key)
                                return next
                              })
                            }
                            className="mt-0.5 flex items-center gap-1 text-xs text-zinc-500 transition-colors hover:text-zinc-300"
                          >
                            <span
                              className={`inline-block text-[10px] transition-transform ${
                                expandedChanges.has(key) ? 'rotate-90' : ''
                              }`}
                            >
                              ▶
                            </span>
                            {item.detail ?? t('sync.changesCount', { count: item.changes.length })}
                          </button>
                          {expandedChanges.has(key) && (
                            <ul className="mt-1 flex flex-col gap-0.5 border-l border-white/10 pl-3">
                              {item.changes.map((change, index) => (
                                <li key={index} className="text-xs leading-relaxed text-zinc-500">
                                  {change}
                                </li>
                              ))}
                            </ul>
                          )}
                        </>
                      ) : (
                        item.detail && <p className="text-xs text-zinc-500">{item.detail}</p>
                      )}
                    </div>
                    {staged ? (
                      <div className="flex items-center gap-2">
                        <span className="text-xs text-amber-400">{t('sync.willBeOverwrittenOnApply')}</span>
                        <button
                          onClick={() => setForcePush((prev) => new Set([...prev].filter((k) => k !== key)))}
                          disabled={busy}
                          className="rounded-lg border border-white/10 px-2.5 py-1 text-xs font-medium text-zinc-300 transition-colors hover:bg-white/5 disabled:opacity-50"
                        >
                          {t('common.cancel')}
                        </button>
                      </div>
                    ) : (
                      <div className="flex items-center gap-2">
                        <button
                          onClick={() => setForcePush((prev) => new Set(prev).add(key))}
                          disabled={busy || !isDesktop}
                          title={t('sync.overwriteFromSourceHint')}
                          className="rounded-lg border border-white/10 px-2.5 py-1 text-xs font-medium text-zinc-300 transition-colors hover:bg-white/5 disabled:opacity-50"
                        >
                          {t('sync.overwriteFromSource')}
                        </button>
                        <button
                          onClick={() => void pullIntoSource(item)}
                          disabled={busy || !isDesktop}
                          title={t('sync.copyIntoSourceHint')}
                          className="rounded-lg border border-white/10 px-2.5 py-1 text-xs font-medium text-zinc-300 transition-colors hover:bg-white/5 disabled:opacity-50"
                        >
                          {t('sync.copyIntoSourceAction')}
                        </button>
                        <button
                          onClick={() => toggleCell(item.component, item.minor)}
                          disabled={busy || !isDesktop}
                          title={t('sync.unlinkHint')}
                          className="rounded-lg border border-white/10 px-2.5 py-1 text-xs font-medium text-zinc-300 transition-colors hover:bg-white/5 disabled:opacity-50"
                        >
                          {t('sync.unlink')}
                        </button>
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}

          {(applying || restoring) && applyProgress && (
            <div className="mb-4 rounded-xl border border-white/10 bg-[#131313] px-4 py-3">
              <div className="mb-2 h-1.5 w-full overflow-hidden rounded-full bg-white/10">
                <div
                  className="h-full rounded-full bg-blender transition-[width] duration-200"
                  style={{
                    width: `${(
                      ((applyProgress.index +
                        (applyProgress.phase === 'done' || applyProgress.phase === 'error' ? 1 : 0.5)) /
                        Math.max(1, applyProgress.total)) *
                      100
                    ).toFixed(1)}%`
                  }}
                />
              </div>
              <p className="text-xs text-zinc-400">
                {t('sync.applyProgressLine', {
                  phase: t(PHASE_LABEL_KEYS[applyProgress.phase]),
                  minor: applyProgress.minor,
                  current: Math.min(applyProgress.index + 1, applyProgress.total),
                  total: applyProgress.total
                })}
              </p>
            </div>
          )}

          {data === null ? (
            <p className="text-sm text-zinc-500">
              {scanning ? t('sync.readingSettingsFolders') : t('sync.scanIntro')}
            </p>
          ) : columns.length === 0 ? (
            <p className="text-sm text-zinc-500">{t('sync.noSettingsFound')}</p>
          ) : (
            <>
              <div className="mb-3 flex items-start gap-4 text-[11px] text-zinc-500">
                <div className="flex flex-1 flex-wrap items-center gap-4">
                  <span className="flex items-center gap-1.5">
                    <span className="inline-block h-2.5 w-2.5 rounded-full bg-blender" /> {t('sync.legendSource')}
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className="inline-block h-2.5 w-2.5 rounded-full bg-emerald-400" /> {t('sync.legendInSync')}
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className="inline-block h-2.5 w-2.5 rounded-full bg-amber-400" /> {t('sync.legendWillCopy')}
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className="inline-block h-2.5 w-2.5 rounded-full border-2 border-amber-400" /> {t('sync.legendWillUnlink')}
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className="inline-block h-2.5 w-2.5 rounded-full bg-sky-400" /> {t('sync.legendChanged')}
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className="inline-block h-2.5 w-2.5 rounded-full bg-red-400" /> {t('sync.legendConflict')}
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className="inline-block h-2.5 w-2.5 rounded-full bg-zinc-500" /> {t('sync.legendNotLinked')}
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className="inline-block h-2.5 w-2.5 rounded-full border border-dashed border-zinc-600" /> {t('sync.notPresent')}
                  </span>
                </div>
                <Dropdown
                  className="shrink-0"
                  open={settingsOpen}
                  onClose={() => setSettingsOpen(false)}
                  align="right"
                  menuClassName="w-48 rounded-lg border border-white/10 bg-[#212121] p-1 shadow-xl"
                  trigger={
                    <button
                      title={t('sync.displaySettingsHint')}
                      onClick={() => setSettingsOpen((open) => !open)}
                      className="rounded-lg border border-white/10 p-1.5 text-zinc-400 transition-colors hover:bg-white/5 hover:text-zinc-200"
                    >
                      <GearIcon className="h-4 w-4" />
                    </button>
                  }
                >
                  <p className="px-2 py-1 text-[11px] font-medium uppercase tracking-wide text-zinc-500">{t('sync.showHeading')}</p>
                  <label className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm text-zinc-300 transition-colors hover:bg-white/5">
                    <input
                      type="checkbox"
                      checked={showPrefDate}
                      onChange={(event) => setShowPrefDate(event.target.checked)}
                      className="accent-blender"
                    />
                    {t('sync.preferencesDate')}
                  </label>
                  <label className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm text-zinc-300 transition-colors hover:bg-white/5">
                    <input
                      type="checkbox"
                      checked={showCycleBadge}
                      onChange={(event) => setShowCycleBadge(event.target.checked)}
                      className="accent-blender"
                    />
                    {t('sync.releaseCycleBadge')}
                  </label>
                  <div className="my-1 border-t border-white/5" />
                  <p className="px-2 py-1 text-[11px] font-medium uppercase tracking-wide text-zinc-500">{t('sync.behaviorHeading')}</p>
                  <label
                    className="flex cursor-pointer items-start gap-2 rounded px-2 py-1.5 text-sm text-zinc-300 transition-colors hover:bg-white/5"
                    title={t('sync.autoApplyHint')}
                  >
                    <input
                      type="checkbox"
                      checked={autoApplySource}
                      onChange={(event) => {
                        // the ref is set here, not on rerender: the rescan below must
                        // already see the new value when its auto-apply check runs
                        autoApplySourceRef.current = event.target.checked
                        setAutoApplySource(event.target.checked)
                        // takes effect right away: the rescan picks up waiting source changes
                        if (event.target.checked) void runScan(true)
                      }}
                      className="mt-0.5 accent-blender"
                    />
                    {t('sync.autoApplyLabel')}
                  </label>
                </Dropdown>
              </div>

              <StickyHScrollbar targetRef={tableScrollRef} />
              <div className="relative">
                <HScrollEdgeShadows targetRef={tableScrollRef} stickyRef={stickyColRef} />
                <div ref={tableScrollRef} className="overflow-x-auto rounded-xl border border-white/5">
                <table className="w-full border-collapse text-sm">
                  <thead>
                    <tr className="bg-[#131313]">
                      <th ref={stickyColRef} className="sticky left-0 z-10 bg-[#131313] px-4 py-2.5 text-left text-xs font-semibold uppercase tracking-wide text-zinc-500">
                        {t('sync.componentColumn')}
                      </th>
                      {/* p-0 + w-full trigger: the WHOLE header cell is the click target,
                          not just the label — the padding area must not be dead space */}
                      {columns.map((column) => (
                        <th key={column.minor} className="p-0 text-center align-bottom">
                          <Dropdown
                            className="w-full"
                            open={versionMenu === column.minor}
                            onClose={() => setVersionMenu(null)}
                            align="left"
                            menuClassName="w-44 rounded-lg border border-white/10 bg-[#212121] p-1 shadow-xl"
                            trigger={
                              <button
                                onClick={() =>
                                  setVersionMenu((open) => (open === column.minor ? null : column.minor))
                                }
                                title={
                                  column.installed
                                    ? `${column.version}${column.portable ? t('sync.portableInstallSuffix') : ''}`
                                    : t('sync.noInstalledBuildHint')
                                }
                                className="flex w-full flex-col items-center gap-1 px-3 py-2.5 transition-colors hover:bg-white/5"
                              >
                                <span className="flex items-center gap-1.5 text-sm font-semibold text-zinc-200">
                                  {column.minor}
                                  {source === column.minor && (
                                    <span
                                      className="h-1.5 w-1.5 shrink-0 rounded-full bg-blender"
                                      title={t('sync.sourceDotTitle')}
                                    />
                                  )}
                                </span>
                                {showCycleBadge && (
                                  <span
                                    className={`rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide ${
                                      column.installed
                                        ? (CYCLE_STYLES[column.releaseCycle ?? ''] ?? 'bg-white/10 text-zinc-400')
                                        : 'bg-white/10 text-zinc-400'
                                    }`}
                                  >
                                    {column.installed ? column.releaseCycle : t('sync.configOnly')}
                                  </span>
                                )}
                              </button>
                            }
                          >
                            {source !== column.minor && (
                              <button
                                onClick={() => {
                                  void changeSource(column.minor)
                                  setVersionMenu(null)
                                }}
                                disabled={busy || !isDesktop || !hasAnySettings(column)}
                                title={t('sync.copyFromThisVersionHint')}
                                className="w-full rounded px-2 py-1.5 text-left text-sm text-zinc-300 transition-colors hover:bg-white/5 disabled:opacity-50"
                              >
                                {t('sync.makeSource')}
                              </button>
                            )}
                            <button
                              onClick={() => {
                                copyLinkedSet(column.minor)
                                setVersionMenu(null)
                              }}
                              className="w-full rounded px-2 py-1.5 text-left text-sm text-zinc-300 transition-colors hover:bg-white/5"
                            >
                              {t('sync.copySet')}
                            </button>
                            {copiedSet &&
                              copiedSet.minor !== column.minor &&
                              column.installed &&
                              source !== column.minor && (
                                <button
                                  onClick={() => {
                                    pasteLinkedSet(column.minor)
                                    setVersionMenu(null)
                                  }}
                                  disabled={busy || !isDesktop}
                                  className="w-full rounded px-2 py-1.5 text-left text-sm text-zinc-300 transition-colors hover:bg-white/5 disabled:opacity-50"
                                >
                                  {t('sync.pasteSet')}
                                </button>
                              )}
                            {column.installed && column.installId && (
                              <>
                                <div className="my-1 border-t border-white/5" />
                                <button
                                  onClick={() => {
                                    if (column.installId) launchVersion(column.installId)
                                    setVersionMenu(null)
                                  }}
                                  disabled={busy}
                                  className="w-full rounded px-2 py-1.5 text-left text-sm text-zinc-300 transition-colors hover:bg-white/5 disabled:opacity-50"
                                >
                                  {t('sync.launchVersion')}
                                </button>
                              </>
                            )}
                            {!column.installed && (
                              <>
                                <div className="my-1 border-t border-white/5" />
                                {onShowInstalls && (
                                  <button
                                    onClick={() => {
                                      setVersionMenu(null)
                                      // same route as installing from Projects: the Installs
                                      // tab opens pre-filtered to this version's builds
                                      onShowInstalls(column.minor)
                                    }}
                                    title={t('sync.installHint', { minor: column.minor })}
                                    className="w-full rounded px-2 py-1.5 text-left text-sm text-zinc-300 transition-colors hover:bg-white/5 disabled:opacity-50"
                                  >
                                    {t('sync.installVersion')}
                                  </button>
                                )}
                                <button
                                  onClick={() => {
                                    void locateVersion()
                                    setVersionMenu(null)
                                  }}
                                  disabled={busy || !isDesktop}
                                  title={t('sync.locateHint')}
                                  className="w-full rounded px-2 py-1.5 text-left text-sm text-zinc-300 transition-colors hover:bg-white/5 disabled:opacity-50"
                                >
                                  {t('sync.locateVersion')}
                                </button>
                              </>
                            )}
                          </Dropdown>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {visibleRows.map((row) => {
                      const inSource = sourceCol?.components[row.id]?.present ?? false
                      const minors = rowEligible(row.id)
                      const linkedCount = minors.filter((minor) => linked.has(cellKey(minor, row.id))).length
                      const rowAll = minors.length > 0 && linkedCount === minors.length
                      const rowSome = linkedCount > 0 && !rowAll
                      return (
                        <tr key={row.id} className="border-t border-white/5">
                          <td className="sticky left-0 z-10 bg-[#131313] px-4 py-2.5">
                            <label
                              className={`flex items-start gap-2.5 ${inSource && minors.length > 0 ? 'cursor-pointer' : 'cursor-not-allowed'}`}
                              title={
                                inSource
                                  ? t('sync.keepLinkedEverywhereHint')
                                  : t('sync.notPresentInSourceHint')
                              }
                            >
                              <input
                                type="checkbox"
                                className="mt-0.5 accent-blender"
                                ref={(el) => {
                                  if (el) el.indeterminate = rowSome
                                }}
                                checked={rowAll}
                                onChange={() => toggleRowAll(row.id)}
                                disabled={busy || !isDesktop || !inSource || minors.length === 0}
                              />
                              <span className="min-w-0">
                                <span
                                  title={t(row.hintKey)}
                                  className={`block text-sm ${inSource ? 'text-zinc-200' : 'text-zinc-500'}`}
                                >
                                  {t(row.labelKey)}
                                </span>
                              </span>
                            </label>
                          </td>
                          {columns.map((column) => {
                            const key = cellKey(column.minor, row.id)
                            const face = faceOf(key)
                            return (
                              <SyncCell
                                key={column.minor}
                                state={column.components[row.id]}
                                isSource={column.minor === source}
                                stageable={inSource && column.installed && column.minor !== source}
                                face={face}
                                disabled={busy || !isDesktop}
                                sourceMinor={source}
                                onToggle={() => {
                                  if (face === 'push') {
                                    // a staged overwrite cancels back to its previous state
                                    setForcePush((prev) => new Set([...prev].filter((k) => k !== key)))
                                  } else {
                                    toggleCell(row.id, column.minor)
                                  }
                                }}
                              />
                            )
                          })}
                        </tr>
                      )
                    })}
                  </tbody>
                  {showPrefDate && (
                    <tfoot>
                      <tr className="border-t border-white/5 bg-[#131313]">
                        <td className="sticky left-0 z-10 bg-[#131313] px-4 py-2 text-xs text-zinc-500">
                          {t('sync.preferencesSaved')}
                        </td>
                        {columns.map((column) => (
                          <td key={column.minor} className="px-3 py-2 text-center text-[10px] text-zinc-600">
                            {column.userprefMtimeMs !== null
                              ? formatDateNumeric(column.userprefMtimeMs / 1000)
                              : '—'}
                          </td>
                        ))}
                      </tr>
                    </tfoot>
                  )}
                </table>
                </div>
              </div>

              <p className="mt-3 text-sm leading-relaxed text-zinc-500">
                {t('sync.matrixHelpPrefix')}
                <span className="text-zinc-300">{t('sync.matrixHelpSource')}</span>
                {t('sync.matrixHelpSuffix')}
              </p>
            </>
          )}
        </section>

        <section className="mt-2">
          <div className="mb-3 flex items-center justify-between gap-2">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">{t('sync.backupsHeading')}</h2>
            {backups.length > 0 && (
              <button
                onClick={() => void deleteAllBackups()}
                disabled={busy || !isDesktop}
                title={t('sync.deleteAllBackupsHint')}
                className="rounded-lg border border-white/10 px-3 py-1.5 text-xs font-medium text-zinc-400 transition-colors hover:bg-red-500/10 hover:text-red-400 disabled:opacity-50"
              >
                {t('sync.deleteAllBackups')}
              </button>
            )}
          </div>
          {backups.length === 0 ? (
            <p className="text-sm text-zinc-500">{t('sync.backupsEmpty')}</p>
          ) : (
            <div className="flex flex-col gap-2">
              {backups.map((backup) => (
                <div
                  key={backup.id}
                  className="flex flex-wrap items-center gap-3 rounded-xl border border-white/5 bg-[#131313] px-4 py-3"
                >
                  <div className="min-w-0 flex-1">
                    <p className="text-sm text-zinc-200">
                      Blender {backup.minor}
                      <span className="ml-2 rounded bg-white/5 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-zinc-500">
                        {backup.reason === 'sync'
                          ? backup.sourceMinor
                            ? t('sync.beforeSyncFrom', { source: backup.sourceMinor })
                            : t('sync.beforeSync')
                          : t('sync.beforeRestore')}
                      </span>
                    </p>
                    <p className="text-xs text-zinc-500">
                      {new Date(backup.createdAt).toLocaleString()} ·{' '}
                      {backup.components.map((component) => labelOf(component, t)).join(', ')} ·{' '}
                      {formatBytes(backup.bytes)}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <button
                      onClick={() => void restoreOne(backup)}
                      disabled={busy || !isDesktop}
                      title={t('sync.restoreBackupHint')}
                      className="rounded-lg border border-blender/40 px-3 py-1.5 text-sm font-medium text-blender transition-colors hover:bg-blender/10 disabled:opacity-50"
                    >
                      {t('common.restore')}
                    </button>
                    <button
                      onClick={() => void syncApi.revealBackup(backup.id).catch(() => {})}
                      disabled={!isDesktop}
                      title={t('sync.revealBackupHint')}
                      className="rounded-lg border border-white/10 p-1.5 text-zinc-400 transition-colors hover:bg-white/5 hover:text-zinc-200 disabled:opacity-50"
                    >
                      <FolderOpenIcon />
                    </button>
                    <button
                      onClick={() => void deleteOne(backup)}
                      disabled={busy || !isDesktop}
                      title={t('sync.deleteBackupHint')}
                      className="rounded-lg border border-white/10 p-1.5 text-zinc-400 transition-colors hover:bg-red-500/10 hover:text-red-400 disabled:opacity-50"
                    >
                      <TrashIcon />
                    </button>
                  </div>
                </div>
              ))}
            </div>
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

