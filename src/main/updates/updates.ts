import { spawn } from 'child_process'
import { createHash } from 'crypto'
import { createReadStream, existsSync } from 'fs'
import { rm } from 'fs/promises'
import { pipeline } from 'stream/promises'
import { app } from 'electron'
import { downloadToFile, fetchExpectedChecksum, throttle } from '../download'
import {
  isNewerVersion,
  portableExeName,
  releasePageUrl,
  releasesLatestUrl,
  updateAssetUrl,
  versionFromLatestRedirect
} from '../../shared/launcher-updates'
import type { UpdateCheckResult, UpdateDownloadProgress } from '../../shared/types'

// Application Security Requirement: updates come only from the launcher's own
// public GitHub releases over https — the anonymous release probe + direct asset
// URLs. The final download host is checked against the allowlist and the exe is
// verified against the published sha256 before it ever replaces anything.
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
// set only after the staged file's sha256 matched the published one this session
let staged: { version: string; sha256: string } | null = null
let downloadInFlight = false

/**
 * The path of the exe the user actually launched. Only the Windows portable
 * build can swap itself: process.execPath points at the temp-unpacked copy,
 * while this env var (set by the electron-builder portable stub) is the real file.
 */
function portableExePath(): string | null {
  if (process.platform !== 'win32') return null
  return process.env['PORTABLE_EXECUTABLE_FILE'] ?? null
}

const stagedPathFor = (exePath: string): string => `${exePath}.update`
const oldPathFor = (exePath: string): string => `${exePath}.old`

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
    canSelfUpdate: portableExePath() !== null,
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

export async function downloadUpdate(
  onProgress: (progress: UpdateDownloadProgress) => void
): Promise<UpdateCheckResult> {
  const exePath = portableExePath()
  if (!exePath) throw new Error('Self-update works only in the portable Windows build')
  const state = await checkForUpdate(false)
  const latest = cached?.latest
  if (!latest || !state.updateAvailable) throw new Error('No update to download — check for updates first')
  if (downloadInFlight) throw new Error('The update is already downloading')
  downloadInFlight = true
  try {
    const fileName = portableExeName()
    const stagedPath = stagedPathFor(exePath)

    // the exe + its checksum live at the release's public direct asset URLs
    const exeUrl = updateAssetUrl(latest.tag, fileName)
    const checksumUrl = `${exeUrl}.sha256`

    const expected = await fetchExpectedChecksum(checksumUrl, fileName, TRUSTED_UPDATE_HOSTS)
    if (!expected) throw new Error('No published checksum for this release — refusing to update')

    // a previous session may have left a fully staged exe — re-verify, skip the download
    if (existsSync(stagedPath) && (await sha256OfFile(stagedPath)) === expected) {
      staged = { version: latest.version, sha256: expected }
      onProgress({ phase: 'ready' })
      return buildResult()
    }

    onProgress({ phase: 'downloading', receivedBytes: 0 })
    const onBytes = throttle((received: number, total?: number) => {
      onProgress({ phase: 'downloading', receivedBytes: received, totalBytes: total })
    }, 200)
    // staged next to the exe on purpose: the final swap is a same-volume rename
    const actual = await downloadToFile(exeUrl, stagedPath, onBytes, TRUSTED_UPDATE_HOSTS)

    onProgress({ phase: 'verifying' })
    if (actual !== expected) {
      await rm(stagedPath, { force: true })
      throw new Error('Checksum mismatch — the downloaded update is corrupted or tampered with')
    }
    staged = { version: latest.version, sha256: expected }
    onProgress({ phase: 'ready' })
    return buildResult()
  } finally {
    downloadInFlight = false
  }
}

/**
 * The swap must happen AFTER the app exits: the NSIS portable stub (our parent
 * process) keeps its own exe file open for its whole lifetime — even a rename is
 * denied while it runs (verified on a real build; plain image-mapped exes allow
 * renames, the stub's own read handle does not). It also wipes its temp unpack
 * dir on exit, so the new exe must start only once the stub is fully gone.
 * A detached PowerShell waits for the stub, swaps with retries (the stub's ~90MB
 * temp cleanup, plus cloud-sync/AV, can hold the file for seconds), rolls back on
 * failure, then relaunches.
 */
function spawnSwapHelper(exePath: string, stagedPath: string): void {
  const quote = (value: string): string => `'${value.replace(/'/g, "''")}'`
  const script = [
    `$ErrorActionPreference = 'SilentlyContinue'`,
    `$exe = ${quote(exePath)}`,
    `$staged = ${quote(stagedPath)}`,
    `$old = $exe + '.old'`,
    `try { Wait-Process -Id ${process.ppid} -Timeout 60 } catch {}`,
    // retry the rename for ~30s: the stub only releases its own exe once it exits
    // and finishes RMDir'ing its temp unpack dir
    `function MoveRetry($from, $to) {`,
    `  for ($i = 0; $i -lt 60; $i++) {`,
    `    try { Move-Item -LiteralPath $from -Destination $to -Force -ErrorAction Stop; return $true } catch { Start-Sleep -Milliseconds 500 }`,
    `  }`,
    `  return $false`,
    `}`,
    `Remove-Item -LiteralPath $old -Force`,
    // every failure branch must relaunch: the app already quit, and a helper that
    // gives up silently would leave the user with a vanished launcher
    `if (-not (MoveRetry $exe $old)) { Start-Process -FilePath $exe; exit 1 }`,
    `if (-not (MoveRetry $staged $exe)) { [void](MoveRetry $old $exe); Start-Process -FilePath $exe; exit 1 }`,
    `Start-Process -FilePath $exe`,
    `Remove-Item -LiteralPath $old -Force`
  ].join('\n')
  // Launch via `cmd /c start`, NOT a direct spawn of powershell.exe: a directly
  // detached powershell child is created but never actually runs its script here
  // (verified — spawn succeeds, no swap happens); `start` fully detaches it so it
  // survives the imminent app.quit() and completes the swap + relaunch.
  // -EncodedCommand sidesteps both argument quoting and script execution policy.
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  spawn(
    'cmd.exe',
    ['/c', 'start', '', '/b', 'powershell.exe', '-NoProfile', '-WindowStyle', 'Hidden', '-EncodedCommand', encoded],
    { detached: true, stdio: 'ignore', windowsHide: true }
  ).unref()
}

export async function installUpdateAndRestart(): Promise<void> {
  const exePath = portableExePath()
  if (!exePath) throw new Error('Self-update works only in the portable Windows build')
  const latest = cached?.latest
  if (!latest || staged?.version !== latest.version) {
    throw new Error('No verified update staged — download it first')
  }
  const stagedPath = stagedPathFor(exePath)
  // the staged file sat on disk unattended — make sure it is still the verified bytes
  if (!existsSync(stagedPath) || (await sha256OfFile(stagedPath)) !== staged.sha256) {
    staged = null
    throw new Error('The staged update changed on disk — download it again')
  }

  spawnSwapHelper(exePath, stagedPath)
  app.quit()
}

/** Delete the `.old` exe a successful update left behind (best-effort, retried). */
export function cleanupAfterUpdate(): void {
  const exePath = portableExePath()
  if (!exePath) return
  const oldPath = oldPathFor(exePath)
  if (!existsSync(oldPath)) return
  void (async () => {
    // the previous stub can still be exiting (it held this file) — retry quietly;
    // if it stays locked (AV scan, cloud sync) the next launch tries again
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        await rm(oldPath, { force: true })
        return
      } catch {
        await delay(2000)
      }
    }
  })()
}
