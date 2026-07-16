import { createHash } from 'crypto'
import { createWriteStream } from 'fs'
import { Readable, Transform } from 'stream'
import { pipeline } from 'stream/promises'
import type { ReadableStream as WebReadableStream } from 'stream/web'

export function throttle<T extends unknown[]>(
  fn: (...args: T) => void,
  intervalMs: number
): (...args: T) => void {
  let last = 0
  return (...args: T) => {
    const now = Date.now()
    if (now - last >= intervalMs) {
      last = now
      fn(...args)
    }
  }
}

export async function downloadToFile(
  url: string,
  destination: string,
  onBytes: (received: number, total?: number) => void,
  // GitHub release assets 302-redirect to a CDN host — when given, the host the
  // bytes actually come from must be on this list too, not just the start URL
  allowedFinalHosts?: Set<string>
): Promise<string> {
  const response = await fetch(url)
  if (!response.ok || !response.body) throw new Error(`Download failed: HTTP ${response.status}`)
  if (allowedFinalHosts) {
    const final = new URL(response.url)
    if (final.protocol !== 'https:' || !allowedFinalHosts.has(final.hostname)) {
      throw new Error(`Untrusted download source: ${final.hostname}`)
    }
  }
  const total = Number(response.headers.get('content-length')) || undefined
  const hash = createHash('sha256')
  let received = 0
  const tap = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      hash.update(chunk)
      received += chunk.length
      onBytes(received, total)
      callback(null, chunk)
    }
  })
  await pipeline(Readable.fromWeb(response.body as unknown as WebReadableStream), tap, createWriteStream(destination))
  return hash.digest('hex')
}

export async function fetchExpectedChecksum(
  checksumUrl: string,
  fileName: string,
  allowedFinalHosts?: Set<string>
): Promise<string | null> {
  try {
    const response = await fetch(checksumUrl)
    if (!response.ok) return null
    if (allowedFinalHosts) {
      const final = new URL(response.url)
      if (final.protocol !== 'https:' || !allowedFinalHosts.has(final.hostname)) return null
    }
    const lines = (await response.text()).split('\n').filter((line) => /\b[a-fA-F0-9]{64}\b/.test(line))
    // .sha256 files may list every file of a release — pick the line for ours
    const relevant = lines.find((line) => line.includes(fileName)) ?? (lines.length === 1 ? lines[0] : undefined)
    const match = relevant?.match(/\b[a-fA-F0-9]{64}\b/)
    return match ? match[0].toLowerCase() : null
  } catch {
    return null
  }
}
