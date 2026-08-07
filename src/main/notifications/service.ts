import { BrowserWindow } from 'electron'
import { createHash } from 'crypto'
import { onUiStateSet, readUiState } from '../ui-state'
import { checkForUpdate } from '../updates/updates'
import { listInstalled } from '../blender/installs'
import { getRemoteBuilds } from '../blender/remote-cache'
import { getAddonsScanCache } from '../addons/ipc'
import { getSuperhiveStatus, listSuperhiveCatalog } from '../addons/superhive'
import { listBlenderOrgCatalog } from '../addons/blender-org'
import { RepoAuthError } from '../addons/extensions-api'
import { scanSettings } from '../sync/scan'
import { opLockBusy } from '../op-lock'
import { groupAddons, numericVersion } from '../../shared/addon-identity'
import {
  compareVersionsDesc,
  cycleClass,
  isReleasedCycle,
  isRollingCycle,
  isSameBuild,
  isUpdateFor,
  STABLE_CYCLES
} from '../../shared/blender-builds'
import { minorOf } from '../../shared/blender-archive'
import {
  NOTIFY_BLENDER_ROLLING_KEY,
  NOTIFY_CATEGORY_KEYS,
  notifyCategoryEnabledValue,
  notifyRollingEnabledValue,
  type ToggleableNotificationCategory
} from '../../shared/notifications'
import { HIDDEN_SYNC_COMPONENT_IDS } from '../../shared/types'
import type {
  ExtensionCatalogItem,
  HubNotification,
  InstalledBuild,
  NotificationCategory,
  NotificationDraft,
  NotificationPayloads,
  RemoteBuild,
  SyncScanResult,
  UpdateCheckResult
} from '../../shared/types'
import {
  dismissAllNotifications,
  dismissNotification,
  listActive,
  markAllRead,
  pushEvent,
  reconcileCategory
} from './store'

// Background detection for the notification bell. Every check reuses an existing
// fetcher and its cache (GitHub redirect probe, buildbot feeds, extension listings,
// the fs-only sync scan) — no headless Blender ever runs from here, and a check that
// cannot get settled data keeps the current notifications instead of flapping them.

const STARTUP_DELAY_MS = 60_000
const CHECK_INTERVAL_MS = 6 * 60 * 60_000
const TOGGLE_DELAY_MS = 2_000

function broadcastList(items: HubNotification[]): void {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send('notifications:changed', items)
  }
}

function broadcastIf(items: HubNotification[] | null): void {
  if (items) broadcastList(items)
}

function draft<C extends NotificationCategory>(
  category: C,
  id: string,
  payload: NotificationPayloads[C]
): NotificationDraft {
  return { id, category, payload } as NotificationDraft
}

async function reconcile(category: NotificationCategory, drafts: NotificationDraft[]): Promise<void> {
  broadcastIf(await reconcileCategory(category, drafts))
}

const enabled = (category: ToggleableNotificationCategory, ui: Record<string, string>): boolean =>
  notifyCategoryEnabledValue(category, ui[NOTIFY_CATEGORY_KEYS[category]])

// --- IPC surface (thin wrappers so mutations broadcast from one place) --------

export async function notificationsList(): Promise<HubNotification[]> {
  return listActive()
}

export async function notificationsMarkAllRead(): Promise<void> {
  broadcastIf(await markAllRead())
}

export async function notificationsDismiss(id: string): Promise<void> {
  broadcastIf(await dismissNotification(id))
}

export async function notificationsDismissAll(): Promise<void> {
  broadcastIf(await dismissAllNotifications())
}

// --- producers ----------------------------------------------------------------

/** fed by every updates:state emission, so the bell mirrors the sidebar badge */
export function applyLauncherUpdateState(state: UpdateCheckResult): void {
  const drafts =
    state.updateAvailable && state.latestVersion
      ? [
          draft('launcher-update', `launcher-update:v${state.latestVersion}`, {
            version: state.latestVersion
          })
        ]
      : []
  void reconcile('launcher-update', drafts).catch(() => {})
}

/** called by the builds:install handler; cancelled installs never get here */
export function notifyBuildInstallResult(
  build: { version: string; releaseCycle: string },
  error?: string
): void {
  void (async () => {
    const ui = await readUiState()
    if (!enabled('operation', ui)) return
    const stamp = Date.now()
    const next = await pushEvent({
      id: `operation:${error ? 'error' : 'done'}:${build.version}:${stamp}`,
      category: 'operation',
      createdAt: stamp,
      read: false,
      payload: {
        result: error ? 'error' : 'done',
        version: build.version,
        releaseCycle: build.releaseCycle,
        ...(error ? { error } : {})
      }
    })
    broadcastList(next)
  })().catch(() => {})
}

// --- detectors ----------------------------------------------------------------

async function checkBlenderUpdates(ui: Record<string, string>): Promise<void> {
  if (!enabled('blender-update', ui)) {
    await reconcile('blender-update', [])
    return
  }
  let installed: InstalledBuild[]
  let remote: RemoteBuild[]
  try {
    installed = await listInstalled()
    remote = await getRemoteBuilds()
  } catch {
    return // offline or unreadable installs — keep whatever the bell shows
  }
  const rollingWanted = notifyRollingEnabledValue(ui[NOTIFY_BLENDER_ROLLING_KEY])
  // mirrors the Installs page's updateByCopyId: a copy whose line already holds a
  // newer installed copy needs no ping — the newer one is right there
  const coveredIds = new Set<string>()
  for (const entry of installed) {
    const covered = installed.some((other) => {
      if (other.id === entry.id) return false
      if (!STABLE_CYCLES.has(other.releaseCycle) || !STABLE_CYCLES.has(entry.releaseCycle)) return false
      if (minorOf(other.version) !== minorOf(entry.version)) return false
      if (!isReleasedCycle(other.releaseCycle) && isReleasedCycle(entry.releaseCycle)) return false
      const cmp = compareVersionsDesc(other.version, entry.version)
      return (
        cmp < 0 || (cmp === 0 && isReleasedCycle(other.releaseCycle) && !isReleasedCycle(entry.releaseCycle))
      )
    })
    if (covered) coveredIds.add(entry.id)
  }
  const bestTarget = new Map<string, RemoteBuild>()
  for (const build of remote) {
    if (installed.some((entry) => entry.remoteId === build.id || isSameBuild(entry, build))) continue
    for (const entry of installed) {
      if (coveredIds.has(entry.id) || !isUpdateFor(build, entry)) continue
      if (!rollingWanted && isRollingCycle(entry.releaseCycle)) continue
      const known = bestTarget.get(entry.id)
      if (!known) {
        bestTarget.set(entry.id, build)
        continue
      }
      const cmp = compareVersionsDesc(build.version, known.version)
      const wins =
        cmp === 0 &&
        (isReleasedCycle(build.releaseCycle) !== isReleasedCycle(known.releaseCycle)
          ? isReleasedCycle(build.releaseCycle)
          : build.fileMtime > known.fileMtime)
      if (cmp < 0 || wins) bestTarget.set(entry.id, build)
    }
  }
  const byId = new Map(installed.map((entry) => [entry.id, entry]))
  const drafts = new Map<string, NotificationDraft>()
  for (const [entryId, build] of bestTarget) {
    const entry = byId.get(entryId)
    if (!entry) continue
    // several copies of the very same build share one id — one ping per line
    const id = `blender-update:${entry.version}|${cycleClass(entry.releaseCycle)}|${entry.branch ?? ''}|${entry.commit ?? ''}->${build.version}|${cycleClass(build.releaseCycle)}|${build.commit}`
    drafts.set(
      id,
      draft('blender-update', id, {
        installedVersion: entry.version,
        installedCycle: entry.releaseCycle,
        targetVersion: build.version,
        targetCycle: build.releaseCycle
      })
    )
  }
  await reconcile('blender-update', [...drafts.values()])
}

async function checkAddonUpdates(ui: Record<string, string>): Promise<void> {
  const addonsWanted = enabled('addon-update', ui)
  const authWanted = enabled('superhive-auth', ui)
  if (!addonsWanted) await reconcile('addon-update', [])
  if (!authWanted) await reconcile('superhive-auth', [])
  if (!addonsWanted && !authWanted) return

  let superhiveConnected = false
  let superhiveCatalog: ExtensionCatalogItem[] | null = null
  let authRejected = false
  try {
    superhiveConnected = (await getSuperhiveStatus()).connected
    if (superhiveConnected) superhiveCatalog = await listSuperhiveCatalog()
  } catch (error) {
    // anything but an explicit token rejection is an outage — not an auth problem
    if (error instanceof RepoAuthError) authRejected = true
  }
  if (authWanted) {
    await reconcile(
      'superhive-auth',
      authRejected ? [draft('superhive-auth', 'superhive-auth:token', {})] : []
    )
  }
  if (!addonsWanted) return

  const scans = getAddonsScanCache()
  if (!scans || scans.length === 0) return // nothing scanned this session — keep the current state
  let orgCatalog: ExtensionCatalogItem[] | null = null
  try {
    orgCatalog = await listBlenderOrgCatalog()
  } catch {
    // no Blender 4.2+ installed, or the catalog is unreachable
  }
  // reconcile only from settled data: a missing catalog would silently prune (and
  // later resurrect as unread) every notification of the host it covers
  if (!orgCatalog) return
  if (superhiveConnected && !superhiveCatalog) return

  const superhiveById = new Map((superhiveCatalog ?? []).map((item) => [item.pkgId, item]))
  const orgById = new Map(orgCatalog.map((item) => [item.pkgId, item]))
  const drafts: NotificationDraft[] = []
  for (const row of groupAddons(scans)) {
    if (!row.manual) continue // bundled add-ons update with Blender itself
    // quarantined custom-repo forks (ext:<pkg>@<repo>) may differ from the catalog package
    if (!row.canonicalId.startsWith('ext:') || row.canonicalId.includes('@')) continue
    const pkgId = row.canonicalId.slice('ext:'.length)
    // Superhive wins at equal pkgId — the same precedence the Install button uses
    const item = superhiveById.get(pkgId) ?? orgById.get(pkgId)
    if (!item) continue
    const catalogVersion = numericVersion(item.version)
    if (!catalogVersion) continue
    let installedBest: string | null = null
    for (const info of row.perMinor.values()) {
      if (info.missing) continue
      const version = numericVersion(info.version)
      if (version && (!installedBest || compareVersionsDesc(version, installedBest) < 0)) {
        installedBest = version
      }
    }
    if (!installedBest) continue
    if (compareVersionsDesc(catalogVersion, installedBest) >= 0) continue // not strictly newer
    drafts.push(
      draft('addon-update', `addon-update:${pkgId}:${catalogVersion}`, {
        name: row.name,
        pkgId,
        installedVersion: installedBest,
        catalogVersion,
        host: superhiveById.has(pkgId) ? 'superhive' : 'blender_org'
      })
    )
  }
  await reconcile('addon-update', drafts)
}

async function checkSyncChanges(ui: Record<string, string>): Promise<void> {
  if (!enabled('sync-changes', ui)) {
    await reconcile('sync-changes', [])
    return
  }
  // Never touch the shared op-lock from the background: holding it would fail a
  // user-driven Apply with a bogus busy error (the asset-library lesson). The scan
  // is read-only fs work, so it runs lock-free; if an operation was running on
  // either side of it, the snapshot may be torn — drop it and wait for the next round.
  if (opLockBusy()) return
  let result: SyncScanResult
  try {
    result = await scanSettings()
  } catch {
    return // scan failure — keep the current state, retry next round
  }
  if (opLockBusy()) return
  const drifted = result.statuses.filter(
    (status) =>
      (status.condition === 'sourceChanged' ||
        status.condition === 'targetChanged' ||
        status.condition === 'conflict') &&
      !HIDDEN_SYNC_COMPONENT_IDS.includes(status.component)
  )
  if (drifted.length === 0) {
    await reconcile('sync-changes', [])
    return
  }
  const minors = [...new Set(drifted.map((status) => status.minor))].sort()
  const conflicts = drifted.filter((status) => status.condition === 'conflict').length
  // the id IS the change-set: a dismissal holds exactly until the set itself changes
  const fingerprint = createHash('sha256')
    .update(
      drifted
        .map((status) => `${status.minor}:${status.component}:${status.condition}`)
        .sort()
        .join('|')
    )
    .digest('hex')
    .slice(0, 12)
  await reconcile('sync-changes', [
    draft('sync-changes', `sync-changes:${fingerprint}`, {
      minors,
      conflicts,
      changed: drifted.length - conflicts
    })
  ])
}

// --- scheduling ---------------------------------------------------------------

let scheduled: NodeJS.Timeout | null = null
let scheduledFireAt = 0
let runInFlight = false
let rerunRequested = false

function scheduleNotificationChecks(delayMs: number): void {
  const fireAt = Date.now() + delayMs
  // earliest wakeup wins: the 6h re-arm after a run must not clobber a toggle's
  // quick re-check armed while that run was still in flight
  if (scheduled && scheduledFireAt <= fireAt) return
  if (scheduled) clearTimeout(scheduled)
  scheduledFireAt = fireAt
  scheduled = setTimeout(() => {
    scheduled = null
    void runChecks()
  }, delayMs)
  // a pending timer must not keep the app alive on quit
  scheduled.unref?.()
}

async function runChecks(): Promise<void> {
  if (runInFlight) {
    rerunRequested = true
    return
  }
  runInFlight = true
  try {
    const ui = await readUiState()
    try {
      const state = await checkForUpdate(false)
      applyLauncherUpdateState(state)
      // background checks keep the sidebar badge honest too
      for (const window of BrowserWindow.getAllWindows()) {
        window.webContents.send('updates:state', state)
      }
    } catch {
      // checkForUpdate reports failures inside its result; a throw here is unexpected
    }
    await checkBlenderUpdates(ui).catch(() => {})
    await checkAddonUpdates(ui).catch(() => {})
    await checkSyncChanges(ui).catch(() => {})
  } finally {
    runInFlight = false
    scheduleNotificationChecks(rerunRequested ? TOGGLE_DELAY_MS : CHECK_INTERVAL_MS)
    rerunRequested = false
  }
}

export function setupNotifications(): void {
  onUiStateSet((key) => {
    // a flipped toggle re-detects quickly: enabling shows results now, disabling clears
    if (key.startsWith('notify.')) scheduleNotificationChecks(TOGGLE_DELAY_MS)
  })
  scheduleNotificationChecks(STARTUP_DELAY_MS)
}
