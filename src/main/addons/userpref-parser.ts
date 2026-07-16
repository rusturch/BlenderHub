import { readFile } from 'fs/promises'
import { gunzipSync } from 'zlib'
import { createHash } from 'crypto'

// Read-only parser for userpref.blend. The .blend format is self-describing: the
// DNA1 block carries every struct layout for the exact Blender build that wrote the
// file, so field offsets are computed per file — never hardcoded. That is what makes
// this safe across 2.83…5.x: if anything looks unfamiliar we THROW, and the caller
// falls back to the headless Blender scan (the source of truth).
//
// Header/block layouts mirror src/main/blender/blend-parser.ts (which reads project
// thumbnails); kept self-contained on purpose — this parser must be able to evolve
// without destabilizing the working project parser.

// eUserExtensionRepo_Flag / eUserExtensionRepo_Source values, verified against
// DNA_userdef_types.h on the 4.2 release branch and main (identical).
export const REPO_FLAG_DISABLED = 1 << 1
export const REPO_FLAG_USE_CUSTOM_DIRECTORY = 1 << 2
export const REPO_FLAG_USE_REMOTE_URL = 1 << 3
export const REPO_SOURCE_SYSTEM = 1

export interface ParsedExtensionRepo {
  name: string
  module: string
  /** raw DNA fields — interpreted by the caller against known flag bits */
  flag: number
  source: number
  customDirectory: string | null
  remoteUrl: string | null
}

export interface ParsedUserpref {
  versionCode: number
  /** module names exactly as Blender stores them ('node_wrangler', 'bl_ext.repo.pkg') */
  enabledModules: string[]
  /** Preferences → File Paths → Script Directories (3.6+: many; ≤3.5: single) */
  scriptDirectories: string[]
  extensionRepos: ParsedExtensionRepo[]
}

// --- low-level blend structure -------------------------------------------

interface Block {
  code: string
  sdnaIndex: number
  old: bigint
  bodyStart: number
  length: number
  /** element count — typed DATA blocks may hold an array of structs */
  nr: number
}

interface DnaField {
  typeIndex: number
  nameIndex: number
}

interface Dna {
  names: string[]
  types: string[]
  typeLengths: number[]
  structs: { typeIndex: number; fields: DnaField[] }[]
}

interface BlendFile {
  buffer: Buffer
  pointerSize: 4 | 8
  versionCode: number
  blocks: Block[]
  byAddress: Map<bigint, Block>
  dna: Dna
}

// a function declaration so TS control-flow understands calls to it never return
function fail(reason: string): never {
  throw new Error(`userpref parse: ${reason}`)
}

function parseAllBlocks(data: Buffer): BlendFile {
  if (data.length < 12 || data.toString('latin1', 0, 7) !== 'BLENDER') fail('not a blend file')
  const marker = data[7]

  let blockStart: number
  let pointerSize: 4 | 8
  let layout: 'bhead4' | 'small8' | 'large8'
  let versionCode: number

  if (marker === 0x5f || marker === 0x2d) {
    // legacy 12-byte header: '_' = 4-byte pointers, '-' = 8-byte pointers
    if (data[8] !== 0x76) fail('big-endian files are not supported') // 'v' = little-endian
    pointerSize = marker === 0x5f ? 4 : 8
    layout = marker === 0x5f ? 'bhead4' : 'small8'
    versionCode = Number(data.toString('latin1', 9, 12))
    blockStart = 12
  } else {
    // self-describing header, e.g. "BLENDER17-01v0500" (file format v1, always LE)
    const headerSize = Number(data.toString('latin1', 7, 9))
    const formatVersion = Number(data.toString('latin1', 10, 12))
    versionCode = Number(data.toString('latin1', 13, 17))
    if (!Number.isFinite(headerSize) || headerSize < 17) fail('bad header')
    if (formatVersion !== 1) fail(`unknown file format v${formatVersion}`)
    pointerSize = 8
    layout = 'large8'
    blockStart = headerSize
  }
  if (!Number.isFinite(versionCode)) fail('bad version code')

  const headerSizes = { bhead4: 20, small8: 24, large8: 32 } as const
  const headerSize = headerSizes[layout]
  const blocks: Block[] = []
  const byAddress = new Map<bigint, Block>()
  let offset = blockStart

  while (offset + headerSize <= data.length) {
    const code = data
      .toString('latin1', offset, offset + 4)
      .replace(/\0+$/, '')
    if (code === 'ENDB') break
    let length: number
    let old: bigint
    let sdnaIndex: number
    let nr: number
    if (layout === 'bhead4') {
      length = data.readInt32LE(offset + 4)
      old = BigInt(data.readUInt32LE(offset + 8))
      sdnaIndex = data.readInt32LE(offset + 12)
      nr = data.readInt32LE(offset + 16)
    } else if (layout === 'small8') {
      length = data.readInt32LE(offset + 4)
      old = data.readBigUInt64LE(offset + 8)
      sdnaIndex = data.readInt32LE(offset + 16)
      nr = data.readInt32LE(offset + 20)
    } else {
      sdnaIndex = data.readInt32LE(offset + 4)
      old = data.readBigUInt64LE(offset + 8)
      length = Number(data.readBigInt64LE(offset + 16))
      nr = Number(data.readBigInt64LE(offset + 24))
    }
    if (length < 0 || offset + headerSize + length > data.length) fail('truncated block')
    const block: Block = { code, sdnaIndex, old, bodyStart: offset + headerSize, length, nr }
    blocks.push(block)
    // DATA blocks are addressed by their old in-memory pointer; first one wins on dupes
    if (old !== 0n && !byAddress.has(old)) byAddress.set(old, block)
    offset += headerSize + length
    if (blocks.length > 100_000) fail('too many blocks')
  }

  const dnaBlock = blocks.find((candidate) => candidate.code === 'DNA1') ?? fail('no DNA1 block')
  const dna = parseDna(data.subarray(dnaBlock.bodyStart, dnaBlock.bodyStart + dnaBlock.length))
  return { buffer: data, pointerSize, versionCode, blocks, byAddress, dna }
}

function parseDna(data: Buffer): Dna {
  let offset = 0
  const tag = (expected: string): void => {
    if (data.toString('latin1', offset, offset + 4) !== expected) fail(`DNA tag ${expected} missing`)
    offset += 4
  }
  const align4 = (): void => {
    offset = (offset + 3) & ~3
  }
  const readStrings = (count: number): string[] => {
    const out: string[] = []
    for (let i = 0; i < count; i++) {
      const end = data.indexOf(0, offset)
      if (end === -1) fail('unterminated DNA string')
      out.push(data.toString('utf8', offset, end))
      offset = end + 1
    }
    return out
  }

  tag('SDNA')
  tag('NAME')
  const nameCount = data.readUInt32LE(offset)
  offset += 4
  const names = readStrings(nameCount)
  align4()
  tag('TYPE')
  const typeCount = data.readUInt32LE(offset)
  offset += 4
  const types = readStrings(typeCount)
  align4()
  tag('TLEN')
  const typeLengths: number[] = []
  for (let i = 0; i < typeCount; i++) {
    typeLengths.push(data.readUInt16LE(offset))
    offset += 2
  }
  align4()
  tag('STRC')
  const structCount = data.readUInt32LE(offset)
  offset += 4
  const structs: Dna['structs'] = []
  for (let i = 0; i < structCount; i++) {
    const typeIndex = data.readUInt16LE(offset)
    const fieldCount = data.readUInt16LE(offset + 2)
    offset += 4
    if (typeIndex >= typeCount) fail('DNA struct type out of range')
    const fields: DnaField[] = []
    for (let j = 0; j < fieldCount; j++) {
      const field = { typeIndex: data.readUInt16LE(offset), nameIndex: data.readUInt16LE(offset + 2) }
      // out-of-range indexes would turn offset sums into NaN — silent wrong reads
      if (field.typeIndex >= typeCount || field.nameIndex >= nameCount) {
        fail('DNA field index out of range')
      }
      fields.push(field)
      offset += 4
    }
    structs.push({ typeIndex, fields })
  }
  return { names, types, typeLengths, structs }
}

// --- field access via DNA ------------------------------------------------

const arrayLenOf = (name: string): number => {
  let len = 1
  for (const match of name.matchAll(/\[(\d+)\]/g)) len *= Number(match[1])
  return len
}

const baseNameOf = (name: string): string => {
  // "*next" -> next, "module[128]" -> module, "(*func)()" -> func
  const match = /^[(*\s]*([A-Za-z_][A-Za-z0-9_]*)/.exec(name)
  return match ? match[1] : name
}

function fieldSize(file: BlendFile, field: DnaField): number {
  const name = file.dna.names[field.nameIndex]
  const count = arrayLenOf(name)
  if (name.startsWith('*') || name.startsWith('(')) return file.pointerSize * count
  return file.dna.typeLengths[field.typeIndex] * count
}

interface FoundField {
  offset: number
  byteSize: number
  typeName: string
  rawName: string
}

function findField(file: BlendFile, structIndex: number, candidates: string[]): FoundField | null {
  const struct = file.dna.structs[structIndex] ?? fail('bad struct index')
  let offset = 0
  for (const field of struct.fields) {
    const rawName = file.dna.names[field.nameIndex]
    const size = fieldSize(file, field)
    if (candidates.includes(baseNameOf(rawName))) {
      return { offset, byteSize: size, typeName: file.dna.types[field.typeIndex], rawName }
    }
    offset += size
  }
  return null
}

function structIndexByName(file: BlendFile, typeName: string): number | null {
  for (let i = 0; i < file.dna.structs.length; i++) {
    if (file.dna.types[file.dna.structs[i].typeIndex] === typeName) return i
  }
  return null
}

const readPointer = (file: BlendFile, offset: number): bigint =>
  file.pointerSize === 8 ? file.buffer.readBigUInt64LE(offset) : BigInt(file.buffer.readUInt32LE(offset))

const readCString = (file: BlendFile, offset: number, maxBytes: number): string => {
  const end = Math.min(offset + maxBytes, file.buffer.length)
  let stop = offset
  while (stop < end && file.buffer[stop] !== 0) stop++
  return file.buffer.toString('utf8', offset, stop)
}

function readIntField(file: BlendFile, bodyStart: number, field: FoundField): number {
  const at = bodyStart + field.offset
  if (field.byteSize === 1) return file.buffer.readInt8(at)
  if (field.byteSize === 2) return file.buffer.readInt16LE(at)
  return file.buffer.readInt32LE(at)
}

/** walk a ListBase chain of DATA blocks, returning each element's block */
function walkList(file: BlendFile, structIndex: number, firstAddress: bigint): Block[] {
  const nextField = findField(file, structIndex, ['next']) ?? fail('list struct has no next')
  const elementSize = file.dna.typeLengths[file.dna.structs[structIndex].typeIndex]
  const out: Block[] = []
  const visited = new Set<bigint>()
  let current = firstAddress
  while (current !== 0n) {
    if (visited.has(current)) fail('cyclic list in preferences')
    visited.add(current)
    const block = file.byAddress.get(current)
    if (!block) fail('dangling list pointer in preferences')
    // a mis-typed or undersized block would make field reads spill into the next
    // block's bytes WITHOUT throwing — turn silent junk into the intended fallback
    if (block.length < elementSize) fail('list element block too small')
    if (block.sdnaIndex !== structIndex) fail('list element block has unexpected struct type')
    out.push(block)
    current = readPointer(file, block.bodyStart + nextField.offset)
    if (out.length > 8192) fail('preferences list too long')
  }
  return out
}

// --- the public entry point ----------------------------------------------

const ZSTD_MAGIC = 0xfd2fb528

function decompressBlend(data: Buffer): Buffer {
  if (data.length >= 2 && data[0] === 0x1f && data[1] === 0x8b) {
    return gunzipSync(data, { maxOutputLength: 64 * 1024 * 1024 })
  }
  if (data.length >= 4 && data.readUInt32LE(0) === ZSTD_MAGIC) {
    // userpref.blend is written uncompressed in practice; zstd would need node's
    // zstdDecompressSync (23.8+). Bail out to the headless fallback instead.
    fail('zstd-compressed preferences are not supported')
  }
  return data
}

/** locate the USER block and the UserDef struct, with body-size sanity checks */
function findUserBlock(file: BlendFile): { userBlock: Block; userStructIndex: number } {
  const userBlock =
    file.blocks.find((block) => block.code === 'USER') ?? fail('no USER block in preferences')
  const userStructIndex =
    file.dna.types[file.dna.structs[userBlock.sdnaIndex]?.typeIndex] === 'UserDef'
      ? userBlock.sdnaIndex
      : (structIndexByName(file, 'UserDef') ?? fail('no UserDef struct'))
  // field reads must stay inside the USER block body
  if (userBlock.length < file.dna.typeLengths[file.dna.structs[userStructIndex].typeIndex]) {
    fail('USER block smaller than UserDef')
  }
  return { userBlock, userStructIndex }
}

export async function parseUserpref(filePath: string): Promise<ParsedUserpref> {
  const file = parseAllBlocks(decompressBlend(await readFile(filePath)))

  // the USER block holds the UserDef struct
  const { userBlock, userStructIndex } = findUserBlock(file)

  // enabled add-ons: UserDef.addons -> ListBase of bAddon { module[…] }
  const addonsField = findField(file, userStructIndex, ['addons']) ?? fail('UserDef.addons missing')
  const addonStructIndex = structIndexByName(file, 'bAddon') ?? fail('no bAddon struct')
  const moduleField = findField(file, addonStructIndex, ['module']) ?? fail('bAddon.module missing')
  const enabledModules: string[] = []
  for (const block of walkList(
    file,
    addonStructIndex,
    readPointer(file, userBlock.bodyStart + addonsField.offset)
  )) {
    const module = readCString(file, block.bodyStart + moduleField.offset, moduleField.byteSize)
    if (module) enabledModules.push(module)
  }

  // script directories: 3.6+ ListBase of bUserScriptDirectory; ≤3.5 a single char path
  const scriptDirectories: string[] = []
  const scriptDirsField = findField(file, userStructIndex, ['script_directories'])
  if (scriptDirsField) {
    const dirStructIndex = structIndexByName(file, 'bUserScriptDirectory')
    if (dirStructIndex !== null) {
      const pathField =
        findField(file, dirStructIndex, ['dir_path', 'dirpath', 'path']) ??
        fail('bUserScriptDirectory path field missing')
      for (const block of walkList(
        file,
        dirStructIndex,
        readPointer(file, userBlock.bodyStart + scriptDirsField.offset)
      )) {
        const path = readCString(file, block.bodyStart + pathField.offset, pathField.byteSize)
        if (path) scriptDirectories.push(path)
      }
    }
  } else {
    const legacyField = findField(file, userStructIndex, ['pythondir'])
    if (legacyField && !legacyField.rawName.startsWith('*')) {
      const path = readCString(file, userBlock.bodyStart + legacyField.offset, legacyField.byteSize)
      if (path) scriptDirectories.push(path)
    }
  }

  // extension repositories (4.2+): UserDef.extension_repos -> bUserExtensionRepo
  const extensionRepos: ParsedExtensionRepo[] = []
  const reposField = findField(file, userStructIndex, ['extension_repos'])
  if (reposField) {
    const repoStructIndex = structIndexByName(file, 'bUserExtensionRepo')
    if (repoStructIndex !== null) {
      const nameField = findField(file, repoStructIndex, ['name'])
      const moduleF = findField(file, repoStructIndex, ['module']) ?? fail('repo module missing')
      const dirField = findField(file, repoStructIndex, ['custom_dirpath', 'dirpath', 'custom_directory'])
      const urlField = findField(file, repoStructIndex, ['remote_url', 'remote_path'])
      const flagField = findField(file, repoStructIndex, ['flag'])
      const sourceField = findField(file, repoStructIndex, ['source'])
      for (const block of walkList(
        file,
        repoStructIndex,
        readPointer(file, userBlock.bodyStart + reposField.offset)
      )) {
        const module = readCString(file, block.bodyStart + moduleF.offset, moduleF.byteSize)
        if (!module) continue
        extensionRepos.push({
          name: nameField ? readCString(file, block.bodyStart + nameField.offset, nameField.byteSize) : module,
          module,
          flag: flagField ? readIntField(file, block.bodyStart, flagField) : 0,
          source: sourceField ? readIntField(file, block.bodyStart, sourceField) : 0,
          customDirectory: dirField
            ? readCString(file, block.bodyStart + dirField.offset, dirField.byteSize) || null
            : null,
          remoteUrl: urlField
            ? readCString(file, block.bodyStart + urlField.offset, urlField.byteSize) || null
            : null
        })
      }
    }
  }

  return { versionCode: file.versionCode, enabledModules, scriptDirectories, extensionRepos }
}

// --- semantic canonical dump (settings-sync drift detection) ---------------
//
// A .blend re-save with IDENTICAL preferences still changes bytes: every BHead
// carries the writing process's heap address for the block, and those churn per
// run. So the Sync tab must not compare userpref.blend byte-by-byte. This dump
// serializes everything reachable from the UserDef block — field names from the
// file's own DNA, pointers dereferenced but their VALUES never emitted — into a
// deterministic string: identical preferences → identical canonical text.
// Anything structurally unexpected THROWS, and the caller falls back to byte
// hashing (never a wrong identity, only a noisier one).

/** compact identity of one userpref.blend, stored in sync baselines for diffs */
export interface PrefsProfile {
  /** version code from the header — informational, never part of the identity */
  version: number
  /** composite top-level UserDef fields (themes, keymaps, addons…) → short hash */
  sections: Record<string, string>
  /** scalar/string leaves (embedded structs flattened) → the actual value */
  values: Record<string, string | number>
}

export interface SemanticUserpref {
  canonical: string
  profile: PrefsProfile
}

// Saved by Blender but not a user choice — every one of these can change from a
// plain open-and-close of Preferences, a different monitor, or clicking around,
// so they are excluded from the semantic identity. Verified against
// DNA_userdef_types.h (main): /* Runtime */ members, deprecated leftovers, and
// persisted UI/session state.
const VOLATILE_USERDEF_FIELDS = new Set([
  'versionfile', // version stamp of whichever build saved the file
  'subversionfile',
  'space_data', // active Preferences tab
  'file_space_data', // last file-dialog display settings
  'stored_bounds', // temp window rectangles
  'runtime', // UserDef_Runtime (is_dirty) — a GUI save vs headless save differs here
  'dpi', // runtime-computed, follows the monitor
  'scale_factor',
  'inv_scale_factor',
  'pixelsize',
  'widget_unit',
  'virtual_pixel', // deprecated/unused leftovers
  'pythondir_legacy',
  'gpu_viewport_quality',
  'prefetchframes',
  'active_extension_repo', // list-selection indices in the Preferences UI
  'active_asset_library',
  'edit_studio_light' // "edit studio lights" UI mode toggle, not a setting
])

// The enabled-add-on list is excluded DELIBERATELY, not because it is noise:
// the Sync tab never changes it (the mandatory fixup restores each target's own
// set), and the launcher's own Add-ons tab rewrites userpref.blend on every
// toggle — counting that as settings drift would flag every add-ons operation.
// Add-on state is the Add-ons tab's territory, in drift detection too.
const SYNC_IGNORED_USERDEF_FIELDS = new Set(['addons'])

const shortHash = (text: string): string =>
  createHash('sha256').update(text).digest('hex').slice(0, 16)

type CanonValue = string | number | null | CanonValue[] | { [field: string]: CanonValue }

interface WalkContext {
  file: BlendFile
  /** struct index per type name — embedded-struct fields resolve through this */
  structByType: Map<string, number>
  /** cached offset of each struct's `next` pointer (list plumbing) */
  nextOffsets: Map<number, number | null>
  /** pointer-recursion path — cycle guard */
  path: Set<bigint>
  nodes: number
}

const dimsOf = (name: string): number[] =>
  [...name.matchAll(/\[(\d+)\]/g)].map((match) => Number(match[1]))

function readScalar(file: BlendFile, typeName: string, size: number, at: number): number | string {
  const buf = file.buffer
  if (typeName === 'float') return buf.readFloatLE(at)
  if (typeName === 'double') return buf.readDoubleLE(at)
  const unsigned = typeName.startsWith('u')
  if (size === 1) return unsigned ? buf.readUInt8(at) : buf.readInt8(at)
  if (size === 2) return unsigned ? buf.readUInt16LE(at) : buf.readInt16LE(at)
  if (size === 4) return unsigned ? buf.readUInt32LE(at) : buf.readInt32LE(at)
  if (size === 8) {
    const wide = unsigned ? buf.readBigUInt64LE(at) : buf.readBigInt64LE(at)
    const asNumber = Number(wide)
    return BigInt(asNumber) === wide ? asNumber : wide.toString()
  }
  return fail(`unsupported scalar ${typeName}[${size}]`)
}

function nextOffsetOf(ctx: WalkContext, structIndex: number): number | null {
  let cached = ctx.nextOffsets.get(structIndex)
  if (cached === undefined) {
    cached = null
    // DNA "inheritance": next/prev may live in an embedded base struct at offset 0
    // (bUserMenuItem_Op { bUserMenuItem item; … } — item carries the links)
    let index = structIndex
    for (let depth = 0; depth < 4; depth++) {
      const found = findField(ctx.file, index, ['next'])
      if (found?.rawName.startsWith('*')) {
        cached = found.offset
        break
      }
      const firstField = ctx.file.dna.structs[index].fields[0]
      if (!firstField) break
      const rawName = ctx.file.dna.names[firstField.nameIndex]
      if (rawName.startsWith('*') || dimsOf(rawName).length > 0) break
      const nested = ctx.structByType.get(ctx.file.dna.types[firstField.typeIndex])
      if (nested === undefined) break
      index = nested // still offset 0 — the base struct is the first member
    }
    ctx.nextOffsets.set(structIndex, cached)
  }
  return cached
}

/** serialize a ListBase chain: each element by its block's own struct type */
function serializeList(ctx: WalkContext, first: bigint): CanonValue[] {
  const { file } = ctx
  const out: CanonValue[] = []
  const seen = new Set<bigint>()
  let current = first
  while (current !== 0n) {
    if (seen.has(current)) fail('cyclic list in preferences')
    seen.add(current)
    if (out.length >= 8192) fail('preferences list too long')
    // stale runtime pointers get saved inside structs (e.g. IDProperty's unused
    // list heads) — Blender's own loader NULLs whatever it cannot resolve, so a
    // dangling address means "not saved", never "lost data": end of chain
    const block = file.byAddress.get(current)
    if (!block) break
    if (block.sdnaIndex <= 0) fail('untyped list element block')
    const elementSize = file.dna.typeLengths[file.dna.structs[block.sdnaIndex].typeIndex]
    if (block.length < elementSize) fail('list element block too small')
    out.push(serializeStruct(ctx, block.sdnaIndex, block.bodyStart))
    const nextOffset =
      nextOffsetOf(ctx, block.sdnaIndex) ??
      fail(`list struct ${file.dna.types[file.dna.structs[block.sdnaIndex].typeIndex]} has no next`)
    current = readPointer(file, block.bodyStart + nextOffset)
  }
  return out
}

function resolvePointer(ctx: WalkContext, address: bigint, declaredType: string): CanonValue {
  if (address === 0n) return null
  const { file } = ctx
  const block = file.byAddress.get(address)
  // a pointer whose block was never written is session noise, not saved data
  if (!block) return null
  if (ctx.path.has(address)) return '<cycle>'
  if (ctx.path.size > 32) fail('pointer chain too deep')
  ctx.path.add(address)
  try {
    if (block.sdnaIndex > 0) {
      const structIndex = block.sdnaIndex
      const elementSize = file.dna.typeLengths[file.dna.structs[structIndex].typeIndex]
      const count = block.nr > 0 ? block.nr : 1
      if (elementSize <= 0 || block.length < elementSize * count) {
        fail('typed block smaller than its struct array')
      }
      const items: CanonValue[] = []
      for (let i = 0; i < count; i++) {
        items.push(serializeStruct(ctx, structIndex, block.bodyStart + i * elementSize))
      }
      return count === 1 ? items[0] : items
    }
    // untyped DATA: char* payloads are C strings, the rest is opaque bytes
    if (declaredType === 'char') return readCString(file, block.bodyStart, block.length)
    return block.length <= 64
      ? file.buffer.toString('hex', block.bodyStart, block.bodyStart + block.length)
      : createHash('sha256')
          .update(file.buffer.subarray(block.bodyStart, block.bodyStart + block.length))
          .digest('hex')
  } finally {
    ctx.path.delete(address)
  }
}

function serializeStruct(
  ctx: WalkContext,
  structIndex: number,
  bodyStart: number,
  skip?: Set<string>
): Record<string, CanonValue> {
  const { file } = ctx
  const struct = file.dna.structs[structIndex] ?? fail('bad struct index')
  const out: Record<string, CanonValue> = {}
  let offset = 0
  for (const field of struct.fields) {
    const rawName = file.dna.names[field.nameIndex]
    const size = fieldSize(file, field)
    const at = bodyStart + offset
    offset += size
    const name = baseNameOf(rawName)
    if (skip?.has(name)) continue
    if (/^_?pad\d*$/.test(name) || rawName.startsWith('(')) continue
    if (name === 'next' || name === 'prev') continue // list plumbing — the chain itself is the data
    if (++ctx.nodes > 2_000_000) fail('preferences too large to canonicalize')
    const typeName = file.dna.types[field.typeIndex]
    if (rawName.startsWith('*')) {
      if (rawName.startsWith('**')) continue // pointer-to-pointer never carries saved prefs
      const count = arrayLenOf(rawName)
      const refs: CanonValue[] = []
      for (let i = 0; i < count; i++) {
        refs.push(resolvePointer(ctx, readPointer(file, at + i * file.pointerSize), typeName))
      }
      out[name] = count === 1 ? refs[0] : refs
      continue
    }
    const elementSize = file.dna.typeLengths[field.typeIndex]
    if (typeName === 'ListBase') {
      const count = arrayLenOf(rawName)
      const lists: CanonValue[] = []
      for (let i = 0; i < count; i++) {
        lists.push(serializeList(ctx, readPointer(file, at + i * elementSize)))
      }
      out[name] = count === 1 ? lists[0] : lists
      continue
    }
    const nestedIndex = ctx.structByType.get(typeName)
    if (nestedIndex !== undefined) {
      const count = arrayLenOf(rawName)
      const items: CanonValue[] = []
      for (let i = 0; i < count; i++) {
        items.push(serializeStruct(ctx, nestedIndex, at + i * elementSize))
      }
      out[name] = count === 1 ? items[0] : items
      continue
    }
    const dims = dimsOf(rawName)
    if (typeName === 'char' && dims.length > 0) {
      // char arrays are C strings (bytes past the NUL are uninitialized noise);
      // a 2D char array is a list of strings
      if (dims.length === 1) {
        out[name] = readCString(file, at, size)
      } else {
        const rowLength = dims[dims.length - 1]
        const rows = dims.slice(0, -1).reduce((total, dim) => total * dim, 1)
        const texts: CanonValue[] = []
        for (let i = 0; i < rows; i++) texts.push(readCString(file, at + i * rowLength, rowLength))
        out[name] = texts
      }
      continue
    }
    const count = arrayLenOf(rawName)
    if (count === 1) {
      out[name] = readScalar(file, typeName, elementSize, at)
    } else {
      const numbers: CanonValue[] = []
      for (let i = 0; i < count; i++) {
        numbers.push(readScalar(file, typeName, elementSize, at + i * elementSize))
      }
      out[name] = numbers
    }
  }
  return out
}

/** flatten scalar leaves into dotted keys for exact before→after diff lines */
function flattenValue(
  values: Record<string, string | number>,
  prefix: string,
  node: CanonValue,
  depth = 0
): void {
  if (Object.keys(values).length >= 2000) return // profile stays a summary, not a dump
  if (node === null) {
    values[prefix] = 'null'
  } else if (typeof node === 'number') {
    values[prefix] = node
  } else if (typeof node === 'string') {
    values[prefix] = node.length > 200 ? `${node.slice(0, 200)}…` : node
  } else if (Array.isArray(node)) {
    if (node.length <= 16 && node.every((item) => typeof item === 'number')) {
      values[prefix] = node.join(',')
    } else if (depth >= 5) {
      values[prefix] = shortHash(JSON.stringify(node))
    } else {
      node.forEach((item, index) => flattenValue(values, `${prefix}.${index}`, item, depth + 1))
    }
  } else if (depth >= 5) {
    values[prefix] = shortHash(JSON.stringify(node))
  } else {
    for (const [key, child] of Object.entries(node)) {
      flattenValue(values, `${prefix}.${key}`, child, depth + 1)
    }
  }
}

export function userprefSemanticFromBuffer(data: Buffer): SemanticUserpref {
  const file = parseAllBlocks(decompressBlend(data))
  const { userBlock, userStructIndex } = findUserBlock(file)
  const ctx: WalkContext = {
    file,
    structByType: new Map(
      file.dna.structs.map((struct, index) => [file.dna.types[struct.typeIndex], index] as const)
    ),
    nextOffsets: new Map(),
    path: new Set(),
    nodes: 0
  }
  const skip = new Set([...VOLATILE_USERDEF_FIELDS, ...SYNC_IGNORED_USERDEF_FIELDS])
  const tree = serializeStruct(ctx, userStructIndex, userBlock.bodyStart, skip)

  // classify top-level fields: composites get a per-section hash (names the drift),
  // scalars and embedded structs land in values (exact before → after lines)
  const sections: Record<string, string> = {}
  const values: Record<string, string | number> = {}
  const struct = file.dna.structs[userStructIndex]
  for (const field of struct.fields) {
    const rawName = file.dna.names[field.nameIndex]
    const name = baseNameOf(rawName)
    if (!(name in tree)) continue
    const typeName = file.dna.types[field.typeIndex]
    if (rawName.startsWith('*') || typeName === 'ListBase') {
      sections[name] = shortHash(JSON.stringify(tree[name]))
    } else {
      flattenValue(values, name, tree[name])
    }
  }
  return {
    canonical: JSON.stringify(tree),
    profile: { version: file.versionCode, sections, values }
  }
}

export async function readUserprefSemantic(filePath: string): Promise<SemanticUserpref> {
  return userprefSemanticFromBuffer(await readFile(filePath))
}
