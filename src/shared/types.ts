/** the app's tabs — shared so main (tray) can request a navigation without duplicating the list */
export type Page = 'projects' | 'installs' | 'addons' | 'sync' | 'activity' | 'settings'

export type BuildSource = 'daily' | 'archive' | 'experimental' | 'patch'

export interface RemoteBuild {
  id: string
  source: BuildSource
  version: string
  branch: string
  commit: string
  releaseCycle: string
  fileName: string
  fileSize: number
  fileMtime: number
  url: string
  sha256: string | null
  /** URL of a published .sha256 file when the checksum is not inlined (release archive) */
  checksumUrl?: string | null
}

export interface InstalledBuild {
  id: string
  /** true — installed by the launcher (files are ours); false — located existing install */
  managed: boolean
  version: string
  releaseCycle: string
  branch?: string
  commit?: string
  remoteId?: string
  installedAt: string
  path: string
  executable: string
  sha256?: string
}

/** a Blender minor with live processes among the registered installs */
export interface RunningBlender {
  minor: string
  /** open Blender processes (≈ windows) of this minor */
  count: number
}

export interface BuildsApi {
  listRemote: (refresh?: boolean) => Promise<RemoteBuild[]>
  listInstalled: () => Promise<InstalledBuild[]>
  /** keepExisting skips the automatic retirement of superseded copies ("keep both") */
  install: (buildId: string, keepExisting?: boolean) => Promise<InstalledBuild>
  /** abort a download in flight; no-op once the archive is being extracted */
  cancelInstall: (buildId: string) => Promise<void>
  /** null — dialog cancelled; [] — builds found only inside the installs dir (auto-adopted) */
  locate: () => Promise<InstalledBuild[] | null>
  launch: (installId: string) => Promise<void>
  uninstall: (installId: string) => Promise<void>
  openFolder: (installId: string) => Promise<void>
  /** which of these minors have running Blender processes (best-effort: [] when undetectable) */
  listRunning: (minors: string[]) => Promise<RunningBlender[]>
  /** ask those Blenders to close via the OS close signal — Blender itself prompts about unsaved work */
  requestClose: (minors: string[]) => Promise<void>
  onInstallProgress: (callback: (progress: InstallProgress) => void) => () => void
  getInstallsDir: () => Promise<string>
  getDownloadsDir: () => Promise<string>
  pickInstallsDir: () => Promise<string | null>
  pickDownloadsDir: () => Promise<string | null>
  resetInstallsDir: () => Promise<string>
  resetDownloadsDir: () => Promise<string>
  openInstallsDir: () => Promise<void>
  openDownloadsDir: () => Promise<void>
}

export interface ProjectFolder {
  path: string
  name: string
}

export interface BlendFileInfo {
  path: string
  name: string
  folder: string
  size: number
  mtimeMs: number
  blenderVersion: string | null
  thumbnail: string | null
  hasCustomPreview: boolean
  /** an individually-tracked file that no longer exists on disk */
  missing: boolean
}

export interface NewProjectInput {
  name: string
  installId: string
  folder: string
}

/** result of duplicating a .blend — enough for the renderer to place the new card */
export interface DuplicatedFile {
  path: string
  mtimeMs: number
  size: number
}

export interface ProjectsApi {
  listFolders: () => Promise<ProjectFolder[]>
  addFolder: () => Promise<ProjectFolder[]>
  addFile: () => Promise<string | null>
  pickFolder: () => Promise<string | null>
  removeFolder: (path: string) => Promise<ProjectFolder[]>
  listFiles: () => Promise<BlendFileInfo[]>
  createProject: (input: NewProjectInput) => Promise<string>
  openFile: (path: string, installId: string) => Promise<void>
  reveal: (path: string) => Promise<void>
  renameFile: (path: string, newName: string) => Promise<string>
  duplicateFile: (path: string) => Promise<DuplicatedFile>
  setPreview: (path: string) => Promise<boolean>
  clearPreview: (path: string) => Promise<void>
  moveProject: (path: string) => Promise<string | null>
  findMissing: (path: string) => Promise<string | null>
  removeFromList: (path: string) => Promise<void>
  deleteFile: (path: string) => Promise<void>
}

/**
 * Where an add-on came from:
 * - 'bundled'   — ships with Blender (lives inside the install's scripts folder)
 * - 'user'      — a legacy add-on the user dropped into their config scripts folder
 * - 'extension' — a 4.2+ extension (module id starts with 'bl_ext.'), always user-added
 * - 'core'      — a former add-on that graduated into always-on Blender core (a startup
 *                 operator); no longer listed as an add-on and has no enable/disable toggle
 */
export type AddonOrigin = 'bundled' | 'user' | 'extension' | 'core'

export interface AddonInfo {
  /** the Blender module id: 'foo' (legacy add-on) or 'bl_ext.<repo>.<pkg>' (4.2+ extension) */
  module: string
  /** display name from bl_info; falls back to the module id */
  name: string
  /** add-on's own version, e.g. "1.2.0"; null when bl_info declares none */
  version: string | null
  category: string
  enabled: boolean
  origin: AddonOrigin
  /** for a 'bl_ext.<repo>.<pkg>' module: the <repo> segment (blender_org / user_default / custom repo). null for legacy */
  repoModule?: string | null
  /** for an extension: the <pkg> segment == manifest id == folder name. null for legacy. The stable cross-version join key */
  pkgId?: string | null
  /** bl_info 'id' when a build surfaces one; usually null. Weak secondary match hint only */
  blInfoId?: string | null
  /** bl_info author / extension maintainer; weak corroboration for same-name legacy matches */
  author?: string | null
  /** bl_info 'description', or an extension's manifest 'tagline' — what Blender itself shows */
  description?: string | null
  /** enabled in preferences but its files are gone from disk (direct scan only) */
  missing?: boolean
}

/**
 * Add-ons for one Blender config generation. Blender stores enabled add-ons per
 * major.minor (e.g. 4.2), so several installed patch releases share one entry.
 */
export interface VersionAddons {
  /** the install we actually launched to read this config */
  installId: string
  /** representative full version scanned, e.g. "4.2.1" */
  version: string
  /** config identity — major.minor, e.g. "4.2" */
  minor: string
  releaseCycle: string
  addons: AddonInfo[]
  /** set when scanning this version failed (Blender error / timeout) */
  error?: string
  /** 'direct' — read from config files; 'blender' — reported by a headless Blender run */
  scanMethod?: 'direct' | 'blender'
}

export type AddonScanPhase = 'scanning' | 'done' | 'error'

export interface AddonScanProgress {
  minor: string
  version: string
  index: number
  total: number
  phase: AddonScanPhase
  error?: string
}

/**
 * Everything the Apply button staged, in one request: installs (by source), uninstalls
 * (version switches), and enable/disable toggles. Main validates every field, resolves
 * sources to files itself, then runs ONE headless Blender per affected version.
 */
export interface PlanInstallRequest {
  minor: string
  /** where the file comes from — resolved and re-validated entirely in main */
  kind: 'superhive' | 'blender_org' | 'library' | 'backup'
  /** superhive/blender_org → catalog pkgId; library → stored file id; backup → display id */
  id: string
  /** backup only: the installed module to pack, and the version to pack it from */
  module?: string
  sourceMinor?: string
}

export interface ApplyPlanRequest {
  installs: PlanInstallRequest[]
  uninstalls: AddonUninstallTarget[]
  /** exact module strings as previously reported by that version's scan */
  enable: { minor: string; module: string }[]
  disable: { minor: string; module: string }[]
}

export interface PlanOpResult {
  op: 'install' | 'uninstall' | 'enable' | 'disable'
  minor: string
  /** install → the request's source id; other ops → the module */
  id: string
  status: 'ok' | 'skipped' | 'error'
  detail: string | null
}

export interface ApplyPlanOutcome {
  results: PlanOpResult[]
  /** scan cache with all outcomes folded in (null if nothing scanned) */
  data: VersionAddons[] | null
  /** a backup pack added files to the Library — the renderer should refresh its list */
  libraryChanged: boolean
}

export type AddonApplyPhase = 'applying' | 'done' | 'error'

export interface AddonApplyProgress {
  minor: string
  index: number
  total: number
  phase: AddonApplyPhase
  error?: string
}

export type LibraryAddonFormat = 'extension' | 'legacy'

/** an add-on file stored by the launcher, surviving Blender uninstalls */
export interface LibraryAddon {
  id: string
  format: LibraryAddonFormat
  name: string
  /** extension: manifest id; legacy: top-level python module name */
  moduleId: string
  version: string | null
  /** minimum Blender version from the manifest / bl_info, when declared */
  minBlender: string | null
  /** maximum Blender version (extensions only, EXCLUSIVE) — supports strictly below it */
  maxBlender?: string | null
  fileName: string
  fileSize: number
  sha256: string
  addedAt: string
}

export interface LibraryInstallProgress {
  libraryId: string
  minor: string
  index: number
  total: number
  phase: 'installing' | 'done' | 'error'
  error?: string
}

/** one (version, module) pair to remove from Blender */
export interface AddonUninstallTarget {
  minor: string
  module: string
}

export interface AddonUninstallResult {
  minor: string
  module: string
  status: 'removed' | 'skipped' | 'error'
  detail: string | null
}

export interface AddonUninstallOutcome {
  results: AddonUninstallResult[]
  /** scan cache with the removed add-ons dropped (null if nothing scanned) */
  data: VersionAddons[] | null
}

/** summary of "back up all manually-installed add-ons into the Library" */
export interface CaptureInstalledResult {
  added: number
  /** already stored (by module+version or identical bytes) — left as is */
  skipped: number
  failed: { module: string; minor: string; error: string }[]
}

/** outcome of adding one or more picked add-on files to the Library at once */
export interface LibraryAddResult {
  /** the entries that were stored */
  added: LibraryAddon[]
  /** file names skipped because identical bytes were already stored — not an error */
  skipped: string[]
  /** files that could not be added — e.g. unreadable or not a recognizable add-on */
  failed: { fileName: string; error: string }[]
}

export interface SuperhiveStatus {
  /** an API token is stored */
  connected: boolean
  /** OS secure storage is available — false means a token cannot be saved safely here */
  available: boolean
}

/** an extension listed on a remote repo — a Superhive purchase or a public extensions.blender.org entry */
export interface ExtensionCatalogItem {
  pkgId: string
  name: string
  version: string
  minBlender: string | null
  /** exclusive upper bound — supports strictly below it; null when open-ended */
  maxBlender: string | null
}

export interface AddonsApi {
  /**
   * Read every installed Blender minor's add-on state: direct config read with a
   * per-version headless Blender fallback (the source of truth). Every scan also
   * backs freshly-found installed add-ons up into the Library automatically.
   */
  scan: () => Promise<VersionAddons[]>
  /** last scan result held in memory, or null if nothing scanned this session */
  getCached: () => Promise<VersionAddons[] | null>
  onScanProgress: (callback: (progress: AddonScanProgress) => void) => () => void
  /**
   * apply everything staged in the matrix at once: uninstalls (version switches),
   * installs (sources resolved and downloaded in main), enable/disable toggles.
   * ONE headless Blender run per affected version executes all its operations.
   */
  applyPlan: (plan: ApplyPlanRequest) => Promise<ApplyPlanOutcome>
  onApplyProgress: (callback: (progress: AddonApplyProgress) => void) => () => void
  /** remove user/extension add-ons from the given Blender versions (headless; built-in rejected) */
  uninstall: (targets: AddonUninstallTarget[]) => Promise<AddonUninstallOutcome>
  libraryList: () => Promise<LibraryAddon[]>
  /** pick one or more .zip/.py files in a dialog, parse them and store copies in the library */
  libraryAdd: () => Promise<LibraryAddResult | null>
  libraryRemove: (libraryId: string) => Promise<LibraryAddon[]>
  libraryReveal: (libraryId: string) => Promise<void>
  /** download/pack progress while the plan resolves its install sources */
  onLibraryProgress: (callback: (progress: LibraryInstallProgress) => void) => () => void
  /** the automatic post-scan/apply backup stored new files — re-fetch the library list */
  onLibraryChanged: (callback: () => void) => () => void
  /** where stored add-on files live; changing the folder MOVES the stored files */
  getLibraryDir: () => Promise<string>
  pickLibraryDir: () => Promise<string | null>
  resetLibraryDir: () => Promise<string>
  openLibraryDir: () => Promise<void>
  /** whether a Superhive API token is stored (the token itself never leaves main) */
  superhiveStatus: () => Promise<SuperhiveStatus>
  superhiveConnect: (token: string) => Promise<SuperhiveStatus>
  superhiveDisconnect: () => Promise<SuperhiveStatus>
  /** list the user's purchased Superhive extensions (needs a stored token) */
  superhiveList: () => Promise<ExtensionCatalogItem[]>
  /** list the public extensions.blender.org catalog (no token needed; needs Blender 4.2+ installed) */
  blenderOrgList: () => Promise<ExtensionCatalogItem[]>
}

/**
 * Settings-sync components — what one row of the Sync matrix means on disk.
 * The concrete paths live in main (sync/components.ts); ids travel over IPC.
 */
export const SYNC_COMPONENT_IDS = [
  'preferences',
  'startup',
  'bookmarks',
  'recent',
  'presets',
  'scripts',
  'datafiles'
] as const

export type SyncComponentId = (typeof SYNC_COMPONENT_IDS)[number]

/**
 * Components hidden from the Sync UI for now (recent files churn on every session
 * and syncing them is questionable — parked until it can be done well). Kept in
 * the id type so stored links/baselines/backups mentioning them stay readable.
 */
export const HIDDEN_SYNC_COMPONENT_IDS: readonly SyncComponentId[] = ['recent']

export interface SyncComponentState {
  present: boolean
  bytes: number
  fileCount: number
}

/** one major.minor column of the settings-sync matrix */
export interface SyncVersionColumn {
  minor: string
  /** an installed build exists — only installed versions can be sync targets */
  installed: boolean
  installId: string | null
  /** representative full version (highest installed patch), when installed */
  version: string | null
  releaseCycle: string | null
  /** user files live in a portable dir next to the executable, not the standard location */
  portable: boolean
  /** mtime of config/userpref.blend — the freshest one becomes the default source */
  userprefMtimeMs: number | null
  components: Record<SyncComponentId, SyncComponentState>
}

/**
 * Persistent sync links: which components of which versions follow the source.
 * Stored by main (sync-state.json) so the marks survive Apply and app restarts.
 */
export interface SyncLinks {
  sourceMinor: string | null
  cells: Record<string, SyncComponentId[]>
}

/**
 * How a linked cell relates to the state recorded at its last sync:
 * - 'new'           — linked but never synced yet (no baseline)
 * - 'inSync'        — neither side changed since the last sync
 * - 'sourceChanged' — the source was edited; Apply brings the target up to date
 * - 'targetChanged' — that version was edited directly (its own changes)
 * - 'conflict'      — both sides changed since the last sync
 */
export type SyncCellCondition = 'new' | 'inSync' | 'sourceChanged' | 'targetChanged' | 'conflict'

export interface SyncCellStatus {
  minor: string
  component: SyncComponentId
  condition: SyncCellCondition
  /** one-line summary of what drifted, when it can be told ("3 changes", "2 added, 1 changed") */
  detail: string | null
  /** individual changes, one per line, for the expandable list in the changes panel */
  changes: string[] | null
}

export interface SyncScanResult {
  columns: SyncVersionColumn[]
  links: SyncLinks
  statuses: SyncCellStatus[]
}

/** one sync target: which components to copy into this version (staged per cell, like the add-ons matrix) */
export interface SyncTargetRequest {
  minor: string
  components: SyncComponentId[]
}

/**
 * Sync never changes which add-ons are enabled — that is the Add-ons tab's job.
 * After copying preferences, main always puts the target's own enabled-add-on
 * set back (empty for a version that had no preferences yet).
 */
export interface SettingsSyncRequest {
  sourceMinor: string
  targets: SyncTargetRequest[]
}

export interface SyncOpResult {
  /** the TARGET minor this row is about */
  minor: string
  component: SyncComponentId | 'addons-fixup' | 'backup'
  status: 'ok' | 'skipped' | 'error'
  detail: string | null
}

export interface SettingsSyncOutcome {
  results: SyncOpResult[]
  /** fresh post-operation scan */
  data: SyncScanResult
}

export type SyncApplyPhase = 'backup' | 'copying' | 'fixup' | 'done' | 'error'

export interface SyncApplyProgress {
  minor: string
  index: number
  total: number
  phase: SyncApplyPhase
  error?: string
}

/** a pre-overwrite snapshot of one version's settings, stored by the launcher */
export interface SettingsBackupInfo {
  id: string
  minor: string
  createdAt: string
  /** what was about to overwrite the files: a sync copy or a backup restore */
  reason: 'sync' | 'restore'
  components: SyncComponentId[]
  /** where the sync overwrite came from (sync only) */
  sourceMinor: string | null
  bytes: number
}

export interface SettingsSyncApi {
  /** stat every version's settings components (pure fs — cheap, no Blender launch) */
  scan: () => Promise<SyncScanResult>
  getCached: () => Promise<SyncScanResult | null>
  apply: (request: SettingsSyncRequest) => Promise<SettingsSyncOutcome>
  onApplyProgress: (callback: (progress: SyncApplyProgress) => void) => () => void
  /** persist the sync marks (called on every toggle; marks survive Apply and restarts) */
  setLinks: (links: SyncLinks) => Promise<void>
  /** Record the current state of a cell as its new sync point (used after "Copy into source…"). */
  recordSyncPoint: (minor: string, component: SyncComponentId) => Promise<SyncScanResult>
  listBackups: () => Promise<SettingsBackupInfo[]>
  restoreBackup: (backupId: string) => Promise<SettingsSyncOutcome>
  deleteBackup: (backupId: string) => Promise<SettingsBackupInfo[]>
  revealBackup: (backupId: string) => Promise<void>
}

/**
 * Flat key/value store for renderer display settings (ui-state.json in the data
 * folder). Keys mirror the old localStorage keys so pre-portable profiles carry
 * over; values are short strings ('1'/'0', numbers, language codes).
 */
export interface UiStateApi {
  getAll: () => Promise<Record<string, string>>
  set: (key: string, value: string) => Promise<void>
  /** any window changed a persisted value — fired in every window, writer included */
  onChanged: (callback: (key: string, value: string) => void) => () => void
}

/**
 * A slice of the launcher's portable data folder, for the Settings storage report:
 * - 'installs'  — installed Blender builds (installsDir; the dominant consumer)
 * - 'downloads' — build archives cached before extraction (downloadsDir)
 * - 'library'   — stored add-on files (addon-library dir)
 * - 'backups'   — settings snapshots taken before a sync overwrite
 * - 'other'     — everything else in the data root (config.json, ui-state.json, …)
 */
export type StorageCategory = 'installs' | 'downloads' | 'library' | 'backups' | 'other'

export interface StorageCategoryUsage {
  category: StorageCategory
  /** absolute path measured (may sit outside the data root if the user overrode it) */
  path: string
  bytes: number
  /** the folder does not exist on disk yet (nothing stored) */
  missing: boolean
}

/** one launcher-managed Blender build's on-disk size (drives the installs breakdown) */
export interface StorageInstallUsage {
  id: string
  version: string
  releaseCycle: string
  bytes: number
}

export interface StorageUsage {
  /** the portable data/ root everything is measured against */
  dataRoot: string
  /** sum of every category */
  totalBytes: number
  categories: StorageCategoryUsage[]
  /** per-build sizes of the installs category, largest first */
  installs: StorageInstallUsage[]
}

export interface StorageApi {
  /** measure how much disk each part of the launcher's data folder uses (read-only fs walk) */
  usage: () => Promise<StorageUsage>
}

/** Result of a launcher self-update check against GitHub Releases */
export interface UpdateCheckResult {
  currentVersion: string
  /** newest published release, null when the check failed or none exist yet */
  latestVersion: string | null
  updateAvailable: boolean
  /** release page for the manual-download fallback */
  releaseUrl: string
  /** this build can replace its own exe (Windows portable build only) */
  canSelfUpdate: boolean
  /** a sha256-verified new exe is already staged next to the current one */
  downloaded: boolean
  error?: string
}

export type UpdateDownloadPhase = 'downloading' | 'verifying' | 'ready' | 'error'

export interface UpdateDownloadProgress {
  phase: UpdateDownloadPhase
  receivedBytes?: number
  totalBytes?: number
  error?: string
}

export interface UpdatesApi {
  /** the launcher's own version (package.json) */
  getVersion: () => Promise<string>
  /** cached between calls; refresh=true forces a new probe of GitHub Releases */
  check: (refresh?: boolean) => Promise<UpdateCheckResult>
  /** download the new portable exe next to the current one and verify its sha256 */
  download: () => Promise<UpdateCheckResult>
  onDownloadProgress: (callback: (progress: UpdateDownloadProgress) => void) => () => void
  /** fired after every completed check/download — keeps the sidebar badge in sync */
  onStateChanged: (callback: (state: UpdateCheckResult) => void) => () => void
  /** swap the staged exe into place and relaunch — quits the app */
  installAndRestart: () => Promise<void>
  openReleasePage: () => Promise<void>
}

/** a user-created theme stored as <dataRoot>/themes/<id>.json (see shared/theme.ts) */
export interface UserThemeFile {
  id: string
  name: string
  /** raw key/value map from the file; consumers sanitize via sanitizeThemeColors */
  colors: Record<string, string>
}

export interface ThemesApi {
  list: () => Promise<UserThemeFile[]>
  save: (id: string, name: string, colors: Record<string, string>) => Promise<void>
  remove: (id: string) => Promise<void>
  openDir: () => Promise<void>
  /** floating window with just the theme editor, for live-tweaking colors */
  openEditorWindow: () => Promise<void>
}

/** requests originating from native OS chrome outside the page (currently: the tray menu) */
export interface TrayApi {
  /** the tray's page shortcuts (Projects/Installs/…) ask the open window to switch tabs */
  onNavigate: (callback: (page: Page) => void) => () => void
}

/** host OS, narrowed to the three targets the launcher ships for */
export type LauncherPlatform = 'win32' | 'darwin' | 'linux'

export interface LauncherApi {
  /** static, not a call: the page needs it during its first render (window chrome layout) */
  platform: LauncherPlatform
  builds: BuildsApi
  projects: ProjectsApi
  addons: AddonsApi
  settingsSync: SettingsSyncApi
  storage: StorageApi
  uiState: UiStateApi
  updates: UpdatesApi
  themes: ThemesApi
  tray: TrayApi
}

export type InstallPhase =
  | 'downloading'
  | 'verifying'
  | 'extracting'
  | 'finalizing'
  | 'done'
  | 'error'
  | 'cancelled'
  // renderer-only: shown while an uninstall's trashItem call is in flight
  | 'removing'

export interface InstallProgress {
  buildId: string
  phase: InstallPhase
  receivedBytes?: number
  totalBytes?: number
  error?: string
  /** 'done' only: older same-branch rolling builds (alpha/beta/daily/…) auto-trashed to make room */
  replaced?: { version: string; commit?: string }[]
}
