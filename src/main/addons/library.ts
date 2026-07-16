import { createHash } from 'crypto'
import { createReadStream } from 'fs'
import { copyFile, cp, mkdir, readFile, rename, rm, stat, writeFile } from 'fs/promises'
import { pipeline } from 'stream/promises'
import { shell } from 'electron'
import { basename, extname, join, resolve } from 'path'
import { getDataRoot } from '../paths'
import { readConfig, updateConfig } from '../config'
import { parseBlInfo, parseManifest } from './addon-meta'
import { listZipEntries, readZipEntryBytes, readZipEntryText } from './zip-util'
import { buildZip } from './zip-write'
import type { ZipInput } from './zip-write'
import { minorOf } from '../../shared/blender-archive'
import { compareVersionsDesc } from '../../shared/blender-builds'
import type { LibraryAddon } from '../../shared/types'

// The add-on library keeps a COPY of each add-on file under the launcher's data root,
// so wiping every Blender install (or installing a fresh version) never loses them.
// Files are hashed on add and re-verified before every install.

const defaultLibraryRoot = (): string => join(getDataRoot(), 'addon-library')
const libraryRoot = async (): Promise<string> =>
  (await readConfig()).addonLibraryDir || defaultLibraryRoot()
const entryDir = async (id: string): Promise<string> => join(await libraryRoot(), id)

export async function getLibraryDir(): Promise<string> {
  return libraryRoot()
}

// Unlike installsDir, changing this path MOVES the stored files: library entries are
// addressed by id relative to the root, so files left behind would break every entry.
export async function setLibraryDir(path: string): Promise<string> {
  const oldRoot = await libraryRoot()
  if (resolve(path) === resolve(oldRoot)) return path
  await mkdir(path, { recursive: true })
  for (const entry of await listLibrary()) {
    const from = join(oldRoot, entry.id)
    const to = join(path, entry.id)
    try {
      await rename(from, to)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue // already gone
      // cross-drive move: rename fails with EXDEV — copy then delete
      await cp(from, to, { recursive: true })
      await rm(from, { recursive: true, force: true })
    }
  }
  await updateConfig((config) => ({ ...config, addonLibraryDir: path }))
  return path
}

export async function resetLibraryDir(): Promise<string> {
  await setLibraryDir(defaultLibraryRoot())
  await updateConfig((config) => ({ ...config, addonLibraryDir: undefined }))
  return defaultLibraryRoot()
}

// Installing into Blender happens in batch.ts (one headless run per version). This module
// only stores, verifies and describes the files.

/** the extensions system (and its CLI) exists from Blender 4.2 */
const EXTENSIONS_SINCE = '4.2'

async function hashFile(path: string): Promise<string> {
  const hash = createHash('sha256')
  await pipeline(createReadStream(path), hash)
  return hash.digest('hex')
}

/** version >= base for "major.minor(.patch)" strings */
const atLeast = (version: string, base: string): boolean => compareVersionsDesc(version, base) <= 0

// --- file parsing ---------------------------------------------------------

interface ParsedAddon {
  format: LibraryAddon['format']
  moduleId: string
  name: string
  version: string | null
  minBlender: string | null
  maxBlender: string | null
}

function parseLegacySource(text: string, moduleId: string): ParsedAddon {
  const meta = parseBlInfo(text)
  return {
    format: 'legacy',
    moduleId,
    name: meta.name || moduleId,
    version: meta.version,
    minBlender: meta.minBlender,
    // bl_info has no upper bound — legacy add-ons declare only a minimum
    maxBlender: null
  }
}

/** thrown when a file with identical bytes is already stored — callers treat it as a skip, not a failure */
export const DUPLICATE_ERROR = 'This exact file is already in the library'

const zipDepth = (name: string): number => name.split('/').length

async function parseAddonFile(path: string): Promise<ParsedAddon> {
  const ext = extname(path).toLowerCase()
  if (ext === '.py') {
    const text = await readFile(path, 'utf8')
    return parseLegacySource(text, basename(path, '.py'))
  }
  if (ext !== '.zip') throw new Error('Only .zip and .py add-on files are supported')

  const entries = (await listZipEntries(path)).filter((entry) => !entry.name.endsWith('/'))

  // 4.2+ extension: blender_manifest.toml at any depth (GitHub zips nest it in a wrapper dir).
  // The shallowest one wins — that's the real extension root.
  const manifests = entries
    .filter((entry) => entry.name === 'blender_manifest.toml' || entry.name.endsWith('/blender_manifest.toml'))
    .sort((a, b) => zipDepth(a.name) - zipDepth(b.name))
  if (manifests.length > 0) {
    const meta = parseManifest(await readZipEntryText(path, manifests[0]))
    if (!meta.id) throw new Error('The extension manifest has no id')
    return {
      format: 'extension',
      moduleId: meta.id,
      name: meta.name || meta.id,
      version: meta.version,
      minBlender: meta.minBlender,
      maxBlender: meta.maxBlender
    }
  }
  // __init__.py at the archive root: Blender can't register a loose root module, but the add-on is
  // real — normalizeAddonZip wraps it in a folder named after the file so it installs cleanly.
  const rootInit = entries.find((entry) => entry.name === '__init__.py')
  if (rootInit) {
    const text = await readZipEntryText(path, rootInit).catch(() => '')
    return parseLegacySource(text, wrapFolderName(path))
  }
  // legacy package: a folder with __init__.py, at any depth (shallowest wins). normalizeAddonZip
  // strips any GitHub wrapper before storing, so the package installs cleanly.
  const pkgInits = entries
    .filter((entry) => entry.name.endsWith('/__init__.py'))
    .sort((a, b) => zipDepth(a.name) - zipDepth(b.name))
  if (pkgInits.length > 0) {
    const parts = pkgInits[0].name.split('/')
    const moduleId = parts[parts.length - 2] // the folder that directly holds __init__.py
    const text = await readZipEntryText(path, pkgInits[0]).catch(() => '')
    return parseLegacySource(text, moduleId)
  }
  // legacy loose .py: GitHub zips wrap the file in a <repo>-<branch>/ folder and may ship helper
  // modules beside it — prefer the .py that declares a bl_info dict; fall back to a lone .py.
  const pyEntries = entries.filter((entry) => /\.py$/i.test(entry.name)).slice(0, 200)
  if (pyEntries.length > 0) {
    let fallback: { name: string; text: string } | null = null
    for (const entry of pyEntries) {
      const text = await readZipEntryText(path, entry).catch(() => '')
      if (/\bbl_info\s*=/.test(text)) return parseLegacySource(text, basename(entry.name, '.py'))
      if (!fallback) fallback = { name: entry.name, text }
    }
    if (pyEntries.length === 1 && fallback) {
      return parseLegacySource(fallback.text, basename(fallback.name, '.py'))
    }
  }
  // a bundle of only nested .zip files (e.g. several packaged versions) — addToLibrary resolves
  // these before we get here, so reaching this point means it could not pick one
  if (entries.length > 0 && entries.every((entry) => /\.zip$/i.test(entry.name))) {
    throw new Error('This zip only contains other .zip files — unzip it and add the add-on inside')
  }
  // only .blend files (an asset / setup file), no Python — not an installable add-on
  if (entries.some((entry) => /\.blend$/i.test(entry.name))) {
    throw new Error('This contains only .blend files, not an installable Python add-on')
  }
  throw new Error('This file does not look like a Blender add-on or extension')
}

/** folder name to wrap a root-level module in — the file name without its .zip extension */
const wrapFolderName = (path: string): string => basename(path).replace(/\.zip$/i, '') || 'addon'

// GitHub "Download ZIP" (and some packagers) wrap the whole add-on in one top-level folder like
// "repo-main/". Blender's addon_install extracts the archive verbatim, so that wrapper becomes a
// folder WITHOUT __init__.py and nothing registers. Repack with the wrapper peeled off so the
// add-on's own root becomes the archive root. Returns null when the archive is already canonical.
async function normalizeAddonZip(path: string): Promise<Buffer | null> {
  const entries = (await listZipEntries(path)).filter((entry) => !entry.name.endsWith('/'))
  if (entries.length === 0) return null
  const total = entries.reduce((sum, entry) => sum + entry.uncompressedSize, 0)
  if (total > 256 * 1024 * 1024) return null // too big to repack in memory — store as-is

  // __init__.py at the archive root: Blender needs the module inside a folder, so wrap everything
  // in one named after the file. (Peeling below never applies here — there is no wrapper dir.)
  if (entries.some((entry) => entry.name === '__init__.py')) {
    const folder = wrapFolderName(path)
    const wrapped: ZipInput[] = []
    for (const entry of entries) {
      wrapped.push({ arcName: `${folder}/${entry.name}`, data: await readZipEntryBytes(path, entry) })
    }
    return buildZip(wrapped)
  }

  let prefix = ''
  for (;;) {
    const rest = entries.map((entry) => entry.name.slice(prefix.length))
    if (rest.some((name) => !name.includes('/'))) break // a root-level file → already at the root
    const tops = new Set(rest.map((name) => name.slice(0, name.indexOf('/'))))
    if (tops.size !== 1) break // more than one top-level dir → not a single wrapper
    const dir = [...tops][0]
    // a plain legacy package dir (has __init__.py, no manifest) must stay a folder; an extension
    // wrapper (has a manifest) should be peeled so the manifest reaches the archive root
    const hasManifest = rest.includes(`${dir}/blender_manifest.toml`)
    if (!hasManifest && rest.includes(`${dir}/__init__.py`)) break
    prefix += `${dir}/`
  }
  if (!prefix) return null
  const inputs: ZipInput[] = []
  for (const entry of entries) {
    const arcName = entry.name.slice(prefix.length)
    if (arcName) inputs.push({ arcName, data: await readZipEntryBytes(path, entry) })
  }
  return buildZip(inputs)
}

// Some downloads bundle the add-on as a nested .zip: several packaged versions (BlenderMarket), or
// one add-on zip beside engine installers / docs (e.g. UVPackmaster). Extract the best inner zip to
// a temp file so the real add-on can be stored. Only acts when the archive has NO add-on of its own
// (no manifest/__init__/.py) — otherwise it IS the add-on. Returns null for a normal archive.
async function resolveInnerAddonZip(path: string): Promise<{ tempPath: string; innerName: string } | null> {
  const entries = (await listZipEntries(path)).filter((entry) => !entry.name.endsWith('/'))
  if (entries.length === 0) return null
  const hasDirectAddon = entries.some(
    (entry) =>
      entry.name === '__init__.py' ||
      entry.name.endsWith('/__init__.py') ||
      entry.name === 'blender_manifest.toml' ||
      entry.name.endsWith('/blender_manifest.toml') ||
      /\.py$/i.test(entry.name)
  )
  if (hasDirectAddon) return null
  const zips = entries.filter((entry) => /\.zip$/i.test(entry.name))
  if (zips.length === 0) return null
  // a pure bundle → pick the best (top-level, latest version); junk + exactly one zip → take it;
  // junk + several zips is ambiguous, so leave it for a clear "unzip it" message
  if (zips.length !== entries.length && zips.length !== 1) return null
  const best = [...zips].sort((a, b) => {
    const byDepth = zipDepth(a.name) - zipDepth(b.name)
    if (byDepth !== 0) return byDepth
    // higher name last-in-sort → reverse so the latest version wins ("2_0" over "1_0")
    return a.name < b.name ? 1 : a.name > b.name ? -1 : 0
  })[0]
  const bytes = await readZipEntryBytes(path, best)
  const tempPath = join(
    await libraryRoot(),
    `.incoming-${createHash('sha256').update(bytes).digest('hex').slice(0, 12)}.zip`
  )
  await mkdir(await libraryRoot(), { recursive: true })
  await writeFile(tempPath, bytes)
  return { tempPath, innerName: basename(best.name) }
}

// --- library CRUD ---------------------------------------------------------

export async function listLibrary(): Promise<LibraryAddon[]> {
  const library = (await readConfig()).addonLibrary
  // heal entries saved before maxBlender existed: read it once from the stored file
  if (library.every((entry) => 'maxBlender' in entry)) return library
  const healed = await Promise.all(
    library.map(async (entry) => {
      if ('maxBlender' in entry) return entry
      let maxBlender: string | null = null
      try {
        maxBlender = (await parseAddonFile(join(await entryDir(entry.id), entry.fileName))).maxBlender
      } catch {
        // unreadable/missing file — record null so we don't re-parse every time
      }
      return { ...entry, maxBlender }
    })
  )
  await updateConfig((config) => ({
    ...config,
    addonLibrary: config.addonLibrary.map(
      (entry) => healed.find((candidate) => candidate.id === entry.id) ?? entry
    )
  }))
  return healed
}

export async function addToLibrary(sourcePath: string): Promise<LibraryAddon> {
  const { entry, existed } = await addToLibraryOrExisting(sourcePath)
  if (existed) throw new Error(DUPLICATE_ERROR)
  return entry
}

/** like addToLibrary, but an already-stored identical file returns its entry instead of throwing */
export async function addToLibraryOrExisting(
  sourcePath: string
): Promise<{ entry: LibraryAddon; existed: boolean }> {
  // a bundle-of-zips resolves to its best inner add-on (extracted to a temp file we clean up)
  const inner = extname(sourcePath).toLowerCase() === '.zip' ? await resolveInnerAddonZip(sourcePath) : null
  const effectivePath = inner ? inner.tempPath : sourcePath
  // store under the real add-on's name — for a bundle that's the inner zip's name
  const displayName = inner ? inner.innerName : basename(sourcePath)
  try {
    const parsed = await parseAddonFile(effectivePath)
    // repack GitHub-wrapper zips into Blender's expected layout; null = already canonical / a .py
    const normalized =
      extname(effectivePath).toLowerCase() === '.zip' ? await normalizeAddonZip(effectivePath) : null
    const [fileSize, sha256] = normalized
      ? [normalized.length, createHash('sha256').update(normalized).digest('hex')]
      : await Promise.all([stat(effectivePath).then((s) => s.size), hashFile(effectivePath)])
    const existing = await listLibrary()
    const dup = existing.find((entry) => entry.sha256 === sha256)
    if (dup) return { entry: dup, existed: true }
    const id = sha256.slice(0, 12)
    const dir = await entryDir(id)
    await mkdir(dir, { recursive: true })
    const dest = join(dir, displayName)
    if (normalized) await writeFile(dest, normalized)
    else await copyFile(effectivePath, dest)
    const entry: LibraryAddon = {
      id,
      format: parsed.format,
      name: parsed.name,
      moduleId: parsed.moduleId,
      version: parsed.version,
      minBlender: parsed.minBlender,
      maxBlender: parsed.maxBlender,
      fileName: displayName,
      fileSize,
      sha256,
      addedAt: new Date().toISOString()
    }
    try {
      // the duplicate check runs again inside the serialized update, so two
      // concurrent adds of the same file cannot both slip past the early check
      await updateConfig((config) => {
        if (config.addonLibrary.some((candidate) => candidate.sha256 === sha256)) {
          throw new Error(DUPLICATE_ERROR)
        }
        return { ...config, addonLibrary: [...config.addonLibrary, entry] }
      })
    } catch (error) {
      await rm(dir, { recursive: true, force: true }).catch(() => {})
      // lost the race against a concurrent add of the same file — return the winner
      if (error instanceof Error && error.message === DUPLICATE_ERROR) {
        const winner = (await listLibrary()).find((candidate) => candidate.sha256 === sha256)
        if (winner) return { entry: winner, existed: true }
      }
      throw error
    }
    return { entry, existed: false }
  } finally {
    if (inner) await rm(inner.tempPath, { force: true }).catch(() => {})
  }
}

export async function findLibraryEntry(id: string): Promise<LibraryAddon> {
  const entry = (await listLibrary()).find((candidate) => candidate.id === id)
  if (!entry) throw new Error('Add-on not found in the library')
  return entry
}

export async function removeFromLibrary(id: string): Promise<LibraryAddon[]> {
  const entry = await findLibraryEntry(id)
  const dir = await entryDir(entry.id)
  try {
    await shell.trashItem(dir)
  } catch {
    await rm(dir, { recursive: true, force: true })
  }
  const next = await updateConfig((config) => ({
    ...config,
    addonLibrary: config.addonLibrary.filter((candidate) => candidate.id !== id)
  }))
  return next.addonLibrary
}

export async function revealLibraryEntry(id: string): Promise<void> {
  const entry = await findLibraryEntry(id)
  shell.showItemInFolder(join(await entryDir(entry.id), entry.fileName))
}

// --- installing into Blender versions -------------------------------------

/** why this entry cannot go into that Blender minor, or null when compatible */
export function installBlocker(entry: LibraryAddon, minor: string): string | null {
  if (entry.format === 'extension' && !atLeast(minor, EXTENSIONS_SINCE)) {
    return 'Extensions require Blender 4.2+'
  }
  if (entry.minBlender && !atLeast(minor, minorOf(entry.minBlender))) {
    return `Requires Blender ${entry.minBlender}+`
  }
  // blender_version_max is EXCLUSIVE: the add-on supports versions strictly below it,
  // so this minor is blocked once it reaches or exceeds the declared maximum
  if (entry.maxBlender && compareVersionsDesc(minor, entry.maxBlender) <= 0) {
    return `Add-on supports Blender below ${entry.maxBlender} (${minor} is too new)`
  }
  return null
}

/** hash-checked absolute path of a stored file — the only way installs read the library */
export async function verifiedLibraryFile(entry: LibraryAddon): Promise<string> {
  const filePath = join(await entryDir(entry.id), entry.fileName)
  if ((await hashFile(filePath)) !== entry.sha256) {
    throw new Error('The stored add-on file is corrupted — remove it and add it again')
  }
  return filePath
}
