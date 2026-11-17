import { createHash, randomUUID } from 'crypto'
import { createWriteStream } from 'fs'
import { open, rename, rm } from 'fs/promises'
import type { ManifestItem, SyncEnvelope, SyncManifest } from '../../shared/cloud-sync'
import type { CloudSyncAccount } from '../../shared/types'
import { CloudAuthError, dropAccessToken, getAccessToken, revokeToken } from './google-auth'

// Application Security Requirement: the sync storage client talks to exactly
// one host (www.googleapis.com) over https, never follows redirects, caps every
// response it reads, and treats everything it downloads — file names, metadata
// and contents alike — as untrusted input (ids are validated by the engine
// before they can reach a filesystem path, payloads are re-sanitized on apply).
// Scope is drive.appdata: a hidden per-app folder in the user's own Drive; the
// launcher cannot see any of their real files.

const API_HOST = 'www.googleapis.com'
const API_ORIGIN = `https://${API_HOST}`
const REQUEST_TIMEOUT_MS = 20_000
const MAX_RESPONSE_BYTES = 512 * 1024
/** large binary blobs (add-on archives) get a long transfer budget, not the 20s one */
const TRANSFER_TIMEOUT_MS = 10 * 60_000
/** resumable upload chunk — a multiple of 256 KiB, as the API requires */
const UPLOAD_CHUNK_BYTES = 8 * 1024 * 1024
/** zero-content marker file whose appProperties carry the data epoch (see engine). */
const META_NAME = 'sync-meta'
/** content-addressed archive files live beside the JSON items as blob-<sha256> */
const BLOB_PREFIX = 'blob-'
const SHA_RE = /^[0-9a-f]{64}$/

export { CloudAuthError }

export interface CloudBlob {
  sha256: string
  size: number
  updatedAt: number
}

/** a manifest plus the binary blobs that live beside the items. */
export interface CloudListing extends SyncManifest {
  blobs: CloudBlob[]
}

// itemId → Drive fileId, warmed by every list; a plain cache, re-queried on miss.
const fileIds = new Map<string, string>()

interface RequestOptions {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE'
  query?: Record<string, string>
  body?: string
  contentType?: string
  /** acceptable non-2xx statuses the caller handles itself */
  allow?: number[]
}

async function readCapped(response: Response): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader) return ''
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    if (value) {
      total += value.length
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel()
        throw new Error('Cloud response is unexpectedly large')
      }
      chunks.push(value)
    }
  }
  return Buffer.concat(chunks).toString('utf8')
}

async function request(
  refreshToken: string,
  path: string,
  options: RequestOptions = {},
  retried = false
): Promise<{ status: number; text: string }> {
  const url = new URL(`${API_ORIGIN}${path}`)
  for (const [key, value] of Object.entries(options.query ?? {})) url.searchParams.set(key, value)
  if (url.hostname !== API_HOST || url.protocol !== 'https:') {
    throw new Error('Refusing to contact an untrusted cloud host')
  }

  const accessToken = await getAccessToken(refreshToken, retried)
  let response: Response
  try {
    response = await fetch(url, {
      method: options.method ?? 'GET',
      headers: {
        authorization: `Bearer ${accessToken}`,
        ...(options.contentType ? { 'content-type': options.contentType } : {})
      },
      body: options.body,
      redirect: 'error',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    })
  } catch (error) {
    if (error instanceof Error && error.name === 'TimeoutError') {
      throw new Error('Google Drive did not respond within 20s')
    }
    const cause = error instanceof Error ? (error.cause as { code?: string } | undefined) : undefined
    throw new Error(cause?.code ? `Google Drive is unreachable (${cause.code})` : 'Google Drive is unreachable')
  }

  // one forced token refresh on 401: the cached access token may have just died
  if (response.status === 401 && !retried) {
    await response.body?.cancel().catch(() => {})
    return request(refreshToken, path, options, true)
  }
  const text = await readCapped(response)
  if (response.status === 401) throw new CloudAuthError('Google access was revoked')
  if (response.status === 403) {
    // quota / rate errors come back as 403 with a reason — surface readably
    let reason = ''
    try {
      reason = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? ''
    } catch {
      // keep empty
    }
    throw new Error(reason || 'Google Drive refused the request')
  }
  if (!response.ok && !(options.allow ?? []).includes(response.status)) {
    throw new Error(`Google Drive responded with HTTP ${response.status}`)
  }
  return { status: response.status, text }
}

// --- account -------------------------------------------------------------------

export async function fetchAccount(refreshToken: string): Promise<CloudSyncAccount> {
  const { text } = await request(refreshToken, '/drive/v3/about', {
    query: { fields: 'user(displayName,emailAddress)' }
  })
  const parsed = JSON.parse(text) as { user?: { displayName?: string; emailAddress?: string } }
  return {
    displayName: typeof parsed.user?.displayName === 'string' ? parsed.user.displayName.slice(0, 120) : '',
    email: typeof parsed.user?.emailAddress === 'string' ? parsed.user.emailAddress.slice(0, 200) : ''
  }
}

/** disconnect = drop the whole grant; the app disappears from the Google account. */
export async function logout(refreshToken: string): Promise<void> {
  await revokeToken(refreshToken)
}

// --- listing / epoch -----------------------------------------------------------

interface DriveFile {
  id?: string
  name?: string
  version?: string
  size?: string
  modifiedTime?: string
  appProperties?: Record<string, string>
}

async function listFiles(refreshToken: string): Promise<DriveFile[]> {
  const files: DriveFile[] = []
  let pageToken = ''
  do {
    const { text } = await request(refreshToken, '/drive/v3/files', {
      query: {
        spaces: 'appDataFolder',
        pageSize: '1000',
        fields: 'nextPageToken,files(id,name,version,size,modifiedTime,appProperties)',
        ...(pageToken ? { pageToken } : {})
      }
    })
    const parsed = JSON.parse(text) as { files?: DriveFile[]; nextPageToken?: string }
    for (const file of parsed.files ?? []) files.push(file)
    pageToken = parsed.nextPageToken ?? ''
  } while (pageToken && files.length < 2000)
  return files
}

function toManifestItem(file: DriveFile): ManifestItem | null {
  if (!file.id || typeof file.name !== 'string') return null
  fileIds.set(file.name, file.id)
  const sha = file.appProperties?.sha256 ?? ''
  return {
    itemId: file.name,
    generation: Number(file.version ?? 0) || 0,
    sha256: SHA_RE.test(sha) ? sha : '',
    size: Number(file.size ?? 0) || 0,
    updatedAt: file.modifiedTime ? Date.parse(file.modifiedTime) || 0 : 0
  }
}

/**
 * List the app folder as a sync manifest. The epoch lives in the `sync-meta`
 * marker file's appProperties and changes on every "delete cloud data" — a
 * machine holding an older epoch knows the cloud was wiped on purpose and must
 * not re-upload (engine enforces that). A missing marker (fresh account, or
 * the user removed the app's data via Google settings) is created on the spot.
 */
export async function fetchManifest(refreshToken: string): Promise<CloudListing> {
  const files = await listFiles(refreshToken)
  const meta = files.find((file) => file.name === META_NAME)
  let dataEpoch = meta?.appProperties?.epoch ?? ''
  if (!meta || !dataEpoch) {
    dataEpoch = randomUUID()
    await createMeta(refreshToken, dataEpoch, meta?.id)
  }
  const items: ManifestItem[] = []
  const blobs: CloudBlob[] = []
  for (const file of files) {
    if (file.name === META_NAME) continue
    if (typeof file.name === 'string' && file.name.startsWith(BLOB_PREFIX)) {
      const sha = file.name.slice(BLOB_PREFIX.length)
      if (!file.id || !SHA_RE.test(sha)) continue
      fileIds.set(file.name, file.id)
      blobs.push({
        sha256: sha,
        size: Number(file.size ?? 0) || 0,
        updatedAt: file.modifiedTime ? Date.parse(file.modifiedTime) || 0 : 0
      })
      continue
    }
    const item = toManifestItem(file)
    if (item) items.push(item)
  }
  return { dataEpoch, items, blobs }
}

async function createMeta(refreshToken: string, epoch: string, existingId?: string): Promise<void> {
  if (existingId) {
    await request(refreshToken, `/drive/v3/files/${encodeURIComponent(existingId)}`, {
      method: 'PATCH',
      contentType: 'application/json',
      body: JSON.stringify({ appProperties: { epoch } }),
      query: { fields: 'id' }
    })
    return
  }
  await request(refreshToken, '/drive/v3/files', {
    method: 'POST',
    contentType: 'application/json',
    body: JSON.stringify({ name: META_NAME, parents: ['appDataFolder'], appProperties: { epoch } }),
    query: { fields: 'id' }
  })
}

// --- items ---------------------------------------------------------------------

async function resolveFileId(refreshToken: string, itemId: string): Promise<string | null> {
  const cached = fileIds.get(itemId)
  if (cached) return cached
  // cache miss (e.g. first push after a fresh start): re-list and retry
  await fetchManifest(refreshToken)
  return fileIds.get(itemId) ?? null
}

export async function fetchItem(
  refreshToken: string,
  itemId: string
): Promise<{ envelope: SyncEnvelope; generation: number } | null> {
  const fileId = await resolveFileId(refreshToken, itemId)
  if (!fileId) return null
  // metadata BEFORE media: if a write lands in between, we record a version
  // older than the content and simply re-pull next round (never miss an update)
  const metaResponse = await request(refreshToken, `/drive/v3/files/${encodeURIComponent(fileId)}`, {
    query: { fields: 'version' },
    allow: [404]
  })
  if (metaResponse.status === 404) return null
  const generation = Number((JSON.parse(metaResponse.text) as { version?: string }).version ?? 0) || 0
  const media = await request(refreshToken, `/drive/v3/files/${encodeURIComponent(fileId)}`, {
    query: { alt: 'media' },
    allow: [404]
  })
  if (media.status === 404) return null
  let envelope: SyncEnvelope
  try {
    envelope = JSON.parse(media.text) as SyncEnvelope
  } catch {
    throw new Error(`Cloud item ${itemId} is not valid JSON`)
  }
  return { envelope, generation }
}

export type PutResult =
  | { ok: true; generation: number }
  | { ok: false; conflict: true; current: { generation: number; sha256: string } | null }

function multipartBody(metadata: object, content: string): { body: string; contentType: string } {
  const boundary = `bh-${randomUUID()}`
  const body =
    `--${boundary}\r\ncontent-type: application/json; charset=utf-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\ncontent-type: application/json; charset=utf-8\r\n\r\n${content}\r\n--${boundary}--`
  return { body, contentType: `multipart/related; boundary=${boundary}` }
}

/**
 * Optimistic compare-and-swap. Drive v3 has no If-Match precondition, so the
 * version is checked right before the write; the remaining race window is
 * milliseconds between the user's OWN machines, and a lost race surfaces as a
 * version mismatch next round and goes through the normal conflict path —
 * which is non-destructive by design. Good enough for per-account sync.
 */
export async function putItem(
  refreshToken: string,
  itemId: string,
  envelope: SyncEnvelope,
  ifGeneration: number
): Promise<PutResult> {
  const content = JSON.stringify(envelope)
  if (Buffer.byteLength(content, 'utf8') > 256 * 1024) throw new Error('Sync item exceeds the 256 KB limit')
  const fileId = fileIds.get(itemId) ?? (ifGeneration > 0 ? await resolveFileId(refreshToken, itemId) : null)

  if (ifGeneration === 0) {
    // "must not exist": a visible existing file is a conflict
    const existing = fileId ?? (await resolveFileId(refreshToken, itemId))
    if (existing) {
      const current = await currentMeta(refreshToken, existing)
      if (current) return { ok: false, conflict: true, current }
      fileIds.delete(itemId) // stale cache entry: the file is gone, create fresh
    }
    const { body, contentType } = multipartBody(
      { name: itemId, parents: ['appDataFolder'], appProperties: { sha256: envelope.sha256 } },
      content
    )
    const { text } = await request(refreshToken, '/upload/drive/v3/files', {
      method: 'POST',
      body,
      contentType,
      query: { uploadType: 'multipart', fields: 'id,version' }
    })
    const parsed = JSON.parse(text) as { id?: string; version?: string }
    if (parsed.id) fileIds.set(itemId, parsed.id)
    return { ok: true, generation: Number(parsed.version ?? 0) || 0 }
  }

  if (!fileId) {
    // we expected generation N but the file is gone — someone deleted it
    return { ok: false, conflict: true, current: null }
  }
  const current = await currentMeta(refreshToken, fileId)
  if (!current || current.generation !== ifGeneration) {
    return { ok: false, conflict: true, current }
  }
  const { body, contentType } = multipartBody({ appProperties: { sha256: envelope.sha256 } }, content)
  const { text } = await request(refreshToken, `/upload/drive/v3/files/${encodeURIComponent(fileId)}`, {
    method: 'PATCH',
    body,
    contentType,
    query: { uploadType: 'multipart', fields: 'id,version' }
  })
  const parsed = JSON.parse(text) as { version?: string }
  return { ok: true, generation: Number(parsed.version ?? 0) || 0 }
}

async function currentMeta(
  refreshToken: string,
  fileId: string
): Promise<{ generation: number; sha256: string } | null> {
  const { status, text } = await request(refreshToken, `/drive/v3/files/${encodeURIComponent(fileId)}`, {
    query: { fields: 'version,appProperties' },
    allow: [404]
  })
  if (status === 404) return null
  const parsed = JSON.parse(text) as { version?: string; appProperties?: Record<string, string> }
  const sha = parsed.appProperties?.sha256 ?? ''
  return { generation: Number(parsed.version ?? 0) || 0, sha256: SHA_RE.test(sha) ? sha : '' }
}

// --- binary blobs (add-on archives, content-addressed by sha256) -----------------

const blobName = (sha256: string): string => `${BLOB_PREFIX}${sha256}`

/** raw fetch failures carry the real reason in `cause` — surface it readably. */
function describeTransferError(error: unknown): Error {
  if (error instanceof Error && error.name === 'TimeoutError') {
    return new Error('Google Drive did not respond in time')
  }
  const cause = error instanceof Error ? (error.cause as { code?: string; message?: string } | undefined) : undefined
  const detail = cause?.code || cause?.message || (error instanceof Error ? error.message : '')
  return new Error(detail ? `Google Drive transfer failed (${detail})` : 'Google Drive transfer failed')
}

/** destination host of a redirect response, for diagnostics only (never followed). */
function redirectHost(response: Response): string {
  try {
    return new URL(response.headers.get('location') ?? '').hostname || 'unknown host'
  } catch {
    return 'unknown host'
  }
}

function assertUploadSession(rawUrl: string): URL {
  const url = new URL(rawUrl)
  if (url.protocol !== 'https:' || url.hostname !== API_HOST) {
    throw new Error('Refusing an untrusted upload session URL')
  }
  return url
}

/**
 * Resumable chunked upload of a local file as blob-<sha256>. Chunks keep memory
 * flat and give each network write its own timeout; the whole file never sits
 * in RAM. The caller guarantees the sha matches the file (library entries are
 * content-addressed and hash-verified on read).
 */
export async function uploadBlob(refreshToken: string, sha256: string, filePath: string, size: number): Promise<void> {
  if (!SHA_RE.test(sha256)) throw new Error('Invalid blob hash')
  const accessToken = await getAccessToken(refreshToken)
  const initiate = await fetch(`${API_ORIGIN}/upload/drive/v3/files?uploadType=resumable&fields=id`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${accessToken}`,
      'content-type': 'application/json; charset=utf-8',
      'x-upload-content-type': 'application/octet-stream',
      'x-upload-content-length': String(size)
    },
    body: JSON.stringify({ name: blobName(sha256), parents: ['appDataFolder'], appProperties: { sha256 } }),
    // 'manual', not 'error': fetch classes 308 as a redirect status, and Google's
    // resumable protocol answers interim chunks with 308 "Resume Incomplete"
    redirect: 'manual',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
  }).catch((error: unknown) => {
    throw describeTransferError(error)
  })
  if (initiate.status === 401) throw new CloudAuthError('Google access was revoked')
  if (initiate.status >= 300 && initiate.status < 400) {
    throw new Error(`Upload initiate redirected (HTTP ${initiate.status} → ${redirectHost(initiate)})`)
  }
  if (!initiate.ok) throw new Error(`Could not start the upload (HTTP ${initiate.status})`)
  const session = assertUploadSession(initiate.headers.get('location') ?? '')

  const handle = await open(filePath, 'r')
  try {
    const buffer = Buffer.alloc(Math.min(UPLOAD_CHUNK_BYTES, size))
    let offset = 0
    while (offset < size) {
      const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, size - offset), offset)
      if (bytesRead <= 0) throw new Error('The file shrank while uploading')
      const chunk = buffer.subarray(0, bytesRead)
      // no manual content-length: it is a forbidden fetch header; the body length supplies it
      const response = await fetch(session, {
        method: 'PUT',
        headers: { 'content-range': `bytes ${offset}-${offset + bytesRead - 1}/${size}` },
        body: chunk,
        redirect: 'manual', // see the initiate request: 308 here means "resume incomplete"
        signal: AbortSignal.timeout(TRANSFER_TIMEOUT_MS)
      }).catch((error: unknown) => {
        throw describeTransferError(error)
      })
      offset += bytesRead
      if (response.status === 308) continue // resume incomplete: next chunk
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel().catch(() => {})
        throw new Error(`Upload redirected (HTTP ${response.status} → ${redirectHost(response)})`)
      }
      if ((response.status === 200 || response.status === 201) && offset >= size) {
        const parsed = (await response.json().catch(() => ({}))) as { id?: string }
        if (parsed.id) fileIds.set(blobName(sha256), parsed.id)
        return
      }
      await response.body?.cancel().catch(() => {})
      throw new Error(`Upload failed (HTTP ${response.status})`)
    }
    throw new Error('Upload ended without completion')
  } finally {
    await handle.close()
  }
}

/**
 * Stream a blob to a local file with a byte cap and sha256 verification — a
 * pulled archive is untrusted until its hash matches the content-addressed
 * name. Writes to <target>.tmp and renames only after the hash checks out.
 */
export async function downloadBlobToFile(
  refreshToken: string,
  sha256: string,
  targetPath: string,
  maxBytes: number
): Promise<void> {
  if (!SHA_RE.test(sha256)) throw new Error('Invalid blob hash')
  const fileId = await resolveFileId(refreshToken, blobName(sha256))
  if (!fileId) throw new Error('The add-on file is missing from the cloud')

  const run = async (retried: boolean): Promise<void> => {
    const accessToken = await getAccessToken(refreshToken, retried)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TRANSFER_TIMEOUT_MS)
    try {
      const response = await fetch(
        `${API_ORIGIN}/drive/v3/files/${encodeURIComponent(fileId)}?alt=media`,
        { headers: { authorization: `Bearer ${accessToken}` }, redirect: 'manual', signal: controller.signal }
      ).catch((error: unknown) => {
        throw describeTransferError(error)
      })
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel().catch(() => {})
        throw new Error(`Download redirected (HTTP ${response.status} → ${redirectHost(response)})`)
      }
      if (response.status === 401 && !retried) {
        await response.body?.cancel().catch(() => {})
        return run(true)
      }
      if (response.status === 401) throw new CloudAuthError('Google access was revoked')
      if (!response.ok || !response.body) throw new Error(`Download failed (HTTP ${response.status})`)

      const hash = createHash('sha256')
      let received = 0
      const tmpPath = `${targetPath}.tmp`
      const sink = createWriteStream(tmpPath)
      try {
        const reader = response.body.getReader()
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          if (!value) continue
          received += value.length
          if (received > maxBytes) {
            await reader.cancel()
            throw new Error('The add-on file is unexpectedly large — aborting')
          }
          hash.update(value)
          if (!sink.write(value)) await new Promise((resolve) => sink.once('drain', resolve))
        }
        await new Promise<void>((resolve, reject) => sink.end((error: unknown) => (error ? reject(error) : resolve())))
        if (hash.digest('hex') !== sha256) throw new Error('Downloaded add-on file failed its hash check')
        await rename(tmpPath, targetPath)
      } catch (error) {
        sink.destroy()
        await rm(tmpPath, { force: true }).catch(() => {})
        throw error
      }
    } finally {
      clearTimeout(timer)
    }
  }
  await run(false)
}

/** remove one archive blob (library entry deleted, or unreferenced garbage). */
export async function deleteBlob(refreshToken: string, sha256: string): Promise<void> {
  if (!SHA_RE.test(sha256)) return
  const fileId = fileIds.get(blobName(sha256))
  if (!fileId) return // unknown blob: the next listing refreshes the cache
  await request(refreshToken, `/drive/v3/files/${encodeURIComponent(fileId)}`, { method: 'DELETE', allow: [404] })
  fileIds.delete(blobName(sha256))
}

/** delete a single item (used to reap retired item kinds left by older clients). */
export async function deleteItem(refreshToken: string, itemId: string): Promise<void> {
  const fileId = await resolveFileId(refreshToken, itemId)
  if (!fileId) return
  await request(refreshToken, `/drive/v3/files/${encodeURIComponent(fileId)}`, { method: 'DELETE', allow: [404] })
  fileIds.delete(itemId)
}

/** wipe the app folder and stamp a fresh epoch so other machines don't re-upload. */
export async function deleteCloudData(refreshToken: string): Promise<string> {
  const files = await listFiles(refreshToken)
  for (const file of files) {
    if (!file.id) continue
    await request(refreshToken, `/drive/v3/files/${encodeURIComponent(file.id)}`, {
      method: 'DELETE',
      allow: [404]
    })
  }
  fileIds.clear()
  const epoch = randomUUID()
  await createMeta(refreshToken, epoch)
  return epoch
}

export function dropCaches(refreshToken: string | null): void {
  fileIds.clear()
  if (refreshToken) dropAccessToken(refreshToken)
}
