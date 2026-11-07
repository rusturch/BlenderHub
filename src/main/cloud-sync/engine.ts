import { BrowserWindow } from 'electron'
import { createHash } from 'crypto'
import { mkdir, readdir, readFile, rename, stat, unlink, writeFile } from 'fs/promises'
import { join } from 'path'
import { getDataRoot } from '../paths'
import { readUiState, setUiValueFromMain } from '../ui-state'
import {
  BUNDLE_SCHEMA,
  CLOUD_ENABLED_UI_KEY,
  isSharedUiKey,
  isSyncItemId,
  isThemeItemId,
  MANIFEST_MAX_ITEMS,
  sharedUiSubset,
  stableStringify,
  themeIdFromItemId,
  themeItemId,
  UI_STATE_ITEM_ID,
  type ManifestItem,
  type SyncEnvelope
} from '../../shared/cloud-sync'
import { isThemeId, sanitizeThemeColors, THEME_NAME_MAX } from '../../shared/theme'
import type { CloudSyncAccount, CloudSyncStatus, CloudSyncUsage } from '../../shared/types'
import * as drive from './drive'
import { CloudAuthError } from './drive'
import { openAuthUrlInBrowser, startSignIn, type SignInSession } from './google-auth'
import { detectCloudSyncedDataFolder, machineId, machineTag } from './machine'
import { clearCloudToken, encryptionAvailable, getCloudToken, hasCloudToken, setCloudToken } from './token'
import { readSyncState, resetSyncState, updateSyncState } from './store'

// The client sync engine: a pull-then-push round per item in the app's hidden
// folder of the USER'S OWN Google Drive, keyed by the Drive file version,
// change-detected by content sha256 (so a Dropbox echo dies in one turn).
// Every pulled value is treated as untrusted and re-validated exactly like
// local UI input before it is applied. The engine never touches Blender
// configs and never runs headless, so it takes no op-lock.

const UI_PAYLOAD_FORMAT = 'ui-state@1'
const THEME_PAYLOAD_FORMAT = 'theme@1'
const THEME_FILE_MAX_BYTES = 64 * 1024

const STARTUP_DELAY_MS = 60_000
const ROUND_INTERVAL_MS = 15 * 60_000
const PUSH_DEBOUNCE_MS = 45_000

type NotifyReason = 'auth' | 'overwritten'
let notifyHook: (reason: NotifyReason | null) => void = () => {}
export function setCloudNotifyHook(hook: (reason: NotifyReason | null) => void): void {
  notifyHook = hook
}

// --- module state ------------------------------------------------------------

let enabled = false
let syncing = false
let lastSyncAt: number | null = null
let lastError: string | null = null
let cachedAccount: CloudSyncAccount | null = null
let cachedUsage: CloudSyncUsage | null = null
let applying = false // suppress the push feedback from our own ui-state writes

let roundTimer: ReturnType<typeof setTimeout> | null = null
let roundFireAt = 0
let currentRun: Promise<void> | null = null
let rerunRequested = false

// first-link resolution: on connecting a second machine whose local ui-state
// differs from the cloud's, we park and ask the user which side wins rather
// than silently overwriting. null = no pending choice.
let firstLinkPending = false
let firstLinkChoice: 'cloud' | 'local' | null = null

// last time Drive answered — network blips within the offline-grace window are
// a quiet skipped round, not a scary error in the card.
let lastCloudOkAt = 0
const OFFLINE_GRACE_MS = 72 * 60 * 60_000

let connectSession: SignInSession | null = null

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex')

// Deleted items still need a valid content hash: the envelope schema requires
// 64 hex chars, and both machines must derive the SAME value for a tombstone
// so the echo check works. A fixed marker string gives both.
const TOMBSTONE_SHA = createHash('sha256').update('blenderhub-tombstone').digest('hex')

// --- status ------------------------------------------------------------------

function buildStatus(connected: boolean): CloudSyncStatus {
  return {
    connected,
    available: encryptionAvailable(),
    enabled,
    account: cachedAccount,
    usage: cachedUsage,
    syncing,
    lastSyncAt,
    lastError,
    firstLinkPending,
    connecting: connectSession !== null,
    dataFolderCloudHint: detectCloudSyncedDataFolder(getDataRoot())
  }
}

export async function currentStatus(): Promise<CloudSyncStatus> {
  return buildStatus(await hasCloudToken())
}

async function emitState(): Promise<void> {
  const status = await currentStatus()
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send('cloud-sync:state', status)
  }
}

export function setEnabled(value: boolean): void {
  enabled = value
  if (enabled) scheduleRound(2_000)
  void emitState()
}

// --- theme file access -------------------------------------------------------

const themesDir = (): string => join(getDataRoot(), 'themes')
const themeFilePath = (id: string): string => join(themesDir(), `${id}.json`)

async function readThemeFile(id: string): Promise<{ name: string; colors: Record<string, string> } | null> {
  // never build an fs path from an unvalidated id (a manifest id like
  // `../../x` must not escape the themes folder even if a caller slips)
  if (!isThemeId(id)) return null
  try {
    const path = themeFilePath(id)
    if ((await stat(path)).size > THEME_FILE_MAX_BYTES) return null
    const parsed = JSON.parse(await readFile(path, 'utf8')) as { name?: unknown; colors?: unknown }
    const name = typeof parsed.name === 'string' ? parsed.name.slice(0, THEME_NAME_MAX) : id
    return { name, colors: sanitizeThemeColors(parsed.colors) }
  } catch {
    return null
  }
}

async function listLocalThemeIds(): Promise<string[]> {
  try {
    return (await readdir(themesDir()))
      .filter((entry) => entry.endsWith('.json'))
      .map((entry) => entry.slice(0, -'.json'.length))
      .filter(isThemeId)
  } catch {
    return []
  }
}

async function writeThemeFile(id: string, name: string, colors: Record<string, string>): Promise<void> {
  await mkdir(themesDir(), { recursive: true })
  const target = themeFilePath(id)
  await writeFile(`${target}.tmp`, JSON.stringify({ name, colors }, null, 2))
  await rename(`${target}.tmp`, target)
}

/**
 * Snapshot the local shared ui-state before the cloud overwrites it, so a
 * conflict never destroys the user's settings with no recourse (themes get a
 * conflict copy; ui-state gets this per-machine backup file). Best-effort.
 */
async function backupLocalUiState(payload: unknown): Promise<void> {
  if (!payload || typeof payload !== 'object') return
  try {
    const target = join(getDataRoot(), `cloud-sync-backup.${machineTag()}.json`)
    await mkdir(getDataRoot(), { recursive: true })
    await writeFile(`${target}.tmp`, JSON.stringify({ savedAt: Date.now(), uiState: payload }, null, 2))
    await rename(`${target}.tmp`, target)
  } catch (error) {
    console.warn('[cloud-sync] could not back up ui-state before overwrite:', error)
  }
}

// --- payload extraction / application (all pulled values are untrusted) -------

interface LocalItem {
  payload: unknown
  sha: string
  deleted: boolean
}

async function extractUiState(carry: Record<string, string> | undefined): Promise<LocalItem> {
  const subset = sharedUiSubset(await readUiState())
  // carry-through: keep keys a newer client wrote that this build doesn't know,
  // so pushing from an older client can't drop them
  const payload: Record<string, string> = { ...(carry ?? {}), ...subset }
  const canonical = stableStringify(payload)
  return { payload, sha: sha256(canonical), deleted: false }
}

async function extractTheme(id: string): Promise<LocalItem> {
  const file = await readThemeFile(id)
  if (!file) return { payload: null, sha: TOMBSTONE_SHA, deleted: true }
  const payload = { name: file.name, colors: file.colors }
  return { payload, sha: sha256(stableStringify(payload)), deleted: false }
}

async function applyUiState(payload: unknown): Promise<void> {
  if (!payload || typeof payload !== 'object') return
  applying = true
  try {
    for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
      if (typeof value !== 'string' || !isSharedUiKey(key) || value.length > 4096) continue
      // themeColors is the one value that reaches style.setProperty — sanitize
      // it exactly like the local editor does before persisting
      if (key === 'launcher.themeColors') {
        try {
          const safe = sanitizeThemeColors(JSON.parse(value))
          await setUiValueFromMain(key, JSON.stringify(safe))
        } catch {
          // unparseable color blob — skip rather than store garbage
        }
        continue
      }
      await setUiValueFromMain(key, value)
    }
  } finally {
    applying = false
  }
}

async function applyTheme(id: string, envelope: SyncEnvelope): Promise<void> {
  if (!isThemeId(id)) return
  if (envelope.deleted) {
    await unlink(themeFilePath(id)).catch(() => {})
    return
  }
  const payload = envelope.payload as { name?: unknown; colors?: unknown } | null
  if (!payload || typeof payload !== 'object') return
  const name = typeof payload.name === 'string' ? payload.name.slice(0, THEME_NAME_MAX) : id
  const colors = sanitizeThemeColors(payload.colors) // untrusted → sanitized
  await writeThemeFile(id, name, colors)
}

function buildEnvelope(itemId: string, item: LocalItem, parentGeneration: number): SyncEnvelope {
  return {
    bundleSchema: BUNDLE_SCHEMA,
    itemId,
    payloadFormat: itemId === UI_STATE_ITEM_ID ? UI_PAYLOAD_FORMAT : THEME_PAYLOAD_FORMAT,
    parentGeneration,
    deviceId: machineId(),
    updatedAt: Date.now(),
    sha256: item.sha,
    deleted: item.deleted,
    encryption: 'none',
    payload: item.deleted ? null : item.payload
  }
}

// --- one sync round ----------------------------------------------------------

async function reconcileItem(
  token: string,
  itemId: string,
  local: LocalItem,
  remote: ManifestItem | undefined
): Promise<{ overwroteLocal: boolean }> {
  const state = await readSyncState()
  const record = state.items[itemId]
  const lastGen = record?.lastSyncedGeneration ?? 0
  const lastSha = record?.lastSyncedSha256 ?? ''

  const remoteGen = remote?.generation ?? 0
  const remoteExists = remote !== undefined

  // no-op adopt: local content already equals the cloud's (e.g. a portable
  // folder copied to a new machine) — just record the generation, never treat
  // matching content as a conflict. This is the guard the design requires so a
  // fresh machine doesn't spam conflict copies of identical themes.
  if (remoteExists && !local.deleted && remote!.sha256 === local.sha) {
    if (lastGen !== remoteGen || lastSha !== local.sha) {
      await recordItem(itemId, { lastSyncedGeneration: remoteGen, lastSyncedSha256: local.sha })
    }
    return { overwroteLocal: false }
  }

  const localChanged = local.sha !== lastSha && !(local.deleted && !record)
  const remoteChanged = remoteGen !== lastGen

  // nothing on either side we haven't already reconciled
  if (!localChanged && !remoteChanged) return { overwroteLocal: false }

  // pull: cloud moved, local untouched (or local never had it)
  if (remoteChanged && !localChanged) {
    if (!remoteExists) {
      // cloud item vanished (shouldn't happen without a tombstone) — drop record
      await recordItem(itemId, null)
      return { overwroteLocal: false }
    }
    return pull(token, itemId)
  }

  // push: local moved, cloud untouched
  if (localChanged && !remoteChanged) {
    const result = await drive.putItem(token, itemId, buildEnvelope(itemId, local, lastGen), lastGen)
    if (result.ok) {
      await recordItem(itemId, { lastSyncedGeneration: result.generation, lastSyncedSha256: local.sha })
      if (itemId === UI_STATE_ITEM_ID && !local.deleted) await rememberPulledUi(local.payload)
      return { overwroteLocal: false }
    }
    // lost the write race → treat as a conflict this round
    if (remote) return resolveConflict(token, itemId, local)
    return { overwroteLocal: false }
  }

  // conflict: both moved
  if (remote) return resolveConflict(token, itemId, local)
  return { overwroteLocal: false }
}

/**
 * Both sides changed. v1 has no trustworthy per-item local change time in a
 * shared clock, so true LWW isn't implemented (and client-clock LWW is a
 * spoofing vector); instead cloud wins — but NON-DESTRUCTIVELY: a theme keeps
 * a local conflict copy, ui-state is backed up before overwrite, and either
 * way the caller raises the 'overwritten' notification. Nothing is silently
 * lost.
 */
async function resolveConflict(token: string, itemId: string, local: LocalItem): Promise<{ overwroteLocal: boolean }> {
  if (isThemeItemId(itemId)) {
    if (!local.deleted) await keepThemeConflictCopy(itemId, local)
    await pull(token, itemId)
    return { overwroteLocal: true }
  }
  if (itemId === UI_STATE_ITEM_ID) await backupLocalUiState(local.payload)
  await pull(token, itemId)
  return { overwroteLocal: true }
}

async function pull(token: string, itemId: string): Promise<{ overwroteLocal: boolean }> {
  const fetched = await drive.fetchItem(token, itemId)
  if (!fetched) return { overwroteLocal: false }
  const { envelope, generation } = fetched
  if (itemId === UI_STATE_ITEM_ID) {
    await applyUiState(envelope.payload)
    await rememberPulledUi(envelope.payload)
  } else if (isThemeItemId(itemId)) {
    await applyTheme(themeIdFromItemId(itemId), envelope)
  }
  await recordItem(itemId, { lastSyncedGeneration: generation, lastSyncedSha256: envelope.sha256 })
  return { overwroteLocal: false }
}

async function keepThemeConflictCopy(itemId: string, local: LocalItem): Promise<void> {
  const id = themeIdFromItemId(itemId)
  const payload = local.payload as { name?: string; colors?: Record<string, string> }
  const copyId = `${id}-conflict-${machineId().slice(0, 6)}`.slice(0, 40)
  if (isThemeId(copyId) && payload?.colors) {
    await writeThemeFile(copyId, `${payload.name ?? id} (conflict)`.slice(0, THEME_NAME_MAX), payload.colors).catch(
      () => {}
    )
  }
}

async function recordItem(
  itemId: string,
  record: { lastSyncedGeneration: number; lastSyncedSha256: string } | null
): Promise<void> {
  await updateSyncState((state) => {
    const items = { ...state.items }
    if (record) items[itemId] = record
    else delete items[itemId]
    return { ...state, items }
  })
}

async function rememberPulledUi(payload: unknown): Promise<void> {
  if (!payload || typeof payload !== 'object') return
  const record: Record<string, string> = {}
  for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
    if (typeof value === 'string') record[key] = value
  }
  await updateSyncState((state) => ({ ...state, lastPulledUiState: record }))
}

async function runRound(): Promise<void> {
  const token = await getCloudToken()
  if (!token) return

  // cheap liveness + fresh account info once per round
  cachedAccount = await drive.fetchAccount(token)
  lastCloudOkAt = Date.now()
  notifyHook(null)

  const manifest = await drive.fetchManifest(token)
  const state = await readSyncState()

  // cloud data was deleted/reset elsewhere → the deletion must NOT be undone by
  // this machine re-uploading everything. Drop bookkeeping, turn the toggle off
  // and stop: syncing resumes only when the user explicitly re-enables it.
  if (state.linked && manifest.dataEpoch !== state.dataEpoch) {
    await resetSyncState()
    await setUiValueFromMain(CLOUD_ENABLED_UI_KEY, 'off') // listener drops `enabled`
    lastError = 'Cloud data was deleted — turn sync back on to start fresh'
    return
  }

  // validate every cloud-supplied id before it can reach a filesystem path,
  // and cap how many we process (the listing is untrusted input)
  const validItems = manifest.items.filter((item) => isSyncItemId(item.itemId)).slice(0, MANIFEST_MAX_ITEMS)
  const remoteById = new Map(validItems.map((item) => [item.itemId, item]))
  cachedUsage = {
    usedBytes: validItems.reduce((sum, item) => sum + item.size, 0),
    itemCount: validItems.length
  }

  const firstLink = !state.linked
  if (firstLink) {
    const resolved = await resolveFirstLinkIfNeeded(token, state.lastPulledUiState, remoteById.get(UI_STATE_ITEM_ID))
    if (!resolved) return // parked for the user's choice; a later round continues
  }
  await updateSyncState((s) => ({ ...s, dataEpoch: manifest.dataEpoch }))

  const fresh = await readSyncState()
  const localThemeIds = await listLocalThemeIds()
  const itemIds = new Set<string>([UI_STATE_ITEM_ID])
  for (const id of localThemeIds) itemIds.add(themeItemId(id))
  for (const item of validItems) itemIds.add(item.itemId)

  let overwroteLocal = false
  const errors: string[] = []
  for (const itemId of itemIds) {
    const local =
      itemId === UI_STATE_ITEM_ID
        ? await extractUiState(fresh.lastPulledUiState)
        : isThemeItemId(itemId)
          ? await extractTheme(themeIdFromItemId(itemId))
          : { payload: null, sha: '', deleted: true }
    try {
      const result = await reconcileItem(token, itemId, local, remoteById.get(itemId))
      overwroteLocal = overwroteLocal || result.overwroteLocal
    } catch (error) {
      // a dead grant must surface, not be swallowed as a per-item warning
      if (error instanceof CloudAuthError) throw error
      errors.push(error instanceof Error ? error.message : String(error))
      console.warn(`[cloud-sync] item ${itemId} failed this round:`, error)
    }
  }

  if (firstLink) await updateSyncState((s) => ({ ...s, linked: true }))
  if (overwroteLocal) notifyHook('overwritten')
  // a persistent per-item failure (e.g. Drive quota) must be visible, not
  // hidden behind a fake "synced just now"
  if (errors.length > 0) {
    lastError = errors.length === 1 ? errors[0]! : `${errors.length} items failed: ${errors[0]!}`
  } else {
    lastSyncAt = Date.now()
    lastError = null
  }
}

/**
 * First-link ui-state resolution (design §1.1). When a second machine connects
 * and its local shared ui-state differs from the cloud's, we must not silently
 * pick a winner — park and let the user choose "take from cloud" or "upload
 * this machine". Returns true to proceed with the round, false when parked.
 * Themes are safe to merge by id and are handled by the normal loop.
 */
async function resolveFirstLinkIfNeeded(
  token: string,
  carry: Record<string, string> | undefined,
  remoteUi: ManifestItem | undefined
): Promise<boolean> {
  const local = await extractUiState(carry)
  // no cloud ui-state, or it already equals local → nothing to choose
  if (!remoteUi || remoteUi.sha256 === local.sha) {
    firstLinkPending = false
    firstLinkChoice = null
    return true
  }
  if (!firstLinkChoice) {
    if (!firstLinkPending) {
      firstLinkPending = true
      await emitState()
    }
    return false
  }
  // user chose: apply it, then let the round continue normally
  if (firstLinkChoice === 'local') {
    const result = await drive.putItem(
      token,
      UI_STATE_ITEM_ID,
      buildEnvelope(UI_STATE_ITEM_ID, local, remoteUi.generation),
      remoteUi.generation
    )
    if (result.ok) {
      await recordItem(UI_STATE_ITEM_ID, { lastSyncedGeneration: result.generation, lastSyncedSha256: local.sha })
      await rememberPulledUi(local.payload)
    }
  } else {
    await backupLocalUiState(local.payload)
    await pull(token, UI_STATE_ITEM_ID)
  }
  firstLinkPending = false
  firstLinkChoice = null
  return true
}

export async function resolveFirstLink(choice: 'cloud' | 'local'): Promise<CloudSyncStatus> {
  firstLinkChoice = choice
  await runChecked(true)
  return currentStatus()
}

// --- scheduler ---------------------------------------------------------------

function scheduleRound(delayMs: number): void {
  const fireAt = Date.now() + delayMs
  if (roundTimer && roundFireAt <= fireAt) return
  if (roundTimer) clearTimeout(roundTimer)
  roundFireAt = fireAt
  roundTimer = setTimeout(() => {
    roundTimer = null
    void runChecked()
  }, delayMs)
  roundTimer.unref?.()
}

async function runChecked(force = false): Promise<void> {
  // `force` = an explicit user action (Sync now): it runs even with the
  // background toggle off — the toggle governs the schedule, not the button.
  if (!(await hasCloudToken())) return
  if (!enabled && !force) return
  if (currentRun) {
    rerunRequested = true
    return
  }
  currentRun = (async () => {
    syncing = true
    await emitState()
    try {
      await runRound()
    } catch (error) {
      if (error instanceof CloudAuthError) {
        lastError = 'Google access was revoked — reconnect in Settings'
        notifyHook('auth')
      } else if (lastCloudOkAt > 0 && Date.now() - lastCloudOkAt < OFFLINE_GRACE_MS) {
        // transient network blip within the offline-grace window: a quiet
        // skipped round, not a scary error — keep the last good status
      } else {
        lastError = error instanceof Error ? error.message : 'Cloud sync failed'
      }
    } finally {
      syncing = false
      await emitState()
      scheduleRound(rerunRequested ? 2_000 : ROUND_INTERVAL_MS)
      rerunRequested = false
    }
  })()
  try {
    await currentRun
  } finally {
    currentRun = null
  }
}

/**
 * An immediate, awaited round for the "Sync now" button. A round already in
 * flight is awaited first (never silently skipped — the first click must not
 * look like a dud), then a forced round runs regardless of the toggle.
 */
export async function syncNow(): Promise<CloudSyncStatus> {
  const running = currentRun
  if (running) await running.catch(() => {})
  await runChecked(true)
  return currentStatus()
}

// --- connect / disconnect ----------------------------------------------------

export interface ConnectPending {
  status: 'pending'
  verificationUrl: string
  expiresAt: number
}

export async function connectStart(): Promise<ConnectPending> {
  if (!encryptionAvailable()) throw new Error('Secure storage is unavailable, so cloud sync cannot store its sign-in')
  connectCancel() // a fresh attempt supersedes a stale one
  const session = await startSignIn()
  connectSession = session
  session.tokens
    .then((refreshToken) => finishConnect(refreshToken))
    .catch(async (error: Error) => {
      if (connectSession === session) {
        connectSession = null
        // user-initiated cancels stay quiet; real failures surface in the card
        if (!/cancelled/i.test(error.message)) lastError = error.message
        await emitState()
      }
    })
  // main opens the browser itself: the renderer only sent the "connect" command
  openAuthUrlInBrowser(session.authUrl)
  return {
    status: 'pending',
    verificationUrl: session.authUrl,
    expiresAt: Date.now() + 10 * 60_000
  }
}

/** re-open the Google consent page for the sign-in attempt currently in flight. */
export function openVerification(): void {
  if (connectSession) openAuthUrlInBrowser(connectSession.authUrl)
}

async function finishConnect(refreshToken: string): Promise<void> {
  await setCloudToken(refreshToken)
  connectSession = null
  await resetSyncState()
  drive.dropCaches(refreshToken)
  lastError = null
  // connecting IS the intent to sync — flip the machine toggle on so the first
  // round isn't silently skipped (the ui-state listener sets `enabled` for us)
  await setUiValueFromMain(CLOUD_ENABLED_UI_KEY, 'on')
  try {
    cachedAccount = await drive.fetchAccount(refreshToken)
    lastCloudOkAt = Date.now()
  } catch {
    cachedAccount = null
  }
  await emitState()
  scheduleRound(1_000)
}

export function connectCancel(): void {
  connectSession?.cancel()
  connectSession = null
  firstLinkPending = false
  firstLinkChoice = null
  void emitState()
}

/** re-fetch the Google account info (the card's "Check status" button). */
export async function refreshAccount(): Promise<CloudSyncStatus> {
  const token = await getCloudToken()
  if (token) {
    try {
      cachedAccount = await drive.fetchAccount(token)
      lastCloudOkAt = Date.now()
      lastError = null
      scheduleRound(1_000)
    } catch (error) {
      lastError = error instanceof Error ? error.message : 'Could not reach Google Drive'
    }
  }
  await emitState()
  return currentStatus()
}

export async function disconnect(deleteCloud: boolean): Promise<CloudSyncStatus> {
  const token = await getCloudToken()
  if (token && deleteCloud) await drive.deleteCloudData(token).catch(() => {})
  if (token) await drive.logout(token)
  await clearCloudToken()
  await resetSyncState()
  drive.dropCaches(token)
  cachedAccount = null
  cachedUsage = null
  lastError = null
  firstLinkPending = false
  firstLinkChoice = null
  notifyHook(null)
  await emitState()
  return currentStatus()
}

export async function deleteCloud(): Promise<CloudSyncStatus> {
  const token = await getCloudToken()
  if (token) {
    await drive.deleteCloudData(token)
    await resetSyncState()
    cachedUsage = { usedBytes: 0, itemCount: 0 }
    // turn sync OFF so this machine doesn't immediately re-upload everything
    // and undo the deletion; the user re-enables it to start fresh
    await setUiValueFromMain(CLOUD_ENABLED_UI_KEY, 'off')
    lastError = null
  }
  await emitState()
  return currentStatus()
}

// --- startup / ui-state hook -------------------------------------------------

/** schedule a debounced push after a local change (ui-state key or theme file). */
export function scheduleCloudPush(): void {
  if (!enabled || applying) return
  scheduleRound(PUSH_DEBOUNCE_MS)
}

/** called from the ui-state listener when a shared key changes locally. */
export function onSharedKeyChanged(): void {
  scheduleCloudPush()
}

export function startEngine(initialEnabled: boolean): void {
  enabled = initialEnabled
  if (enabled) scheduleRound(STARTUP_DELAY_MS)
}
