import {
  latestPatchPerMinor,
  minorOf,
  parseArchiveFolderBuilds,
  parseReleaseFolders
} from '../../../shared/blender-archive'
import { compareVersionsDesc, mapBuilderEntries } from '../../../shared/blender-builds'
import type { BuilderApiEntry } from '../../../shared/blender-builds'
import { releasesLatestUrl } from '../../../shared/launcher-updates'
import type { LauncherApi, RemoteBuild, StorageCategory } from '../../../shared/types'

const DESKTOP_ONLY = 'This action works only in the desktop app window'
const ALL_ARCHITECTURES = ['amd64', 'x86_64', 'arm64']

function detectPlatform(): string {
  const ua = navigator.platform.toLowerCase()
  return ua.includes('win') ? 'windows' : ua.includes('mac') ? 'darwin' : 'linux'
}

async function fetchBuilderCategoryViaProxy(
  category: 'daily' | 'experimental' | 'patch',
  platform: string
): Promise<RemoteBuild[]> {
  const response = await fetch(`/blender-api/${category}?format=json&v=2`, {
    headers: { accept: 'application/json' }
  })
  if (!response.ok) throw new Error(`builder.blender.org responded with HTTP ${response.status}`)
  const entries = (await response.json()) as BuilderApiEntry[]
  const source = category === 'daily' ? 'daily' : category === 'patch' ? 'patch' : 'experimental'
  return mapBuilderEntries(entries, platform, ALL_ARCHITECTURES, source)
}

async function fetchArchiveViaProxy(platform: string): Promise<RemoteBuild[]> {
  const rootResponse = await fetch('/blender-api/release/')
  if (!rootResponse.ok) throw new Error(`download.blender.org responded with HTTP ${rootResponse.status}`)
  const folders = parseReleaseFolders(await rootResponse.text())
  const perFolder = await Promise.all(
    folders.map(async (folder) => {
      try {
        const response = await fetch(`/blender-api/release/${folder}/`)
        if (!response.ok) return []
        const canonicalUrl = `https://download.blender.org/release/${folder}/`
        return parseArchiveFolderBuilds(folder, canonicalUrl, await response.text(), platform, ALL_ARCHITECTURES)
      } catch {
        return []
      }
    })
  )
  return latestPatchPerMinor(perFolder.flat())
}

// Read-only stand-in for the preload API when the UI runs in a plain browser
// (vite dev server opened directly — no Electron preload, so window.api is
// absent). Builds are fetched through the vite proxy.
function createPreviewFallbackApi(): LauncherApi {
  const builds: LauncherApi['builds'] = {
    async listRemote() {
      const platform = detectPlatform()
      const [dailyResult, experimentalResult, patchResult, archiveResult] = await Promise.allSettled([
        fetchBuilderCategoryViaProxy('daily', platform),
        fetchBuilderCategoryViaProxy('experimental', platform),
        fetchBuilderCategoryViaProxy('patch', platform),
        fetchArchiveViaProxy(platform)
      ])
      if (dailyResult.status === 'rejected' && archiveResult.status === 'rejected') {
        throw dailyResult.reason
      }
      const daily = dailyResult.status === 'fulfilled' ? dailyResult.value : []
      const experimental = experimentalResult.status === 'fulfilled' ? experimentalResult.value : []
      const patch = patchResult.status === 'fulfilled' ? patchResult.value : []
      const archive = archiveResult.status === 'fulfilled' ? archiveResult.value : []
      const dailyMinors = new Set(daily.map((build) => minorOf(build.version)))
      const archiveOnly = archive.filter((build) => !dailyMinors.has(minorOf(build.version)))
      return [...daily, ...experimental, ...patch, ...archiveOnly].sort(
        (a, b) => compareVersionsDesc(a.version, b.version) || b.fileMtime - a.fileMtime
      )
    },
    listInstalled: async () => [],
    install: async () => {
      throw new Error(DESKTOP_ONLY)
    },
    locate: async () => {
      throw new Error(DESKTOP_ONLY)
    },
    launch: async () => {
      throw new Error(DESKTOP_ONLY)
    },
    uninstall: async () => {
      throw new Error(DESKTOP_ONLY)
    },
    openFolder: async () => {
      throw new Error(DESKTOP_ONLY)
    },
    listRunning: async () => [],
    requestClose: async () => {
      throw new Error(DESKTOP_ONLY)
    },
    onInstallProgress: () => () => {},
    getInstallsDir: async () => {
      throw new Error(DESKTOP_ONLY)
    },
    getDownloadsDir: async () => {
      throw new Error(DESKTOP_ONLY)
    },
    pickInstallsDir: async () => {
      throw new Error(DESKTOP_ONLY)
    },
    pickDownloadsDir: async () => {
      throw new Error(DESKTOP_ONLY)
    },
    resetInstallsDir: async () => {
      throw new Error(DESKTOP_ONLY)
    },
    resetDownloadsDir: async () => {
      throw new Error(DESKTOP_ONLY)
    },
    openInstallsDir: async () => {
      throw new Error(DESKTOP_ONLY)
    },
    openDownloadsDir: async () => {
      throw new Error(DESKTOP_ONLY)
    }
  }
  const projects: LauncherApi['projects'] = {
    listFolders: async () => [],
    addFolder: async () => {
      throw new Error(DESKTOP_ONLY)
    },
    addFile: async () => {
      throw new Error(DESKTOP_ONLY)
    },
    pickFolder: async () => {
      throw new Error(DESKTOP_ONLY)
    },
    removeFolder: async () => {
      throw new Error(DESKTOP_ONLY)
    },
    listFiles: async () => [],
    createProject: async () => {
      throw new Error(DESKTOP_ONLY)
    },
    openFile: async () => {
      throw new Error(DESKTOP_ONLY)
    },
    reveal: async () => {
      throw new Error(DESKTOP_ONLY)
    },
    setDisplayName: async () => {
      throw new Error(DESKTOP_ONLY)
    },
    setPreview: async () => {
      throw new Error(DESKTOP_ONLY)
    },
    clearPreview: async () => {
      throw new Error(DESKTOP_ONLY)
    },
    moveProject: async () => {
      throw new Error(DESKTOP_ONLY)
    },
    findMissing: async () => {
      throw new Error(DESKTOP_ONLY)
    },
    removeFromList: async () => {
      throw new Error(DESKTOP_ONLY)
    },
    deleteFile: async () => {
      throw new Error(DESKTOP_ONLY)
    }
  }
  const addons: LauncherApi['addons'] = {
    scan: async () => {
      throw new Error(DESKTOP_ONLY)
    },
    getCached: async () => null,
    onScanProgress: () => () => {},
    applyPlan: async () => {
      throw new Error(DESKTOP_ONLY)
    },
    onApplyProgress: () => () => {},
    uninstall: async () => {
      throw new Error(DESKTOP_ONLY)
    },
    libraryList: async () => [],
    libraryAdd: async () => {
      throw new Error(DESKTOP_ONLY)
    },
    libraryRemove: async () => {
      throw new Error(DESKTOP_ONLY)
    },
    libraryReveal: async () => {
      throw new Error(DESKTOP_ONLY)
    },
    onLibraryChanged: () => () => {},
    onLibraryProgress: () => () => {},
    getLibraryDir: async () => '',
    pickLibraryDir: async () => null,
    resetLibraryDir: async () => {
      throw new Error(DESKTOP_ONLY)
    },
    openLibraryDir: async () => {
      throw new Error(DESKTOP_ONLY)
    },
    superhiveStatus: async () => ({ connected: false, available: false }),
    superhiveConnect: async () => {
      throw new Error(DESKTOP_ONLY)
    },
    superhiveDisconnect: async () => {
      throw new Error(DESKTOP_ONLY)
    },
    superhiveList: async () => [],
    blenderOrgList: async () => []
  }
  const settingsSync: LauncherApi['settingsSync'] = {
    scan: async () => {
      throw new Error(DESKTOP_ONLY)
    },
    getCached: async () => null,
    apply: async () => {
      throw new Error(DESKTOP_ONLY)
    },
    onApplyProgress: () => () => {},
    setLinks: async () => {},
    recordSyncPoint: async () => {
      throw new Error(DESKTOP_ONLY)
    },
    listBackups: async () => [],
    restoreBackup: async () => {
      throw new Error(DESKTOP_ONLY)
    },
    deleteBackup: async () => {
      throw new Error(DESKTOP_ONLY)
    },
    revealBackup: async () => {
      throw new Error(DESKTOP_ONLY)
    }
  }
  const storage: LauncherApi['storage'] = {
    // no data folder in the browser preview — report an empty breakdown so the
    // Settings storage section still renders (all zeros) instead of erroring
    usage: async () => ({
      dataRoot: '',
      totalBytes: 0,
      categories: (['installs', 'downloads', 'library', 'backups', 'other'] as StorageCategory[]).map(
        (category) => ({ category, path: '', bytes: 0, missing: true })
      ),
      installs: []
    })
  }
  const updates: LauncherApi['updates'] = {
    getVersion: async () => '',
    // benign "never checked" result so the Settings section renders quietly
    check: async () => ({
      currentVersion: '',
      latestVersion: null,
      updateAvailable: false,
      releaseUrl: releasesLatestUrl(),
      canSelfUpdate: false,
      downloaded: false
    }),
    download: async () => {
      throw new Error(DESKTOP_ONLY)
    },
    onDownloadProgress: () => () => {},
    onStateChanged: () => () => {},
    installAndRestart: async () => {
      throw new Error(DESKTOP_ONLY)
    },
    openReleasePage: async () => {
      window.open(releasesLatestUrl(), '_blank', 'noopener')
    }
  }
  const uiState: LauncherApi['uiState'] = {
    // the preview has no data folder — plain localStorage keeps settings sticky
    getAll: async () => {
      const state: Record<string, string> = {}
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i)
        if (key) state[key] = localStorage.getItem(key) ?? ''
      }
      return state
    },
    set: async (key, value) => {
      localStorage.setItem(key, value)
    }
  }
  const tray: LauncherApi['tray'] = {
    // the browser preview has no native tray — nothing ever fires
    onNavigate: () => () => {}
  }
  return { builds, projects, addons, settingsSync, storage, uiState, updates, tray }
}

let fallbackApi: LauncherApi | null = null

export function getLauncherApi(): { api: LauncherApi; isDesktop: boolean } {
  const isDesktop = typeof window.api !== 'undefined'
  if (isDesktop) return { api: window.api, isDesktop }
  fallbackApi ??= createPreviewFallbackApi()
  return { api: fallbackApi, isDesktop }
}
