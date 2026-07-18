import { spawn } from 'child_process'
import { existsSync } from 'fs'
import { mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from 'fs/promises'
import { shell } from 'electron'
import { basename, join, resolve } from 'path'
import { getDataRoot } from '../paths'
import { readConfig, updateConfig } from '../config'
import { downloadToFile, fetchExpectedChecksum, throttle } from '../download'
import { assertTrustedSource } from './builds-api'
import { detectBlenderAt, listLocated, mapLimit, removeLocated } from './locate'
import { compareVersionsDesc, isReleasedCycle, STABLE_CYCLES } from '../../shared/blender-builds'
import { minorOf } from '../../shared/blender-archive'
import type { InstalledBuild, InstallProgress, RemoteBuild } from '../../shared/types'

const META_FILE = 'launcher-meta.json'

const defaultInstallsDir = (): string => join(getDataRoot(), 'installs')
const defaultDownloadsDir = (): string => join(getDataRoot(), 'downloads')

const installsDir = async (): Promise<string> => (await readConfig()).installsDir || defaultInstallsDir()
const downloadsDir = async (): Promise<string> => (await readConfig()).downloadsDir || defaultDownloadsDir()

export async function getInstallsDir(): Promise<string> {
  return installsDir()
}

export async function getDownloadsDir(): Promise<string> {
  return downloadsDir()
}

export async function setInstallsDir(path: string): Promise<string> {
  await updateConfig((config) => ({ ...config, installsDir: path }))
  return path
}

export async function setDownloadsDir(path: string): Promise<string> {
  await updateConfig((config) => ({ ...config, downloadsDir: path }))
  return path
}

export async function resetInstallsDir(): Promise<string> {
  await updateConfig((config) => ({ ...config, installsDir: undefined }))
  return defaultInstallsDir()
}

export async function resetDownloadsDir(): Promise<string> {
  await updateConfig((config) => ({ ...config, downloadsDir: undefined }))
  return defaultDownloadsDir()
}

function executableRelativePath(): string {
  if (process.platform === 'win32') return 'blender.exe'
  if (process.platform === 'darwin') return join('Blender.app', 'Contents', 'MacOS', 'Blender')
  return 'blender'
}

interface InstallMeta {
  remoteId?: string
  version: string
  releaseCycle: string
  branch?: string
  commit?: string
  installedAt: string
  sourceUrl?: string
  sha256?: string
  executableRelative: string
  /** found in the installs folder without meta (copied by hand) and adopted */
  adopted?: boolean
}

// builds copied into the installs folder by hand (or synced from another machine)
// get adopted on the next listing: detect once via --version, persist launcher meta
const adoptFailedAt = new Map<string, number>()
const ADOPT_RETRY_MS = 5 * 60 * 1000
const adoptionsInFlight = new Map<string, Promise<InstalledBuild | null>>()

function adoptUnmanagedDir(path: string, id: string): Promise<InstalledBuild | null> {
  const inFlight = adoptionsInFlight.get(path)
  if (inFlight) return inFlight
  const failedAt = adoptFailedAt.get(path)
  if (failedAt !== undefined && Date.now() - failedAt < ADOPT_RETRY_MS) return Promise.resolve(null)
  const run = (async (): Promise<InstalledBuild | null> => {
    try {
      const detected = await detectBlenderAt(path)
      if (!detected) return null
      const meta: InstallMeta = {
        version: detected.version,
        releaseCycle: detected.releaseCycle,
        branch: detected.branch,
        commit: detected.commit,
        installedAt: new Date().toISOString(),
        executableRelative: detected.executableRelative,
        adopted: true
      }
      await writeFile(join(path, META_FILE), JSON.stringify(meta, null, 2))
      adoptFailedAt.delete(path)
      return {
        id,
        managed: true,
        version: meta.version,
        releaseCycle: meta.releaseCycle,
        branch: meta.branch,
        commit: meta.commit,
        installedAt: meta.installedAt,
        path,
        executable: join(path, meta.executableRelative)
      }
    } catch {
      adoptFailedAt.set(path, Date.now())
      return null
    } finally {
      adoptionsInFlight.delete(path)
    }
  })()
  adoptionsInFlight.set(path, run)
  return run
}

async function listManaged(): Promise<InstalledBuild[]> {
  const root = await installsDir()
  await mkdir(root, { recursive: true })
  const result: InstalledBuild[] = []
  const unmanaged: { path: string; id: string }[] = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue
    const path = join(root, entry.name)
    try {
      const meta = JSON.parse(await readFile(join(path, META_FILE), 'utf8')) as InstallMeta
      const executable = join(path, meta.executableRelative)
      await stat(executable)
      result.push({
        id: entry.name,
        managed: true,
        version: meta.version,
        releaseCycle: meta.releaseCycle,
        branch: meta.branch,
        commit: meta.commit,
        remoteId: meta.remoteId,
        installedAt: meta.installedAt,
        sha256: meta.sha256,
        path,
        executable
      })
    } catch {
      // no (or broken) launcher meta — try to adopt it below
      unmanaged.push({ path, id: entry.name })
    }
  }
  const adopted = await mapLimit(unmanaged, 4, (dir) => adoptUnmanagedDir(dir.path, dir.id))
  result.push(...adopted.filter((build): build is InstalledBuild => build !== null))
  return result
}

export async function listInstalled(): Promise<InstalledBuild[]> {
  const [managed, located] = await Promise.all([listManaged(), listLocated()])
  // a build that was located earlier and later adopted must not show up twice
  const managedPaths = new Set(managed.map((build) => resolve(build.path)))
  const uniqueLocated = located.filter((build) => !managedPaths.has(resolve(build.path)))
  return [...managed, ...uniqueLocated].sort(
    (a, b) => compareVersionsDesc(a.version, b.version) || b.installedAt.localeCompare(a.installedAt)
  )
}

export async function findInstalled(installId: string): Promise<InstalledBuild> {
  const build = (await listInstalled()).find((candidate) => candidate.id === installId)
  if (!build) throw new Error('Build not found — refresh the list')
  return build
}

function extractArchive(archivePath: string, destination: string): Promise<void> {
  // system bsdtar/GNU tar handles both .zip (Windows) and .tar.xz (Linux/macOS)
  return new Promise((resolve, reject) => {
    const tar = spawn('tar', ['-xf', archivePath, '-C', destination], {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true
    })
    let stderr = ''
    tar.stderr.on('data', (chunk) => {
      stderr += chunk
    })
    tar.on('error', reject)
    tar.on('close', (code) =>
      code === 0
        ? resolve()
        : reject(new Error(`Archive extraction failed (tar exited with ${code}): ${stderr.slice(0, 300)}`))
    )
  })
}

// A fresh install retires the builds it supersedes (the row the UI showed with an
// Update button): every other managed dir of the same branch — rolling builds move
// commit by commit and the old one vanishes from the catalog anyway — plus stable-cycle
// dirs of the same minor with a lower version (patch releases). Trashed, not rm'd:
// same recoverable disposal as a manual uninstall. Keeps one live build per line.
// A released build also retires the candidate that previewed its exact version;
// a candidate/rc never retires a released copy (see the guard below).
export async function replaceSupersededBuilds(
  installsRoot: string,
  justInstalledDir: string,
  build: RemoteBuild
): Promise<{ version: string; commit?: string }[]> {
  const stablePatch = STABLE_CYCLES.has(build.releaseCycle)
  if (!build.branch && !stablePatch) return []
  const removed: { version: string; commit?: string }[] = []
  for (const entry of await readdir(installsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || entry.name === justInstalledDir) continue
    const path = join(installsRoot, entry.name)
    let meta: InstallMeta
    try {
      meta = JSON.parse(await readFile(join(path, META_FILE), 'utf8')) as InstallMeta
    } catch {
      continue // no (or broken) meta — not ours to touch here, adoption handles it
    }
    // one-way street between cycles: installing a candidate/rc must never retire a
    // released copy — the stable stays put until the released next patch arrives
    if (!isReleasedCycle(build.releaseCycle) && isReleasedCycle(meta.releaseCycle)) continue
    // branch alone is not enough: archive releases carry a branch but no commit,
    // and a commitless match must never retire anything newer (downgrades) —
    // only true rolling pairs (commit on both sides) replace by branch
    const sameBranch =
      Boolean(build.branch) && Boolean(build.commit) && Boolean(meta.commit) && meta.branch === build.branch
    const cmp = compareVersionsDesc(meta.version, build.version)
    const olderPatch =
      stablePatch &&
      STABLE_CYCLES.has(meta.releaseCycle) &&
      minorOf(meta.version) === minorOf(build.version) &&
      // strictly older, or the candidate preview of the exact version being released
      (cmp > 0 || (cmp === 0 && isReleasedCycle(build.releaseCycle) && !isReleasedCycle(meta.releaseCycle)))
    if (!sameBranch && !olderPatch) continue
    try {
      await shell.trashItem(path)
      removed.push({ version: meta.version, commit: meta.commit })
    } catch {
      // best-effort — a locked folder (Blender still running from it) just stays
    }
  }
  return removed
}

export async function installBuild(
  build: RemoteBuild,
  onProgress: (progress: InstallProgress) => void,
  keepExisting = false
): Promise<InstalledBuild> {
  assertTrustedSource(build.url)
  if (build.checksumUrl) assertTrustedSource(build.checksumUrl)
  if (build.fileName.endsWith('.dmg')) {
    throw new Error('macOS .dmg installs are not supported yet')
  }

  const dirName = build.fileName.replace(/\.(zip|tar\.xz|tar\.gz)$/i, '')
  if (dirName === build.fileName || dirName !== basename(dirName) || dirName.includes('..')) {
    throw new Error(`Unexpected archive name: ${build.fileName}`)
  }
  const [installsRoot, downloadsRoot] = await Promise.all([installsDir(), downloadsDir()])
  const finalDir = join(installsRoot, dirName)
  if (existsSync(finalDir)) throw new Error('This build is already installed')

  await mkdir(installsRoot, { recursive: true })
  await mkdir(downloadsRoot, { recursive: true })
  const archivePath = join(downloadsRoot, build.fileName)
  const report = (patch: Omit<InstallProgress, 'buildId'>): void => onProgress({ buildId: build.id, ...patch })

  try {
    report({ phase: 'downloading', receivedBytes: 0, totalBytes: build.fileSize })
    const onBytes = throttle((received: number, total?: number) => {
      report({ phase: 'downloading', receivedBytes: received, totalBytes: total ?? build.fileSize })
    }, 200)
    const actualSha256 = await downloadToFile(build.url, archivePath, onBytes)

    report({ phase: 'verifying' })
    const expectedSha256 =
      build.sha256 ??
      (await fetchExpectedChecksum(build.checksumUrl ?? `${build.url}.sha256`, build.fileName))
    if (!expectedSha256) throw new Error('No published checksum for this build — refusing to install')
    if (expectedSha256 !== actualSha256) {
      throw new Error('Checksum mismatch — the downloaded archive is corrupted or tampered with')
    }

    report({ phase: 'extracting' })
    const stagingDir = await mkdtemp(join(installsRoot, '.staging-'))
    try {
      await extractArchive(archivePath, stagingDir)
      const entries = (await readdir(stagingDir, { withFileTypes: true })).filter((e) => !e.name.startsWith('.'))
      const contentDir = entries.length === 1 && entries[0].isDirectory() ? join(stagingDir, entries[0].name) : stagingDir

      report({ phase: 'finalizing' })
      const executableRelative = executableRelativePath()
      try {
        await stat(join(contentDir, executableRelative))
      } catch {
        throw new Error('The archive does not look like a Blender build (executable not found)')
      }
      const meta: InstallMeta = {
        remoteId: build.id,
        version: build.version,
        releaseCycle: build.releaseCycle,
        branch: build.branch,
        commit: build.commit,
        installedAt: new Date().toISOString(),
        sourceUrl: build.url,
        sha256: actualSha256,
        executableRelative
      }
      await writeFile(join(contentDir, META_FILE), JSON.stringify(meta, null, 2))
      await rename(contentDir, finalDir)
      // "keep both": the user explicitly chose to leave superseded copies in place
      const replaced = keepExisting ? [] : await replaceSupersededBuilds(installsRoot, dirName, build)
      report({ phase: 'done', ...(replaced.length > 0 ? { replaced } : {}) })
      return {
        id: dirName,
        managed: true,
        version: meta.version,
        releaseCycle: meta.releaseCycle,
        branch: meta.branch,
        commit: meta.commit,
        remoteId: meta.remoteId,
        installedAt: meta.installedAt,
        sha256: meta.sha256,
        path: finalDir,
        executable: join(finalDir, executableRelative)
      }
    } finally {
      await rm(stagingDir, { recursive: true, force: true })
    }
  } finally {
    await rm(archivePath, { force: true })
  }
}

export async function launchInstalled(installId: string): Promise<void> {
  const build = await findInstalled(installId)
  const child = spawn(build.executable, [], { cwd: build.path, detached: true, stdio: 'ignore' })
  child.unref()
}

export async function uninstallBuild(installId: string): Promise<void> {
  const build = await findInstalled(installId)
  if (build.managed) {
    // user-initiated uninstall goes to the OS trash, not an unrecoverable rm
    if (existsSync(build.path)) await shell.trashItem(build.path)
  } else {
    // located installs are not ours to delete — just forget them
    await removeLocated(build.path)
  }
}
