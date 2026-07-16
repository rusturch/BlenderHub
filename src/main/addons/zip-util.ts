import { open } from 'fs/promises'
import { inflateRawSync } from 'zlib'

// Minimal zip reader: list entries and read small text members. Pure Node (fs + zlib),
// because system tar reads zip only via bsdtar (absent from GNU tar on Linux) and the
// project ships zero extra runtime dependencies. Zip64 archives are rejected.

const EOCD_SIG = 0x06054b50
const CDIR_SIG = 0x02014b50
const LOCAL_SIG = 0x04034b50

export interface ZipEntry {
  name: string
  method: number
  compressedSize: number
  uncompressedSize: number
  localOffset: number
}

export async function listZipEntries(path: string): Promise<ZipEntry[]> {
  const handle = await open(path, 'r')
  try {
    const size = (await handle.stat()).size
    if (size < 22) throw new Error('Not a zip file')
    const tailLength = Math.min(size, 22 + 65_535)
    const tail = Buffer.alloc(tailLength)
    await handle.read(tail, 0, tailLength, size - tailLength)
    let eocd = -1
    for (let i = tailLength - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) !== EOCD_SIG) continue
      // a real EOCD's comment runs exactly to the end of the file — this rejects
      // stray signature bytes sitting inside the archive comment
      const commentLength = tail.readUInt16LE(i + 20)
      if (i + 22 + commentLength === tailLength) {
        eocd = i
        break
      }
    }
    if (eocd === -1) throw new Error('Not a zip file')
    const count = tail.readUInt16LE(eocd + 10)
    const cdSize = tail.readUInt32LE(eocd + 12)
    const cdOffset = tail.readUInt32LE(eocd + 16)
    if (cdOffset === 0xffffffff || cdSize === 0xffffffff || count === 0xffff) {
      throw new Error('zip64 archives are not supported')
    }
    if (cdSize > 64 * 1024 * 1024 || cdOffset + cdSize > size) {
      throw new Error('Corrupted zip central directory')
    }
    const cd = Buffer.alloc(cdSize)
    await handle.read(cd, 0, cdSize, cdOffset)
    const entries: ZipEntry[] = []
    let cursor = 0
    for (let i = 0; i < count && cursor + 46 <= cdSize; i++) {
      if (cd.readUInt32LE(cursor) !== CDIR_SIG) break
      const method = cd.readUInt16LE(cursor + 10)
      const compressedSize = cd.readUInt32LE(cursor + 20)
      const uncompressedSize = cd.readUInt32LE(cursor + 24)
      const nameLength = cd.readUInt16LE(cursor + 28)
      const extraLength = cd.readUInt16LE(cursor + 30)
      const commentLength = cd.readUInt16LE(cursor + 32)
      const localOffset = cd.readUInt32LE(cursor + 42)
      const name = cd.toString('utf8', cursor + 46, cursor + 46 + nameLength)
      entries.push({ name, method, compressedSize, uncompressedSize, localOffset })
      cursor += 46 + nameLength + extraLength + commentLength
    }
    return entries
  } finally {
    await handle.close()
  }
}

export async function readZipEntryText(
  path: string,
  entry: ZipEntry,
  maxBytes = 2 * 1024 * 1024
): Promise<string> {
  return (await readZipEntryBytes(path, entry, maxBytes, maxBytes * 4)).toString('utf8')
}

export async function readZipEntryBytes(
  path: string,
  entry: ZipEntry,
  maxCompressed = 64 * 1024 * 1024,
  maxUncompressed = 64 * 1024 * 1024
): Promise<Buffer> {
  if (entry.compressedSize > maxCompressed || entry.uncompressedSize > maxUncompressed) {
    throw new Error('Zip entry is too large to inspect')
  }
  const handle = await open(path, 'r')
  try {
    const header = Buffer.alloc(30)
    await handle.read(header, 0, 30, entry.localOffset)
    if (header.readUInt32LE(0) !== LOCAL_SIG) throw new Error('Corrupted zip entry')
    const nameLength = header.readUInt16LE(26)
    const extraLength = header.readUInt16LE(28)
    const dataStart = entry.localOffset + 30 + nameLength + extraLength
    const raw = Buffer.alloc(entry.compressedSize)
    await handle.read(raw, 0, entry.compressedSize, dataStart)
    if (entry.method === 0) return raw
    if (entry.method === 8) {
      // cap the REAL inflated size — central-directory sizes are attacker-controlled,
      // so without this a small deflate bomb could balloon to gigabytes in memory
      try {
        return inflateRawSync(raw, { maxOutputLength: maxUncompressed })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ERR_BUFFER_TOO_LARGE') {
          throw new Error('Zip entry is too large to inspect')
        }
        throw error
      }
    }
    throw new Error('Unsupported zip compression method')
  } finally {
    await handle.close()
  }
}
