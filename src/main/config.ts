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

/** Enough of a file's stat to recognise it again after it moves elsewhere on disk. */
export interface FileIdentity {
  size: number
  mtimeMs: number
  /** filesystem file index and volume; a move inside one volume keeps both (0 if unknown) */
  ino: number
  dev: number
}

export interface LauncherConfig {
  projectFolders: string[]
  projectFiles: string[]
  /** folder-scanned .blend files seen in a previous scan — used to detect vanished files */
  knownFiles: string[]
  /** resolved path → what that file looked like, so a file moved outside the launcher
   *  is recognised at its new place instead of counting as missing plus a newcomer */
  fileIdentities: Record<string, FileIdentity>
  /** folders shown in the tree while they hold no .blend — created here, or just emptied */
  keptFolders: string[]
  /** starred folders, offered as quick filters above the project grid */
  favoriteFolders: string[]
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

function sanitizeIdentities(raw: unknown): Record<string, FileIdentity> {
  if (!raw || typeof raw !== 'object') return {}
  const result: Record<string, FileIdentity> = {}
  for (const [path, value] of Object.entries(raw as Record<string, unknown>)) {
    const entry = value as Partial<FileIdentity> | null
    if (!entry || typeof entry !== 'object') continue
    if (typeof entry.size !== 'number' || typeof entry.mtimeMs !== 'number') continue
    result[path] = {
      size: entry.size,
      mtimeMs: entry.mtimeMs,
      ino: typeof entry.ino === 'number' ? entry.ino : 0,
      dev: typeof entry.dev === 'number' ? entry.dev : 0
    }
  }
  return result
}

const emptyConfig = (): LauncherConfig => ({
  projectFolders: [],
  projectFiles: [],
  knownFiles: [],
  fileIdentities: {},
  keptFolders: [],
  favoriteFolders: [],
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
    fileIdentities: sanitizeIdentities(parsed.fileIdentities),
    keptFolders: Array.isArray(parsed.keptFolders) ? parsed.keptFolders : [],
    favoriteFolders: Array.isArray(parsed.favoriteFolders) ? parsed.favoriteFolders : [],
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
    const current = await readConfig()
    const next = patch(current)
    // a patch that changed nothing returns the config it was handed; every scan does
    // that, and rewriting the file each time is churn for nothing
    if (next === current) return next
    await mkdir(getDataRoot(), { recursive: true })
    const target = configPath()
    await writeFile(`${target}.tmp`, JSON.stringify(next, null, 2))
    await rename(`${target}.tmp`, target)
    return next
  })
  writeQueue = run.catch(() => {})
  return run
}
