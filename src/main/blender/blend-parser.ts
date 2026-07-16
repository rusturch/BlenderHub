import { open } from 'fs/promises'
import { createGunzip, createZstdDecompress } from 'zlib'

// Reads version and the embedded thumbnail from a .blend file without launching
// Blender. Format reference: scripts/modules/_blendfile_header.py in Blender —
// legacy 12-byte header + BHead4/SmallBHead8 blocks, or the self-describing
// 17-byte header (file format v1) + LargeBHead8 blocks. REND/TEST blocks are
// written right after the header, so reading the head of the file is enough.

const HEAD_READ_BYTES = 4 * 1024 * 1024
const MAX_DECOMPRESSED_BYTES = 8 * 1024 * 1024
const MAX_BLOCKS_TO_SCAN = 64

export interface BlendThumbnail {
  width: number
  height: number
  rgba: Buffer
}

export interface BlendInfo {
  versionCode: number | null
  version: string | null
  thumbnail: BlendThumbnail | null
}

const UNKNOWN: BlendInfo = { versionCode: null, version: null, thumbnail: null }

async function readHead(filePath: string): Promise<Buffer> {
  const handle = await open(filePath, 'r')
  try {
    const info = await handle.stat()
    const size = Math.min(info.size, HEAD_READ_BYTES)
    const buffer = Buffer.alloc(size)
    await handle.read(buffer, 0, size, 0)
    return buffer
  } finally {
    await handle.close()
  }
}

function decompressHead(data: Buffer, kind: 'gzip' | 'zstd'): Promise<Buffer> {
  return new Promise((resolve) => {
    const stream = kind === 'gzip' ? createGunzip() : createZstdDecompress()
    const chunks: Buffer[] = []
    let total = 0
    let settled = false
    const finish = (): void => {
      if (!settled) {
        settled = true
        resolve(Buffer.concat(chunks))
      }
    }
    stream.on('data', (chunk: Buffer) => {
      chunks.push(chunk)
      total += chunk.length
      if (total >= MAX_DECOMPRESSED_BYTES) {
        finish()
        stream.destroy()
      }
    })
    // truncated input is expected — we only read the head of the file
    stream.on('error', finish)
    stream.on('end', finish)
    stream.end(data)
  })
}

interface BlockLayout {
  headerSize: number
  lengthOf(data: Buffer, offset: number, littleEndian: boolean): number
}

const BHEAD4: BlockLayout = {
  headerSize: 20,
  lengthOf: (data, offset, littleEndian) =>
    littleEndian ? data.readInt32LE(offset + 4) : data.readInt32BE(offset + 4)
}

const SMALL_BHEAD8: BlockLayout = {
  headerSize: 24,
  lengthOf: (data, offset, littleEndian) =>
    littleEndian ? data.readInt32LE(offset + 4) : data.readInt32BE(offset + 4)
}

const LARGE_BHEAD8: BlockLayout = {
  headerSize: 32,
  lengthOf: (data, offset) => Number(data.readBigInt64LE(offset + 16))
}

interface ParsedHeader {
  blockStart: number
  layout: BlockLayout
  littleEndian: boolean
  versionCode: number
}

function parseHeader(data: Buffer): ParsedHeader | null {
  if (data.length < 12 || data.toString('latin1', 0, 7) !== 'BLENDER') return null
  const marker = data[7]
  if (marker === 0x5f || marker === 0x2d) {
    // legacy 12-byte header: '_' = 4-byte pointers, '-' = 8-byte pointers
    const littleEndian = data[8] === 0x76 // 'v'
    const versionCode = Number(data.toString('latin1', 9, 12))
    if (!Number.isFinite(versionCode)) return null
    return {
      blockStart: 12,
      layout: marker === 0x5f ? BHEAD4 : SMALL_BHEAD8,
      littleEndian,
      versionCode
    }
  }
  // self-describing header, e.g. "BLENDER17-01v0500"
  const headerSize = Number(data.toString('latin1', 7, 9))
  const formatVersion = Number(data.toString('latin1', 10, 12))
  const versionCode = Number(data.toString('latin1', 13, 17))
  if (!Number.isFinite(headerSize) || headerSize < 17 || data.length < headerSize) return null
  if (formatVersion !== 1 || !Number.isFinite(versionCode)) return null
  return { blockStart: headerSize, layout: LARGE_BHEAD8, littleEndian: true, versionCode }
}

function findThumbnail(data: Buffer, header: ParsedHeader): BlendThumbnail | null {
  const { layout, littleEndian } = header
  const readI32 = (offset: number): number =>
    littleEndian ? data.readInt32LE(offset) : data.readInt32BE(offset)
  let offset = header.blockStart
  for (let i = 0; i < MAX_BLOCKS_TO_SCAN; i++) {
    if (offset + layout.headerSize > data.length) return null
    const code = data.toString('latin1', offset, offset + 4)
    if (code === 'ENDB') return null
    let length: number
    try {
      length = layout.lengthOf(data, offset, littleEndian)
    } catch {
      return null
    }
    if (length < 0 || !Number.isFinite(length)) return null
    const bodyStart = offset + layout.headerSize
    if (code === 'TEST') {
      if (bodyStart + 8 > data.length) return null
      const width = readI32(bodyStart)
      const height = readI32(bodyStart + 4)
      if (width <= 0 || height <= 0 || width > 2048 || height > 2048) return null
      const pixelsEnd = bodyStart + 8 + width * height * 4
      if (pixelsEnd > data.length || 8 + width * height * 4 > length) return null
      return { width, height, rgba: data.subarray(bodyStart + 8, pixelsEnd) }
    }
    offset = bodyStart + length
  }
  return null
}

export async function readBlendInfo(filePath: string): Promise<BlendInfo> {
  let data: Buffer
  try {
    data = await readHead(filePath)
  } catch {
    return UNKNOWN
  }
  if (data.length >= 2 && data[0] === 0x1f && data[1] === 0x8b) {
    data = await decompressHead(data, 'gzip')
  } else if (data.length >= 4 && data.readUInt32LE(0) === 0xfd2fb528) {
    data = await decompressHead(data, 'zstd')
  }
  const header = parseHeader(data)
  if (!header) return UNKNOWN
  const { versionCode } = header
  const version = `${Math.floor(versionCode / 100)}.${versionCode % 100}`
  let thumbnail: BlendThumbnail | null = null
  try {
    thumbnail = findThumbnail(data, header)
  } catch {
    thumbnail = null
  }
  return { versionCode, version, thumbnail }
}
