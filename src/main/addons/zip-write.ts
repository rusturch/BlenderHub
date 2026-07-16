import { deflateRawSync } from 'zlib'

// Minimal, dependency-free ZIP writer. Used to pack an already-installed add-on's
// files back into a .zip the launcher can store and reinstall elsewhere. Archives
// are DETERMINISTIC (sorted entries, fixed timestamp) so re-backing-up identical
// files yields identical bytes — the library's sha256 dedup then just works.

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buffer: Buffer): number {
  let c = 0xffffffff
  for (let i = 0; i < buffer.length; i++) c = CRC_TABLE[(c ^ buffer[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

export interface ZipInput {
  /** forward-slash path inside the archive, e.g. "better_fbx/__init__.py" */
  arcName: string
  data: Buffer
}

// DOS date 1980-01-01, time 00:00 — a fixed stamp keeps archives reproducible
const DOS_DATE = 0x0021
const DOS_TIME = 0x0000
const UTF8_NAME_FLAG = 0x0800

export function buildZip(inputs: ZipInput[]): Buffer {
  const entries = [...inputs].sort((a, b) => (a.arcName < b.arcName ? -1 : a.arcName > b.arcName ? 1 : 0))
  const chunks: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.arcName, 'utf8')
    const crc = crc32(entry.data)
    const compressed = deflateRawSync(entry.data)
    const store = compressed.length >= entry.data.length
    const method = store ? 0 : 8
    const body = store ? entry.data : compressed
    const localOffset = offset

    const local = Buffer.alloc(30 + nameBuf.length)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(UTF8_NAME_FLAG, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(DOS_TIME, 10)
    local.writeUInt16LE(DOS_DATE, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(entry.data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28)
    nameBuf.copy(local, 30)
    chunks.push(local, body)
    offset += local.length + body.length

    const dir = Buffer.alloc(46 + nameBuf.length)
    dir.writeUInt32LE(0x02014b50, 0)
    dir.writeUInt16LE(20, 4)
    dir.writeUInt16LE(20, 6)
    dir.writeUInt16LE(UTF8_NAME_FLAG, 8)
    dir.writeUInt16LE(method, 10)
    dir.writeUInt16LE(DOS_TIME, 12)
    dir.writeUInt16LE(DOS_DATE, 14)
    dir.writeUInt32LE(crc, 16)
    dir.writeUInt32LE(body.length, 20)
    dir.writeUInt32LE(entry.data.length, 24)
    dir.writeUInt16LE(nameBuf.length, 28)
    dir.writeUInt16LE(0, 30)
    dir.writeUInt16LE(0, 32)
    dir.writeUInt16LE(0, 34)
    dir.writeUInt16LE(0, 36)
    dir.writeUInt32LE(0, 38)
    dir.writeUInt32LE(localOffset, 42)
    nameBuf.copy(dir, 46)
    central.push(dir)
  }

  const centralDir = Buffer.concat(central)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralDir.length, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20)
  return Buffer.concat([...chunks, centralDir, eocd])
}
