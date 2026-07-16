import { createHash } from 'crypto'
import { createWriteStream } from 'fs'
import { mkdir, rm } from 'fs/promises'
import { arch } from 'os'
import { join } from 'path'
import { Readable, Transform } from 'stream'
import { pipeline } from 'stream/promises'
import type { ReadableStream as WebReadableStream } from 'stream/web'
import { getDownloadsDir } from '../blender/installs'

// Generic client for Blender extension-repository listing APIs (the /api/v1/extensions/
// format). extensions.blender.org is public; Superhive is the same format but token-gated
// with an `Authorization: Bearer <token>` header (verified against Blender's own cli/
// blender_ext.py). The listing is VERSION-AWARE: ?blender_version returns, per extension,
// the latest release compatible with that exact Blender version.
//
// Application Security Requirement: only allowlisted https hosts are contacted; the token,
// when present, travels ONLY as an Authorization header to that host; every download is
// verified against the listing's published sha256 before use.

export const BLENDER_ORG_HOST = 'extensions.blender.org'
const LISTING_TTL_MS = 10 * 60 * 1000
const MAX_ARCHIVE_BYTES = 512 * 1024 * 1024
const DOWNLOAD_TIMEOUT_MS = 300_000
// some repos (Superhive behind Cloudflare) reject downloads without a client User-Agent
const USER_AGENT = 'BlenderHub/0.1 (Blender extension client)'

export interface RemoteRelease {
  pkgId: string
  name: string
  version: string
  archiveUrl: string
  /** hex sha256 (prefix stripped) */
  sha256: string
  archiveSize: number
  blenderVersionMin: string | null
  /** exclusive upper bound — the add-on supports strictly below it. null when open-ended */
  blenderVersionMax: string | null
}

interface RawListingEntry {
  id?: unknown
  name?: unknown
  version?: unknown
  archive_url?: unknown
  archive_hash?: unknown
  archive_size?: unknown
  blender_version_min?: unknown
  blender_version_max?: unknown
  type?: unknown
}

export function apiPlatform(): string {
  const cpu = arch() === 'arm64' ? 'arm64' : 'x64'
  if (process.platform === 'win32') return `windows-${cpu}`
  if (process.platform === 'darwin') return `macos-${cpu}`
  return `linux-${cpu}`
}

// cache keyed by host|version — a token change is handled by clearing the cache
const listingCache = new Map<string, { fetchedAt: number; byId: Map<string, RemoteRelease> }>()

export function clearListingCache(host?: string): void {
  if (!host) {
    listingCache.clear()
    return
  }
  for (const key of listingCache.keys()) if (key.startsWith(`${host}|`)) listingCache.delete(key)
}

/** fetch the version-compatible extension listing from a repo host, keyed by pkg id */
export async function fetchRepoListing(
  host: string,
  blenderVersion: string,
  options: { token?: string; label?: string } = {}
): Promise<Map<string, RemoteRelease>> {
  const label = options.label ?? host
  const key = `${host}|${blenderVersion}`
  const cached = listingCache.get(key)
  if (cached && Date.now() - cached.fetchedAt < LISTING_TTL_MS) return cached.byId

  const url = new URL(`https://${host}/api/v1/extensions/`)
  url.searchParams.set('blender_version', blenderVersion)
  url.searchParams.set('platform', apiPlatform())
  const headers: Record<string, string> = { accept: 'application/json', 'User-Agent': USER_AGENT }
  if (options.token) headers['Authorization'] = `Bearer ${options.token}`

  const response = await fetch(url, { headers })
  if (response.status === 401 || response.status === 403) {
    throw new Error(`${label} rejected the request — check your API token in Settings`)
  }
  if (!response.ok) throw new Error(`${label} responded with HTTP ${response.status}`)
  const payload = (await response.json()) as { data?: unknown }
  if (!Array.isArray(payload.data)) throw new Error(`Unexpected listing format from ${label}`)

  const byId = new Map<string, RemoteRelease>()
  for (const raw of payload.data as RawListingEntry[]) {
    if (raw.type !== 'add-on') continue
    const id = typeof raw.id === 'string' ? raw.id : null
    const archiveUrl = typeof raw.archive_url === 'string' ? raw.archive_url : null
    const hash = typeof raw.archive_hash === 'string' ? raw.archive_hash : null
    const version = typeof raw.version === 'string' ? raw.version : null
    if (!id || !archiveUrl || !hash || !version) continue
    const sha256 = /^sha256:([a-fA-F0-9]{64})$/.exec(hash)?.[1]?.toLowerCase()
    if (!sha256) continue
    byId.set(id, {
      pkgId: id,
      name: typeof raw.name === 'string' && raw.name ? raw.name : id,
      version,
      archiveUrl,
      sha256,
      archiveSize: typeof raw.archive_size === 'number' ? raw.archive_size : 0,
      blenderVersionMin: typeof raw.blender_version_min === 'string' ? raw.blender_version_min : null,
      blenderVersionMax:
        typeof raw.blender_version_max === 'string' && raw.blender_version_max ? raw.blender_version_max : null
    })
  }
  listingCache.set(key, { fetchedAt: Date.now(), byId })
  return byId
}

/** the latest release of pkgId on extensions.blender.org compatible with this version */
export async function findCompatibleRelease(
  pkgId: string,
  blenderVersion: string
): Promise<RemoteRelease | null> {
  return (await fetchRepoListing(BLENDER_ORG_HOST, blenderVersion)).get(pkgId) ?? null
}

let downloadSeq = 0

function assertTrustedArchiveUrl(rawUrl: string, allowedHosts: string[]): URL {
  const url = new URL(rawUrl)
  const host = url.hostname.toLowerCase()
  const trusted = allowedHosts.some((allowed) => host === allowed || host.endsWith(`.${allowed}`))
  if (url.protocol !== 'https:' || !trusted) {
    throw new Error('Refusing to download from an untrusted source')
  }
  return url
}

/**
 * Download a release archive to the downloads dir over https from an allowlisted host,
 * optionally authenticated, and verify its sha256. Returns the temp path; caller deletes.
 */
export async function downloadFromRepo(
  release: RemoteRelease,
  allowedHosts: string[],
  token?: string
): Promise<string> {
  const url = assertTrustedArchiveUrl(release.archiveUrl, allowedHosts)
  const downloadsRoot = await getDownloadsDir()
  await mkdir(downloadsRoot, { recursive: true })
  // Date.now() alone can collide when parallel installs download the same package
  const target = join(downloadsRoot, `.ext-${release.pkgId}-${Date.now()}-${downloadSeq++}.zip`)

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS)
  try {
    const headers: Record<string, string> = { 'User-Agent': USER_AGENT }
    if (token) headers['Authorization'] = `Bearer ${token}`
    const response = await fetch(url, { signal: controller.signal, headers })
    if (!response.ok || !response.body) throw new Error(`Download failed: HTTP ${response.status}`)
    const hash = createHash('sha256')
    let received = 0
    const tap = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        received += chunk.length
        if (received > MAX_ARCHIVE_BYTES) {
          callback(new Error('Archive is unexpectedly large — aborting'))
          return
        }
        hash.update(chunk)
        callback(null, chunk)
      }
    })
    await pipeline(
      Readable.fromWeb(response.body as unknown as WebReadableStream),
      tap,
      createWriteStream(target)
    )
    if (hash.digest('hex') !== release.sha256) {
      throw new Error('Checksum mismatch — the downloaded extension is corrupted or tampered with')
    }
    return target
  } catch (error) {
    await rm(target, { force: true }).catch(() => {})
    throw error
  } finally {
    clearTimeout(timer)
  }
}

/** download a release from extensions.blender.org (no auth) */
export function downloadRelease(release: RemoteRelease): Promise<string> {
  return downloadFromRepo(release, [BLENDER_ORG_HOST])
}
