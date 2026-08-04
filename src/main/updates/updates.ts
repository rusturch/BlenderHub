import { spawn } from 'child_process'
import { createHash } from 'crypto'
import { createReadStream, existsSync } from 'fs'
import { mkdir, readdir, rm } from 'fs/promises'
import { dirname, join } from 'path'
import { pipeline } from 'stream/promises'
import { app } from 'electron'
import { downloadToFile, fetchExpectedChecksum, throttle } from '../download'
import { getRuntimeRoot, isWritableDir } from '../paths'
import {
  isNewerVersion,
  releasePageUrl,
  releasesLatestUrl,
  updateAssetUrl,
  updateZipName,
  versionFromLatestRedirect
} from '../../shared/launcher-updates'
import type { UpdateCheckResult, UpdateDownloadProgress } from '../../shared/types'

// Application Security Requirement: updates come only from the launcher's own
// public GitHub releases over https — the anonymous release probe + direct asset
// URLs. The final download host is checked against the allowlist and the archive
// is verified against the published sha256 before it ever replaces anything.
const TRUSTED_UPDATE_HOSTS = new Set([
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com'
])

const CHECK_TTL_MS = 60 * 60 * 1000
// failed checks retry much sooner — a launch while briefly offline must not pin
// "check failed" (and suppress the sidebar badge) for a whole hour
const ERROR_RETRY_TTL_MS = 5 * 60 * 1000

interface LatestRelease {
  tag: string
  version: string
}

interface CheckCacheEntry {
  fetchedAt: number
  latest: LatestRelease | null
  error?: string
}

let cached: CheckCacheEntry | null = null
let checkInFlight: Promise<CheckCacheEntry> | null = null
// set only after the downloaded archive's sha256 matched the published one this session
let staged: { version: string; sha256: string; exeName: string } | null = null
let downloadInFlight = false

/**
 * The folder the running app can replace: the directory of its own exe. Only
 * the Windows folder (zip) build self-updates — packaged, not the legacy
 * portable stub (PORTABLE_EXECUTABLE_FILE means the exe runs from a temp
 * unpack dir and the swap would target the wrong place), and the folder must
 * be writable (Program Files is not).
 */
let cachedUpdateDir: string | null | undefined
function selfUpdateDir(): string | null {
  if (cachedUpdateDir === undefined) {
    const appDir = dirname(process.execPath)
    cachedUpdateDir =
      process.platform === 'win32' &&
      app.isPackaged &&
      !process.env['PORTABLE_EXECUTABLE_FILE'] &&
      isWritableDir(appDir)
        ? appDir
        : null
  }
  return cachedUpdateDir
}

// The download and the unpacked copy live in the per-machine runtime dir, never
// next to the app: the app folder may sit in a cloud-synced directory, and a
// 300MB archive plus staging would only churn the sync. The swap-time backup is
// the exception — it sits INSIDE the app folder so that moving the old files
// aside is a same-volume rename: instant and atomic, with no partially-moved
// trees for the rollback to misread.
const updateWorkDir = (): string => join(getRuntimeRoot(), 'update')
const zipPath = (): string => join(updateWorkDir(), updateZipName())
const stagedDir = (): string => join(updateWorkDir(), 'staged')
const BACKUP_DIR_NAME = '.update-backup'

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

async function sha256OfFile(path: string): Promise<string> {
  const hash = createHash('sha256')
  await pipeline(createReadStream(path), hash)
  return hash.digest('hex')
}

async function fetchLatestRelease(): Promise<LatestRelease> {
  // the redirect trick avoids the 60-req/hour anonymous API limit
  const response = await fetch(releasesLatestUrl(), { redirect: 'manual' })
  const location = response.headers.get('location')
  const parsed = location ? versionFromLatestRedirect(location) : null
  if (!parsed) {
    throw new Error(
      location
        ? `The latest release has a tag the updater cannot parse (${location.split('/').pop()})`
        : `No published release found (HTTP ${response.status})`
    )
  }
  return { tag: parsed.tag, version: parsed.version }
}

function buildResult(): UpdateCheckResult {
  const currentVersion = app.getVersion()
  const latest = cached?.latest ?? null
  return {
    currentVersion,
    latestVersion: latest?.version ?? null,
    updateAvailable: latest !== null && isNewerVersion(currentVersion, latest.version),
    releaseUrl: releasePageUrl(latest?.tag),
    canSelfUpdate: selfUpdateDir() !== null,
    downloaded: latest !== null && staged?.version === latest.version,
    ...(cached?.error ? { error: cached.error } : {})
  }
}

export function getReleasePageUrl(): string {
  return releasePageUrl(cached?.latest?.tag)
}

export async function checkForUpdate(refresh: boolean): Promise<UpdateCheckResult> {
  const ttl = cached?.error ? ERROR_RETRY_TTL_MS : CHECK_TTL_MS
  if (refresh || !cached || Date.now() - cached.fetchedAt > ttl) {
    checkInFlight ??= fetchLatestRelease()
      .then((latest) => ({ fetchedAt: Date.now(), latest }))
      .catch((error) => ({
        fetchedAt: Date.now(),
        // keep the last successfully seen release: a staged, sha256-verified
        // update must stay installable while the network is down
        latest: cached?.latest ?? null,
        error: error instanceof Error ? error.message : String(error)
      }))
      .finally(() => {
        checkInFlight = null
      })
    cached = await checkInFlight
  }
  return buildResult()
}

/** Windows' bundled bsdtar reads zip natively, but only when it actually wins
 * the PATH lookup — a Git-for-Windows shell puts GNU tar (no zip support)
 * first, so the system copy is addressed absolutely. */
function systemTar(): string {
  const system32 = join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'tar.exe')
  return existsSync(system32) ? system32 : 'tar'
}

/**
 * Unpack the verified archive into a clean staging dir and return the launcher
 * exe name found inside.
 */
async function extractStaged(): Promise<string> {
  const target = stagedDir()
  await rm(target, { recursive: true, force: true })
  await mkdir(target, { recursive: true })
  await new Promise<void>((resolve, reject) => {
    const tar = spawn(systemTar(), ['-xf', zipPath(), '-C', target], {
      stdio: ['ignore', 'ignore', 'pipe'],
      windowsHide: true
    })
    let stderr = ''
    tar.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })
    tar.on('error', reject)
    tar.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`Could not unpack the update${stderr ? `: ${stderr.trim()}` : ''}`))
    })
  })
  const entries = await readdir(target, { withFileTypes: true })
  const exe = entries.find((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.exe'))
  if (!exe) throw new Error('The update archive has no launcher executable inside')
  return exe.name
}

export async function downloadUpdate(
  onProgress: (progress: UpdateDownloadProgress) => void
): Promise<UpdateCheckResult> {
  if (!selfUpdateDir()) throw new Error('Self-update works only in the Windows folder build')
  const state = await checkForUpdate(false)
  const latest = cached?.latest
  if (!latest || !state.updateAvailable) throw new Error('No update to download — check for updates first')
  if (downloadInFlight) throw new Error('The update is already downloading')
  downloadInFlight = true
  try {
    const fileName = updateZipName()
    const zipUrl = updateAssetUrl(latest.tag, fileName)

    const expected = await fetchExpectedChecksum(`${zipUrl}.sha256`, fileName, TRUSTED_UPDATE_HOSTS)
    if (!expected) throw new Error('No published checksum for this release — refusing to update')

    await mkdir(updateWorkDir(), { recursive: true })
    // a previous session may have left a fully downloaded archive — re-verify, skip the download
    const reusable = existsSync(zipPath()) && (await sha256OfFile(zipPath())) === expected
    if (!reusable) {
      onProgress({ phase: 'downloading', receivedBytes: 0 })
      const onBytes = throttle((received: number, total?: number) => {
        onProgress({ phase: 'downloading', receivedBytes: received, totalBytes: total })
      }, 200)
      const actual = await downloadToFile(zipUrl, zipPath(), onBytes, TRUSTED_UPDATE_HOSTS)
      onProgress({ phase: 'verifying' })
      if (actual !== expected) {
        await rm(zipPath(), { force: true })
        throw new Error('Checksum mismatch — the downloaded update is corrupted or tampered with')
      }
    }
    onProgress({ phase: 'extracting' })
    const exeName = await extractStaged()
    staged = { version: latest.version, sha256: expected, exeName }
    onProgress({ phase: 'ready' })
    return buildResult()
  } finally {
    downloadInFlight = false
  }
}

export interface SwapScriptParams {
  /** the folder the running exe lives in — the swap target */
  appDir: string
  /** unpacked new version (its top-level entries define what gets replaced) */
  stagedDir: string
  /** where the old files move during the swap, for rollback (same volume as appDir) */
  backupDir: string
  /** the downloaded archive, deleted after a successful swap */
  zipPath: string
  /** launcher exe name inside stagedDir, relaunched when the swap settles */
  exeName: string
  /** the app process to wait out before touching anything */
  waitPid: number
  /** retry/wait tuning — overridden only by tests */
  attempts?: number
  retryDelayMs?: number
  waitTimeoutSec?: number
}

/**
 * The swap must happen AFTER the app exits — the running exe and its loaded
 * DLLs cannot be replaced. A detached PowerShell waits for the process, moves
 * the old files aside, copies the staged ones in, rolls everything back on
 * failure, then relaunches. Only top-level entries present in the staged dir
 * are touched: data/ (and anything else the user keeps next to the exe) is
 * never part of the archive, so it is never moved, overwritten or deleted.
 *
 * Ordering invariant: the exe moves out FIRST and lands LAST (and the rollback
 * restores it last) — mid-swap there is never a launchable exe next to a
 * half-written tree, so an impatient double-click fails cleanly instead of
 * booting a mixed version, and an app that did boot from this folder proves
 * the copy phase completed (cleanupAfterUpdate relies on exactly that).
 *
 * Every copy/remove attempt starts from a verified-clean destination:
 * Copy-Item/Move-Item into an existing directory NESTS the tree instead of
 * merging (empirically confirmed), so a retry after a partial copy would
 * otherwise "succeed" into resources\resources and report a healthy swap.
 *
 * Exported for the sandbox harness — the script must stay pure text.
 */
export function buildSwapScript(params: SwapScriptParams): string {
  const attempts = params.attempts ?? 60
  const retryDelay = params.retryDelayMs ?? 500
  const waitTimeout = params.waitTimeoutSec ?? 300
  const quote = (value: string): string => `'${value.replace(/'/g, "''")}'`
  return [
    `$ErrorActionPreference = 'SilentlyContinue'`,
    `$app = ${quote(params.appDir)}`,
    `$staged = ${quote(params.stagedDir)}`,
    `$backup = ${quote(params.backupDir)}`,
    `$zip = ${quote(params.zipPath)}`,
    `$exeLeaf = ${quote(params.exeName)}`,
    `$exe = Join-Path $app $exeLeaf`,
    `try { Wait-Process -Id ${params.waitPid} -Timeout ${waitTimeout} } catch {}`,
    // the app never exited (hung quit, AV freeze): abort without touching
    // anything — the user still has a running launcher, the download stays
    `if (Get-Process -Id ${params.waitPid} -ErrorAction SilentlyContinue) { exit 1 }`,
    // retries: AV scanners and cloud-sync clients can hold freshly written or
    // just-released files for seconds
    `function RemoveRetry($path) {`,
    `  for ($i = 0; $i -lt ${attempts}; $i++) {`,
    `    try { if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Recurse -Force -ErrorAction Stop } } catch {}`,
    `    if (-not (Test-Path -LiteralPath $path)) { return $true }`,
    `    Start-Sleep -Milliseconds ${retryDelay}`,
    `  }`,
    `  return $false`,
    `}`,
    `function MoveRetry($from, $to) {`,
    `  for ($i = 0; $i -lt ${attempts}; $i++) {`,
    `    try { Move-Item -LiteralPath $from -Destination $to -Force -ErrorAction Stop; return $true } catch { Start-Sleep -Milliseconds ${retryDelay} }`,
    `  }`,
    `  return $false`,
    `}`,
    `function CopyRetry($from, $to) {`,
    `  for ($i = 0; $i -lt ${attempts}; $i++) {`,
    `    try {`,
    `      if (Test-Path -LiteralPath $to) { Remove-Item -LiteralPath $to -Recurse -Force -ErrorAction Stop }`,
    `      Copy-Item -LiteralPath $from -Destination $to -Recurse -Force -ErrorAction Stop`,
    `      return $true`,
    `    } catch { Start-Sleep -Milliseconds ${retryDelay} }`,
    `  }`,
    `  return $false`,
    `}`,
    `$entries = Get-ChildItem -LiteralPath $staged -Force | ForEach-Object { $_.Name }`,
    // every failure branch must relaunch: the app already quit, and a helper
    // that gives up silently would leave the user with a vanished launcher
    `if (-not $entries) { Start-Process -FilePath $exe; exit 1 }`,
    `$moveOrder = @($exeLeaf) + @($entries | Where-Object { $_ -ne $exeLeaf })`,
    `$copyOrder = @($entries | Where-Object { $_ -ne $exeLeaf }) + @($exeLeaf)`,
    `if (-not (RemoveRetry $backup)) { Start-Process -FilePath $exe; exit 1 }`,
    `[void](New-Item -ItemType Directory -Path $backup -Force)`,
    `$moved = @()`,
    `$failed = $false`,
    `foreach ($name in $moveOrder) {`,
    `  $src = Join-Path $app $name`,
    `  if (Test-Path -LiteralPath $src) {`,
    `    if (MoveRetry $src (Join-Path $backup $name)) { $moved += $name } else { $failed = $true; break }`,
    `  }`,
    `}`,
    `if (-not $failed) {`,
    `  foreach ($name in $copyOrder) {`,
    `    if (-not (CopyRetry (Join-Path $staged $name) (Join-Path $app $name))) { $failed = $true; break }`,
    `  }`,
    `}`,
    `if ($failed) {`,
    // roll back in reverse: the exe returns last, so a launchable exe again
    // implies the rest of the rollback landed; a destination that cannot be
    // cleared keeps its backup copy instead of nesting into the leftovers
    `  [array]::Reverse($moved)`,
    `  foreach ($name in $moved) {`,
    `    $dest = Join-Path $app $name`,
    `    if (RemoveRetry $dest) { [void](MoveRetry (Join-Path $backup $name) $dest) }`,
    `  }`,
    `  if (-not (Get-ChildItem -LiteralPath $backup -Force)) { Remove-Item -LiteralPath $backup -Force }`,
    `  Start-Process -FilePath $exe`,
    `  exit 1`,
    `}`,
    `Start-Process -FilePath $exe`,
    `Remove-Item -LiteralPath $staged -Recurse -Force`,
    `Remove-Item -LiteralPath $backup -Recurse -Force`,
    `Remove-Item -LiteralPath $zip -Force`
  ].join('\n')
}

function spawnSwapHelper(script: string): void {
  // Launch via `cmd /c start`, NOT a direct spawn of powershell.exe: a directly
  // detached powershell child is created but never actually runs its script here
  // (verified on a real build — spawn succeeds, nothing happens); `start` fully
  // detaches it so it survives the imminent app.quit() and completes the swap.
  // -EncodedCommand sidesteps both argument quoting and script execution policy.
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  spawn(
    'cmd.exe',
    ['/c', 'start', '', '/b', 'powershell.exe', '-NoProfile', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded],
    { detached: true, stdio: 'ignore', windowsHide: true }
  ).unref()
}

let installInFlight = false

export async function installUpdateAndRestart(): Promise<void> {
  const appDir = selfUpdateDir()
  if (!appDir) throw new Error('Self-update works only in the Windows folder build')
  if (installInFlight) throw new Error('The update is already being installed')
  installInFlight = true
  try {
    const latest = cached?.latest
    if (!latest || staged?.version !== latest.version) {
      throw new Error('No verified update staged — download it first')
    }
    // the downloaded archive sat on disk unattended — make sure it is still the verified bytes
    if (!existsSync(zipPath()) || (await sha256OfFile(zipPath())) !== staged.sha256) {
      staged = null
      throw new Error('The staged update changed on disk — download it again')
    }
    // re-extract right before the swap: this pins the staging dir's bytes to the
    // archive that was just re-verified, no matter how long it sat in temp
    const exeName = await extractStaged()

    spawnSwapHelper(
      buildSwapScript({
        appDir,
        stagedDir: stagedDir(),
        backupDir: join(appDir, BACKUP_DIR_NAME),
        zipPath: zipPath(),
        exeName,
        waitPid: process.pid
      })
    )
  } catch (error) {
    installInFlight = false
    throw error
  }
  app.quit()
}

/** Clear leftovers of past updates (best-effort). Deleting the swap backup here
 * is sound because of the swap script's ordering invariant: the exe is copied
 * last, so the fact that this build is running from the app folder proves the
 * copy phase completed — the backup is not needed anymore. (A swap killed
 * mid-way leaves no exe, the app cannot boot, and the backup survives for
 * manual recovery.) The downloaded archive stays — it lets a "download now,
 * restart later" session resume without re-downloading. */
export function cleanupAfterUpdate(): void {
  if (process.platform !== 'win32' || !app.isPackaged) return
  const appDir = dirname(process.execPath)
  void (async () => {
    await rm(stagedDir(), { recursive: true, force: true }).catch(() => {})
    // the helper may still be finishing its own cleanup right behind us — retry
    for (const leftover of [
      join(appDir, BACKUP_DIR_NAME),
      // legacy single-exe portable leftovers (releases ≤0.3.x)
      join(appDir, 'BlenderHub.exe.update'),
      join(appDir, 'BlenderHub.exe.old')
    ]) {
      if (!existsSync(leftover)) continue
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          await rm(leftover, { recursive: true, force: true })
          break
        } catch {
          await delay(2000)
        }
      }
    }
  })()
}
