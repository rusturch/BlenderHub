import { mkdir, readFile, rename, writeFile } from 'fs/promises'
import { join } from 'path'
import { getDataRoot } from './paths'
import type { LibraryAddon } from '../shared/types'

export interface LocatedInstall {
  path: string
  executableRelative: string
  version: string
  releaseCycle: string
  branch?: string
  commit?: string
  addedAt: string
}

export interface LauncherConfig {
  projectFolders: string[]
  projectFiles: string[]
  /** folder-scanned .blend files seen in a previous scan — used to detect vanished files */
  knownFiles: string[]
  locatedInstalls: LocatedInstall[]
  /** override for where Blender versions get installed; unset — a data-root default is used */
  installsDir?: string
  /** override for where build archives are downloaded before extraction */
  downloadsDir?: string
  /** the user's add-on library; files live under <dataRoot>/addon-library/<id>/ */
  addonLibrary: LibraryAddon[]
  /** override for where library add-on files are stored; unset — <dataRoot>/addon-library */
  addonLibraryDir?: string
  /** Superhive API token, encrypted with OS safeStorage (base64). Never plaintext */
  superhiveTokenEnc?: string
  /** resolved project file path → epoch ms of last "Open" via the launcher (tray's Recent Projects) */
  recentlyOpened: Record<string, number>
}

const configPath = (): string => join(getDataRoot(), 'config.json')

const emptyConfig = (): LauncherConfig => ({
  projectFolders: [],
  projectFiles: [],
  knownFiles: [],
  locatedInstalls: [],
  addonLibrary: [],
  recentlyOpened: {}
})

export async function readConfig(): Promise<LauncherConfig> {
  let text: string
  try {
    text = await readFile(configPath(), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return emptyConfig()
    // a transient lock (antivirus scan etc.) must fail loudly: falling back to
    // defaults here would let the next write wipe the real config
    throw error
  }
  let parsed: Partial<LauncherConfig>
  try {
    parsed = JSON.parse(text) as Partial<LauncherConfig>
  } catch {
    // keep the evidence instead of silently discarding a user's config
    await rename(configPath(), `${configPath()}.corrupt-${Date.now()}`).catch(() => {})
    return emptyConfig()
  }
  return {
    // spread the raw file first: fields written by a NEWER app version must
    // survive a read-modify-write by this one (the data folder is portable and
    // may be opened by launchers of different versions)
    ...(parsed as Record<string, unknown>),
    projectFolders: Array.isArray(parsed.projectFolders) ? parsed.projectFolders : [],
    projectFiles: Array.isArray(parsed.projectFiles) ? parsed.projectFiles : [],
    knownFiles: Array.isArray(parsed.knownFiles) ? parsed.knownFiles : [],
    locatedInstalls: Array.isArray(parsed.locatedInstalls) ? parsed.locatedInstalls : [],
    installsDir: typeof parsed.installsDir === 'string' ? parsed.installsDir : undefined,
    downloadsDir: typeof parsed.downloadsDir === 'string' ? parsed.downloadsDir : undefined,
    addonLibrary: Array.isArray(parsed.addonLibrary) ? parsed.addonLibrary : [],
    addonLibraryDir: typeof parsed.addonLibraryDir === 'string' ? parsed.addonLibraryDir : undefined,
    superhiveTokenEnc:
      typeof parsed.superhiveTokenEnc === 'string' ? parsed.superhiveTokenEnc : undefined,
    recentlyOpened:
      parsed.recentlyOpened && typeof parsed.recentlyOpened === 'object' ? parsed.recentlyOpened : {}
  }
}

// updates are serialized and written atomically (tmp + rename), so concurrent
// callers cannot interleave read-modify-write and a crash never truncates the file
let writeQueue: Promise<unknown> = Promise.resolve()

export function updateConfig(
  patch: (config: LauncherConfig) => LauncherConfig
): Promise<LauncherConfig> {
  const run = writeQueue.then(async () => {
    const next = patch(await readConfig())
    await mkdir(getDataRoot(), { recursive: true })
    const target = configPath()
    await writeFile(`${target}.tmp`, JSON.stringify(next, null, 2))
    await rename(`${target}.tmp`, target)
    return next
  })
  writeQueue = run.catch(() => {})
  return run
}
