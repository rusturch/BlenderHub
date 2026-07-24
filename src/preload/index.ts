import { contextBridge, ipcRenderer } from 'electron'
import type {
  AddonApplyProgress,
  AddonScanProgress,
  AddonUninstallOutcome,
  AddonUninstallTarget,
  ApplyPlanOutcome,
  ApplyPlanRequest,
  BlendFileInfo,
  ExtensionCatalogItem,
  InstalledBuild,
  InstallProgress,
  LauncherApi,
  LauncherPlatform,
  LibraryAddon,
  LibraryAddResult,
  LibraryInstallProgress,
  DuplicatedFile,
  NewProjectInput,
  Page,
  ProjectFolder,
  RemoteBuild,
  RunningBlender,
  SettingsBackupInfo,
  SettingsSyncOutcome,
  SettingsSyncRequest,
  StorageUsage,
  SuperhiveStatus,
  SyncApplyProgress,
  SyncComponentId,
  SyncLinks,
  SyncScanResult,
  UpdateCheckResult,
  UpdateDownloadProgress,
  UserThemeFile,
  VersionAddons
} from '../shared/types'

// Application Security Requirement: the page gets only this narrow, typed API —
// no raw ipcRenderer passthrough — so it can talk to exactly these channels and
// nothing else. The preload has zero runtime deps and runs under the OS sandbox.
// process.platform is one of the few Node globals a sandboxed preload keeps
function hostPlatform(): LauncherPlatform {
  if (process.platform === 'win32') return 'win32'
  if (process.platform === 'darwin') return 'darwin'
  return 'linux'
}

const api: LauncherApi = {
  platform: hostPlatform(),
  builds: {
    listRemote: (refresh = false): Promise<RemoteBuild[]> => ipcRenderer.invoke('builds:list-remote', refresh),
    listInstalled: (): Promise<InstalledBuild[]> => ipcRenderer.invoke('builds:list-installed'),
    install: (buildId: string, keepExisting = false): Promise<InstalledBuild> =>
      ipcRenderer.invoke('builds:install', buildId, keepExisting),
    cancelInstall: (buildId: string): Promise<void> => ipcRenderer.invoke('builds:cancel-install', buildId),
    locate: (): Promise<InstalledBuild[] | null> => ipcRenderer.invoke('builds:locate'),
    launch: (installId: string): Promise<void> => ipcRenderer.invoke('builds:launch', installId),
    uninstall: (installId: string): Promise<void> => ipcRenderer.invoke('builds:uninstall', installId),
    openFolder: (installId: string): Promise<void> => ipcRenderer.invoke('builds:open-folder', installId),
    listRunning: (minors: string[]): Promise<RunningBlender[]> => ipcRenderer.invoke('builds:list-running', minors),
    requestClose: (minors: string[]): Promise<void> => ipcRenderer.invoke('builds:request-close', minors),
    onInstallProgress: (callback: (progress: InstallProgress) => void): (() => void) => {
      const listener = (_event: unknown, progress: InstallProgress): void => callback(progress)
      ipcRenderer.on('builds:install-progress', listener)
      return () => {
        ipcRenderer.removeListener('builds:install-progress', listener)
      }
    },
    getInstallsDir: (): Promise<string> => ipcRenderer.invoke('builds:get-installs-dir'),
    getDownloadsDir: (): Promise<string> => ipcRenderer.invoke('builds:get-downloads-dir'),
    pickInstallsDir: (): Promise<string | null> => ipcRenderer.invoke('builds:pick-installs-dir'),
    pickDownloadsDir: (): Promise<string | null> => ipcRenderer.invoke('builds:pick-downloads-dir'),
    resetInstallsDir: (): Promise<string> => ipcRenderer.invoke('builds:reset-installs-dir'),
    resetDownloadsDir: (): Promise<string> => ipcRenderer.invoke('builds:reset-downloads-dir'),
    openInstallsDir: (): Promise<void> => ipcRenderer.invoke('builds:open-installs-dir'),
    openDownloadsDir: (): Promise<void> => ipcRenderer.invoke('builds:open-downloads-dir')
  },
  projects: {
    listFolders: (): Promise<ProjectFolder[]> => ipcRenderer.invoke('projects:list-folders'),
    addFolder: (): Promise<ProjectFolder[]> => ipcRenderer.invoke('projects:add-folder'),
    addFile: (): Promise<string | null> => ipcRenderer.invoke('projects:add-file'),
    pickFolder: (): Promise<string | null> => ipcRenderer.invoke('projects:pick-folder'),
    removeFolder: (path: string): Promise<ProjectFolder[]> =>
      ipcRenderer.invoke('projects:remove-folder', path),
    listFiles: (): Promise<BlendFileInfo[]> => ipcRenderer.invoke('projects:list-files'),
    createProject: (input: NewProjectInput): Promise<string> =>
      ipcRenderer.invoke('projects:create', input),
    openFile: (path: string, installId: string): Promise<void> =>
      ipcRenderer.invoke('projects:open-file', path, installId),
    reveal: (path: string): Promise<void> => ipcRenderer.invoke('projects:reveal', path),
    renameFile: (path: string, newName: string): Promise<string> =>
      ipcRenderer.invoke('projects:rename-file', path, newName),
    duplicateFile: (path: string): Promise<DuplicatedFile> =>
      ipcRenderer.invoke('projects:duplicate-file', path),
    setPreview: (path: string): Promise<boolean> => ipcRenderer.invoke('projects:set-preview', path),
    clearPreview: (path: string): Promise<void> => ipcRenderer.invoke('projects:clear-preview', path),
    moveProject: (path: string): Promise<string | null> => ipcRenderer.invoke('projects:move', path),
    findMissing: (path: string): Promise<string | null> =>
      ipcRenderer.invoke('projects:find-missing', path),
    removeFromList: (path: string): Promise<void> =>
      ipcRenderer.invoke('projects:remove-from-list', path),
    deleteFile: (path: string): Promise<void> => ipcRenderer.invoke('projects:delete-file', path)
  },
  addons: {
    scan: (): Promise<VersionAddons[]> => ipcRenderer.invoke('addons:scan'),
    getCached: (): Promise<VersionAddons[] | null> => ipcRenderer.invoke('addons:get-cached'),
    onScanProgress: (callback: (progress: AddonScanProgress) => void): (() => void) => {
      const listener = (_event: unknown, progress: AddonScanProgress): void => callback(progress)
      ipcRenderer.on('addons:scan-progress', listener)
      return () => {
        ipcRenderer.removeListener('addons:scan-progress', listener)
      }
    },
    applyPlan: (plan: ApplyPlanRequest): Promise<ApplyPlanOutcome> =>
      ipcRenderer.invoke('addons:apply-plan', plan),
    onApplyProgress: (callback: (progress: AddonApplyProgress) => void): (() => void) => {
      const listener = (_event: unknown, progress: AddonApplyProgress): void => callback(progress)
      ipcRenderer.on('addons:apply-progress', listener)
      return () => {
        ipcRenderer.removeListener('addons:apply-progress', listener)
      }
    },
    uninstall: (targets: AddonUninstallTarget[]): Promise<AddonUninstallOutcome> =>
      ipcRenderer.invoke('addons:uninstall', targets),
    libraryList: (): Promise<LibraryAddon[]> => ipcRenderer.invoke('addons:library-list'),
    libraryAdd: (): Promise<LibraryAddResult | null> => ipcRenderer.invoke('addons:library-add'),
    libraryRemove: (libraryId: string): Promise<LibraryAddon[]> =>
      ipcRenderer.invoke('addons:library-remove', libraryId),
    libraryReveal: (libraryId: string): Promise<void> =>
      ipcRenderer.invoke('addons:library-reveal', libraryId),
    onLibraryChanged: (callback: () => void): (() => void) => {
      const listener = (): void => callback()
      ipcRenderer.on('addons:library-changed', listener)
      return () => {
        ipcRenderer.removeListener('addons:library-changed', listener)
      }
    },
    onLibraryProgress: (callback: (progress: LibraryInstallProgress) => void): (() => void) => {
      const listener = (_event: unknown, progress: LibraryInstallProgress): void => callback(progress)
      ipcRenderer.on('addons:library-progress', listener)
      return () => {
        ipcRenderer.removeListener('addons:library-progress', listener)
      }
    },
    getLibraryDir: (): Promise<string> => ipcRenderer.invoke('addons:get-library-dir'),
    pickLibraryDir: (): Promise<string | null> => ipcRenderer.invoke('addons:pick-library-dir'),
    resetLibraryDir: (): Promise<string> => ipcRenderer.invoke('addons:reset-library-dir'),
    openLibraryDir: (): Promise<void> => ipcRenderer.invoke('addons:open-library-dir'),
    superhiveStatus: (): Promise<SuperhiveStatus> => ipcRenderer.invoke('superhive:status'),
    superhiveConnect: (token: string): Promise<SuperhiveStatus> =>
      ipcRenderer.invoke('superhive:connect', token),
    superhiveDisconnect: (): Promise<SuperhiveStatus> => ipcRenderer.invoke('superhive:disconnect'),
    superhiveList: (): Promise<ExtensionCatalogItem[]> => ipcRenderer.invoke('superhive:list'),
    blenderOrgList: (): Promise<ExtensionCatalogItem[]> => ipcRenderer.invoke('addons:blender-org-list')
  },
  settingsSync: {
    scan: (): Promise<SyncScanResult> => ipcRenderer.invoke('sync:scan'),
    getCached: (): Promise<SyncScanResult | null> => ipcRenderer.invoke('sync:get-cached'),
    apply: (request: SettingsSyncRequest): Promise<SettingsSyncOutcome> =>
      ipcRenderer.invoke('sync:apply', request),
    onApplyProgress: (callback: (progress: SyncApplyProgress) => void): (() => void) => {
      const listener = (_event: unknown, progress: SyncApplyProgress): void => callback(progress)
      ipcRenderer.on('sync:apply-progress', listener)
      return () => {
        ipcRenderer.removeListener('sync:apply-progress', listener)
      }
    },
    setLinks: (links: SyncLinks): Promise<void> => ipcRenderer.invoke('sync:set-links', links),
    recordSyncPoint: (minor: string, component: SyncComponentId): Promise<SyncScanResult> =>
      ipcRenderer.invoke('sync:record-sync-point', minor, component),
    listBackups: (): Promise<SettingsBackupInfo[]> => ipcRenderer.invoke('sync:list-backups'),
    restoreBackup: (backupId: string): Promise<SettingsSyncOutcome> =>
      ipcRenderer.invoke('sync:restore-backup', backupId),
    deleteBackup: (backupId: string): Promise<SettingsBackupInfo[]> =>
      ipcRenderer.invoke('sync:delete-backup', backupId),
    revealBackup: (backupId: string): Promise<void> => ipcRenderer.invoke('sync:reveal-backup', backupId)
  },
  storage: {
    usage: (): Promise<StorageUsage> => ipcRenderer.invoke('storage:usage')
  },
  uiState: {
    getAll: (): Promise<Record<string, string>> => ipcRenderer.invoke('ui:get-state'),
    set: (key: string, value: string): Promise<void> => ipcRenderer.invoke('ui:set-state', key, value),
    onChanged: (callback: (key: string, value: string) => void): (() => void) => {
      const listener = (_event: unknown, key: string, value: string): void => callback(key, value)
      ipcRenderer.on('ui:state-changed', listener)
      return () => {
        ipcRenderer.removeListener('ui:state-changed', listener)
      }
    }
  },
  updates: {
    getVersion: (): Promise<string> => ipcRenderer.invoke('updates:get-version'),
    check: (refresh = false): Promise<UpdateCheckResult> => ipcRenderer.invoke('updates:check', refresh),
    download: (): Promise<UpdateCheckResult> => ipcRenderer.invoke('updates:download'),
    onDownloadProgress: (callback: (progress: UpdateDownloadProgress) => void): (() => void) => {
      const listener = (_event: unknown, progress: UpdateDownloadProgress): void => callback(progress)
      ipcRenderer.on('updates:download-progress', listener)
      return () => {
        ipcRenderer.removeListener('updates:download-progress', listener)
      }
    },
    onStateChanged: (callback: (state: UpdateCheckResult) => void): (() => void) => {
      const listener = (_event: unknown, state: UpdateCheckResult): void => callback(state)
      ipcRenderer.on('updates:state', listener)
      return () => {
        ipcRenderer.removeListener('updates:state', listener)
      }
    },
    installAndRestart: (): Promise<void> => ipcRenderer.invoke('updates:install-restart'),
    openReleasePage: (): Promise<void> => ipcRenderer.invoke('updates:open-release-page')
  },
  themes: {
    list: (): Promise<UserThemeFile[]> => ipcRenderer.invoke('themes:list'),
    save: (id: string, name: string, colors: Record<string, string>): Promise<void> =>
      ipcRenderer.invoke('themes:save', id, name, colors),
    remove: (id: string): Promise<void> => ipcRenderer.invoke('themes:delete', id),
    openDir: (): Promise<void> => ipcRenderer.invoke('themes:open-dir'),
    openEditorWindow: (): Promise<void> => ipcRenderer.invoke('themes:open-editor')
  },
  tray: {
    onNavigate: (callback: (page: Page) => void): (() => void) => {
      const listener = (_event: unknown, page: Page): void => callback(page)
      ipcRenderer.on('tray:navigate', listener)
      return () => {
        ipcRenderer.removeListener('tray:navigate', listener)
      }
    }
  }
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('api', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore (defined in index.d.ts)
  window.api = api
}
