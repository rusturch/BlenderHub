import { copyFile, cp, mkdir, readdir, readFile, rm, stat } from 'fs/promises'
import { createReadStream } from 'fs'
import type { Stats } from 'fs'
import { createHash } from 'crypto'
import { dirname, join } from 'path'
import { userprefSemanticFromBuffer } from '../addons/userpref-parser'
import type { PrefsProfile } from '../addons/userpref-parser'
import type { SyncComponentId, SyncComponentState } from '../../shared/types'

// What one settings component means on disk, relative to a version's user base
// (…/Blender/<M.m>). Only these whitelisted paths are ever read or written —
// extensions/ and scripts/addons* stay the Add-ons tab's territory; caches,
// autosave and platform_support.txt are per-machine noise and never travel.
type ComponentEntry =
  | { kind: 'file'; rel: string[] }
  | { kind: 'dir'; rel: string[] }
  // config/<app template>/<name> — app templates keep their own startup/prefs
  | { kind: 'templateFile'; name: string }

const COMPONENT_SPECS: Record<SyncComponentId, ComponentEntry[]> = {
  preferences: [
    { kind: 'file', rel: ['config', 'userpref.blend'] },
    { kind: 'templateFile', name: 'userpref.blend' }
  ],
  startup: [
    { kind: 'file', rel: ['config', 'startup.blend'] },
    { kind: 'templateFile', name: 'startup.blend' }
  ],
  bookmarks: [{ kind: 'file', rel: ['config', 'bookmarks.txt'] }],
  recent: [
    { kind: 'file', rel: ['config', 'recent-files.txt'] },
    { kind: 'file', rel: ['config', 'recent-searches.txt'] }
  ],
  presets: [{ kind: 'dir', rel: ['scripts', 'presets'] }],
  scripts: [
    { kind: 'dir', rel: ['scripts', 'startup'] },
    { kind: 'dir', rel: ['scripts', 'modules'] },
    { kind: 'dir', rel: ['scripts', 'templates_py'] },
    { kind: 'dir', rel: ['scripts', 'templates_osl'] }
  ],
  datafiles: [{ kind: 'dir', rel: ['datafiles'] }]
}

/** a concrete file/dir that exists under a base for a component */
export interface ResolvedItem {
  kind: 'file' | 'dir'
  rel: string[]
}

async function statOrNull(path: string): Promise<Stats | null> {
  try {
    return await stat(path)
  } catch {
    return null
  }
}

/** resolve a component's spec to the files/dirs that actually exist under `base` */
export async function expandEntries(base: string, component: SyncComponentId): Promise<ResolvedItem[]> {
  const items: ResolvedItem[] = []
  for (const entry of COMPONENT_SPECS[component]) {
    if (entry.kind === 'templateFile') {
      // depth-1 only: probe the exact file name inside each config/ subdir,
      // so unrelated subfolders are never read or copied
      let subdirs: string[] = []
      try {
        subdirs = (await readdir(join(base, 'config'), { withFileTypes: true }))
          .filter((sub) => sub.isDirectory())
          .map((sub) => sub.name)
      } catch {
        subdirs = []
      }
      for (const sub of subdirs) {
        const found = await statOrNull(join(base, 'config', sub, entry.name))
        if (found?.isFile()) items.push({ kind: 'file', rel: ['config', sub, entry.name] })
      }
      continue
    }
    const found = await statOrNull(join(base, ...entry.rel))
    if (entry.kind === 'file' ? found?.isFile() : found?.isDirectory()) {
      items.push({ kind: entry.kind, rel: entry.rel })
    }
  }
  return items
}

// sizing walker: symlinks count as one zero-byte entry and are never followed
// (a link into a media library must not inflate sizes or loop the walk)
async function measureTree(path: string): Promise<{ bytes: number; files: number }> {
  let bytes = 0
  let files = 0
  let entries
  try {
    entries = await readdir(path, { withFileTypes: true })
  } catch {
    return { bytes, files }
  }
  for (const entry of entries) {
    const child = join(path, entry.name)
    if (entry.isSymbolicLink()) {
      files += 1
    } else if (entry.isDirectory()) {
      const sub = await measureTree(child)
      bytes += sub.bytes
      files += sub.files
    } else if (entry.isFile()) {
      bytes += (await statOrNull(child))?.size ?? 0
      files += 1
    }
  }
  return { bytes, files }
}

export async function measureComponent(base: string, component: SyncComponentId): Promise<SyncComponentState> {
  const items = await expandEntries(base, component)
  let bytes = 0
  let fileCount = 0
  for (const item of items) {
    if (item.kind === 'file') {
      bytes += (await statOrNull(join(base, ...item.rel)))?.size ?? 0
      fileCount += 1
    } else {
      const sub = await measureTree(join(base, ...item.rel))
      bytes += sub.bytes
      fileCount += sub.files
    }
  }
  return { present: items.length > 0, bytes, fileCount }
}

export interface FileStamp {
  rel: string
  size: number
  mtimeMs: number
}

export interface ComponentFingerprint {
  /** null — the component does not exist under this base */
  hash: string | null
  /**
   * preferences only: the byte-level hash, kept alongside the semantic hash so
   * baselines recorded before the semantic upgrade still match (an app update
   * must never flag every cell as "changed")
   */
  rawHash?: string
  /** dir components: the file manifest behind the hash (null when over the cap) */
  files: FileStamp[] | null
  /** preferences only: parsed profile of config/userpref.blend for exact diffs */
  prefs?: PrefsProfile
  /** bookmarks only: entries of the [Bookmarks] section for exact diffs */
  lines?: string[]
}

/** does a stored baseline hash match this fingerprint? (accepts pre-semantic byte hashes) */
export const fingerprintMatches = (stored: string, fp: ComponentFingerprint): boolean =>
  stored === fp.hash || (fp.rawHash !== undefined && stored === fp.rawHash)

// manifests are stored in sync-state.json for "what changed" summaries — cap them
// so a giant datafiles tree cannot bloat the state file (hash-only above the cap)
const MANIFEST_CAP = 500

async function collectStamps(root: string, rel: string[], out: FileStamp[]): Promise<void> {
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    const childRel = [...rel, entry.name]
    if (entry.isSymbolicLink()) {
      out.push({ rel: childRel.join('/'), size: 0, mtimeMs: 0 })
    } else if (entry.isDirectory()) {
      // python bytecode caches regenerate whenever Blender runs the scripts —
      // counting them would flag drift from merely USING a preset
      if (entry.name === '__pycache__') continue
      await collectStamps(join(root, entry.name), childRel, out)
    } else if (entry.isFile()) {
      const found = await statOrNull(join(root, entry.name))
      if (found) out.push({ rel: childRel.join('/'), size: found.size, mtimeMs: Math.round(found.mtimeMs) })
    }
  }
}

const SEMANTIC_PREFIX = 'sem1:'

/**
 * Preferences get a SEMANTIC identity: .blend bytes churn on every save (BHead
 * block addresses are heap pointers), so opening-and-closing Preferences would
 * read as "changed" under a byte hash. The DNA-level canonical dump is stable
 * across such re-saves. The byte hash is still computed (rawHash) so baselines
 * from before this upgrade keep matching; if any file fails to parse, the whole
 * component falls back to the plain byte hash — never a wrong identity.
 */
async function fingerprintPreferences(
  base: string,
  items: ResolvedItem[]
): Promise<ComponentFingerprint> {
  const raw = createHash('sha256')
  const semantic = createHash('sha256')
  let parsedAll = true
  let prefs: PrefsProfile | undefined
  for (const item of items) {
    const rel = item.rel.join('/')
    raw.update(rel)
    semantic.update(rel)
    let data: Buffer
    try {
      data = await readFile(join(base, ...item.rel))
    } catch {
      raw.update('<unreadable>')
      parsedAll = false
      continue
    }
    raw.update(data)
    try {
      const dump = userprefSemanticFromBuffer(data)
      semantic.update(dump.canonical)
      if (rel === 'config/userpref.blend') prefs = dump.profile
    } catch {
      parsedAll = false
    }
  }
  const rawHex = raw.digest('hex')
  if (!parsedAll) return { hash: rawHex, files: null }
  return {
    hash: SEMANTIC_PREFIX + semantic.digest('hex'),
    rawHash: rawHex,
    files: null,
    ...(prefs ? { prefs } : {})
  }
}

/**
 * bookmarks.txt holds TWO sections: [Bookmarks] (the user's saved bookmarks) and
 * [Recent] (the file dialog's folder history, rewritten by merely browsing).
 * Only [Bookmarks] is a setting — the identity ignores [Recent] entirely.
 * Entries: an optional "!Custom Name" line precedes its path line.
 */
export function parseBookmarkEntries(text: string): string[] {
  const out: string[] = []
  let inBookmarks = false
  let pendingName: string | null = null
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line.length === 0) continue
    if (line.startsWith('[')) {
      inBookmarks = line === '[Bookmarks]'
      pendingName = null
      continue
    }
    if (!inBookmarks) continue
    if (line.startsWith('!')) {
      pendingName = line.slice(1)
      continue
    }
    out.push(pendingName ? `${pendingName} — ${line}` : line)
    pendingName = null
  }
  return out
}

async function fingerprintBookmarks(
  base: string,
  items: ResolvedItem[]
): Promise<ComponentFingerprint> {
  const raw = createHash('sha256')
  const semantic = createHash('sha256')
  let readAll = true
  let lines: string[] | undefined
  for (const item of items) {
    const rel = item.rel.join('/')
    raw.update(rel)
    semantic.update(rel)
    let data: Buffer
    try {
      data = await readFile(join(base, ...item.rel))
    } catch {
      raw.update('<unreadable>')
      readAll = false
      continue
    }
    raw.update(data)
    const entries = parseBookmarkEntries(data.toString('utf8'))
    semantic.update(entries.join('\n'))
    if (rel === 'config/bookmarks.txt') lines = entries
  }
  const rawHex = raw.digest('hex')
  if (!readAll) return { hash: rawHex, files: null }
  return {
    hash: SEMANTIC_PREFIX + semantic.digest('hex'),
    rawHash: rawHex,
    files: null,
    ...(lines ? { lines } : {})
  }
}

/**
 * Content identity of a component for drift detection. Preferences are compared
 * semantically (see above); bookmarks by their [Bookmarks] section only; other
 * file components hash the actual bytes (a startup.blend rewrite only happens on
 * an explicit "Save Startup File"). Dir components hash a sorted (path, size,
 * mtime) manifest — cheap even for huge datafiles.
 */
export async function fingerprintComponent(
  base: string,
  component: SyncComponentId
): Promise<ComponentFingerprint> {
  const items = await expandEntries(base, component)
  if (items.length === 0) return { hash: null, files: null }
  if (component === 'preferences') return fingerprintPreferences(base, items)
  if (component === 'bookmarks') return fingerprintBookmarks(base, items)
  const hash = createHash('sha256')
  const stamps: FileStamp[] = []
  let hasDir = false
  for (const item of items) {
    if (item.kind === 'file') {
      hash.update(item.rel.join('/'))
      try {
        for await (const chunk of createReadStream(join(base, ...item.rel))) hash.update(chunk as Buffer)
      } catch {
        hash.update('<unreadable>')
      }
    } else {
      hasDir = true
      await collectStamps(join(base, ...item.rel), item.rel, stamps)
    }
  }
  if (hasDir) {
    stamps.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
    for (const stamp of stamps) hash.update(`${stamp.rel}|${stamp.size}|${stamp.mtimeMs}\n`)
  }
  return { hash: hash.digest('hex'), files: hasDir && stamps.length <= MANIFEST_CAP ? stamps : null }
}

/**
 * Copy resolved items from one base to another. Directories are REPLACED (sync
 * semantics — the target subtree becomes an exact copy), so callers must snapshot
 * the target first. Symlinks are copied as links, never dereferenced.
 */
export async function copyComponentItems(fromBase: string, toBase: string, items: ResolvedItem[]): Promise<void> {
  for (const item of items) {
    const from = join(fromBase, ...item.rel)
    const to = join(toBase, ...item.rel)
    if (item.kind === 'file') {
      await mkdir(dirname(to), { recursive: true })
      await copyFile(from, to)
    } else {
      await rm(to, { recursive: true, force: true })
      await mkdir(dirname(to), { recursive: true })
      await cp(from, to, { recursive: true })
    }
  }
}
