// Cloud Sync scope + wire types, shared between main (engine) and the Settings page.
// The whitelist here is the single source of truth for WHICH ui-state keys leave
// this machine. Rule of thumb when adding a ui key: is it a preference (shared) or
// does it name a path / machine-local resource (excluded)?

/** ui-state key families that are pure preferences and sync as a group. */
const SHARED_UI_PREFIXES = ['notify.', 'projects.', 'installs.', 'addons.', 'sync.'] as const

/** individually shared ui-state keys outside the prefix families. */
const SHARED_UI_KEYS: ReadonlySet<string> = new Set([
  'launcher.language',
  'launcher.theme',
  'launcher.themeColors',
  'launcher.themeDirty',
  'launcher.assetLibrary',
  'sidebar.collapsed',
  'window.closeBehavior',
  'window.minimizeBehavior',
  'tray.pages'
])

/**
 * Keys that match a shared prefix but must NOT sync — they name an absolute path
 * or a per-machine resource. Excluded keys always lose to this set.
 */
const EXCLUDED_UI_KEYS: ReadonlySet<string> = new Set(['projects.lastProjectFolder'])

/**
 * Machine-local by design and never synced: window/tray promotion state, autostart
 * (executed per machine), and the cloud toggle itself (syncing it would sync the act
 * of enabling sync). These simply belong to no shared family — listed for the reader.
 */
export const CLOUD_ENABLED_UI_KEY = 'cloud.enabled'

export function isSharedUiKey(key: string): boolean {
  if (EXCLUDED_UI_KEYS.has(key)) return false
  if (SHARED_UI_KEYS.has(key)) return true
  return SHARED_UI_PREFIXES.some((prefix) => key.startsWith(prefix))
}

/** project the full ui-state down to the shared subset, key order made canonical. */
export function sharedUiSubset(state: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const key of Object.keys(state).sort()) {
    if (isSharedUiKey(key)) out[key] = state[key]!
  }
  return out
}

// --- item ids ----------------------------------------------------------------

export const UI_STATE_ITEM_ID = 'ui-state'
export const LIBRARY_ITEM_ID = 'addon-library'
export const THEME_ITEM_PREFIX = 'theme:'

export const themeItemId = (themeId: string): string => `${THEME_ITEM_PREFIX}${themeId}`
export const isThemeItemId = (itemId: string): boolean => itemId.startsWith(THEME_ITEM_PREFIX)
export const themeIdFromItemId = (itemId: string): string => itemId.slice(THEME_ITEM_PREFIX.length)

/**
 * Closed vocabulary of item ids — MUST mirror the backend's ITEM_ID_RE. The
 * client validates every server-supplied manifest id against this before it
 * ever reaches a filesystem path: a manifest is untrusted input, and an id like
 * `theme:../../secrets` would otherwise traverse out of the themes folder.
 */
export const ITEM_ID_RE = /^(ui-state|addon-library|theme:[a-z0-9][a-z0-9_-]{0,63})$/

export const isSyncItemId = (itemId: string): boolean => ITEM_ID_RE.test(itemId)

/** hard cap on manifest entries the client will process (server allows 50). */
export const MANIFEST_MAX_ITEMS = 100

// --- wire types --------------------------------------------------------------

export const BUNDLE_SCHEMA = 1

/** envelope body stored per item; the server treats `payload` as opaque. */
export interface SyncEnvelope {
  bundleSchema: number
  itemId: string
  payloadFormat: string
  parentGeneration: number
  deviceId: string
  updatedAt: number
  sha256: string
  deleted: boolean
  encryption: 'none'
  payload: unknown
}

export interface ManifestItem {
  itemId: string
  generation: number
  sha256: string
  size: number
  updatedAt: number
}

export interface SyncManifest {
  /** random id stamped on the cloud copy; changes when "delete cloud data" wipes it */
  dataEpoch: string
  items: ManifestItem[]
}

// --- synced add-on library -------------------------------------------------------

/** hard cap per stored add-on archive — mirrors the install-side archive cap. */
export const MAX_LIBRARY_BLOB_BYTES = 512 * 1024 * 1024
export const MAX_LIBRARY_ENTRIES = 500

const LIBRARY_ID_RE = /^[0-9a-f]{12}$/
const SHA256_RE = /^[0-9a-f]{64}$/
// display file names land in a filesystem path — no separators, no traversal,
// no Windows-reserved punctuation, no leading dot (hides files on unix)
const FILE_NAME_RE = /^[^\\/:*?"<>|\u0000-\u001f.][^\\/:*?"<>|\u0000-\u001f]{0,159}$/

const optionalShortString = (value: unknown, max: number): string | null =>
  typeof value === 'string' && value.length > 0 ? value.slice(0, max) : null

/**
 * A pulled library index is untrusted input. Entries are content-addressed:
 * `id` must be the first 12 hex chars of `sha256` (that's how the library mints
 * ids), which pins every entry to the exact file bytes it describes.
 */
export function sanitizeLibraryEntries(raw: unknown): import('./types').LibraryAddon[] {
  if (!Array.isArray(raw)) return []
  const byId = new Map<string, import('./types').LibraryAddon>()
  for (const candidate of raw) {
    if (byId.size >= MAX_LIBRARY_ENTRIES) break
    const record = candidate as Record<string, unknown> | null
    if (!record || typeof record !== 'object') continue
    const id = record.id
    const sha256 = record.sha256
    const fileName = record.fileName
    if (typeof id !== 'string' || !LIBRARY_ID_RE.test(id)) continue
    if (typeof sha256 !== 'string' || !SHA256_RE.test(sha256) || !sha256.startsWith(id)) continue
    if (typeof fileName !== 'string' || !FILE_NAME_RE.test(fileName) || fileName.includes('..')) continue
    if (record.format !== 'legacy' && record.format !== 'extension') continue
    const fileSize = typeof record.fileSize === 'number' ? record.fileSize : NaN
    if (!Number.isInteger(fileSize) || fileSize <= 0 || fileSize > MAX_LIBRARY_BLOB_BYTES) continue
    byId.set(id, {
      id,
      format: record.format,
      name: optionalShortString(record.name, 200) ?? id,
      moduleId: optionalShortString(record.moduleId, 120) ?? id,
      version: optionalShortString(record.version, 32),
      minBlender: optionalShortString(record.minBlender, 16),
      maxBlender: optionalShortString(record.maxBlender, 16),
      fileName,
      fileSize,
      sha256,
      addedAt: optionalShortString(record.addedAt, 40) ?? ''
    })
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id))
}

/** stable stringify (sorted keys) so equal content always hashes identically. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortDeep(value))
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortDeep((value as Record<string, unknown>)[key])
    }
    return out
  }
  return value
}
