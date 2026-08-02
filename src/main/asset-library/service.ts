import { mkdir, readFile, rename, stat, writeFile } from 'fs/promises'
import { randomUUID } from 'crypto'
import { hostname } from 'os'
import { join, normalize } from 'path'
import { getDataRoot } from '../paths'
import { withExclusiveOp } from '../op-lock'
import { onUiStateSet, readUiState } from '../ui-state'
import { listInstalled } from '../blender/installs'
import { listRunningBlenders } from '../blender/running'
import { resolveUserDirs } from '../addons/blender-paths'
import type { BlenderUserDirs } from '../addons/blender-paths'
import { parseUserpref } from '../addons/userpref-parser'
import type { ParsedAssetLibrary } from '../addons/userpref-parser'
import {
  BLENDER_POOL,
  ensureScript,
  extractMarked,
  mapPool,
  runBlenderScript,
  writeDataFile
} from '../addons/runner'
import { ASSET_LIBRARY_KEY, ASSET_LIBRARY_NAME, assetLibraryEnabled } from '../../shared/asset-library'
import { minorOf } from '../../shared/blender-archive'
import { compareVersionsDesc, isReleasedCycle } from '../../shared/blender-builds'
import type {
  AssetLibraryInfo,
  AssetLibraryProgress,
  AssetLibraryVersionStatus,
  InstalledBuild
} from '../../shared/types'

// The launcher-owned asset library: data/assets registered as "Blender Hub" in
// the preferences of every installed Blender version, so brushes/materials/node
// groups saved there exist in each of them and travel with the portable folder.
//
// Two-phase reconcile keeps this cheap: phase 1 READS each base's userpref.blend
// with the DNA parser (no Blender launches) and only bases with a real mismatch
// reach phase 2, a headless `--background` write. Two hard rules from the design
// review: never CREATE a userpref.blend (a pre-made file would suppress Blender's
// own first-run "load previous settings" offer), and never write while that
// Blender is running (it re-saves prefs from memory on exit, silently undoing us).

// --- the headless write script -------------------------------------------
//
// Same invariants as the add-ons batch / sync fixup scripts: constant code,
// payload via file + env var, JSON result framed between markers, errors framed
// on stderr, --python-exit-code 1 turns any python failure into a nonzero exit.
// API notes (verified live on 4.1/4.2/4.3/4.5/5.2): asset_libraries.new()/.remove()
// exist since 3.5 (the bpy.ops fallback covers 3.0-3.4); the entry's path attribute
// is `path` everywhere; 5.x rejects import_method APPEND_REUSE at runtime even
// though the static enum still lists it — hence the try/except cascade.
export const REGISTER_SCRIPT = `import bpy, json, os, sys

with open(os.environ["BLH_ASSETLIB_FILE"], "r", encoding="utf-8") as f:
    payload = json.load(f)

action = payload["action"]
name = payload["name"]
libs = bpy.context.preferences.filepaths.asset_libraries

def norm(p):
    return os.path.normcase(os.path.normpath(p)) if p else ""

def entry_path(entry):
    if hasattr(entry, "path"):
        return entry.path
    return getattr(entry, "directory", "")

def set_entry_path(entry, directory):
    if hasattr(entry, "path"):
        entry.path = directory
    elif hasattr(entry, "directory"):
        entry.directory = directory
    else:
        raise RuntimeError("asset library entry has neither .path nor .directory")

def remove_entry(entry):
    if callable(getattr(libs, "remove", None)):
        libs.remove(entry)
    else:
        bpy.ops.preferences.asset_library_remove(index=list(libs).index(entry))

changed = False
result = {"action": "unchanged"}

if action == "register":
    directory = os.path.normpath(payload["dir"])
    # ownership is path-first: an entry already pointing at the folder is ours
    # whatever its name; a NAME match may only be repointed when its current path
    # is one the launcher recorded writing (expect_dirs) — anything else is a
    # foreign library that must never be touched (the TS side normally filters
    # this out, but the script re-checks so a raced/unreadable prefs file can
    # never make it hijack someone else's entry
    entry = next((e for e in libs if norm(entry_path(e)) == norm(directory)), None)
    if entry is None:
        expect = [norm(d) for d in payload.get("expect_dirs", []) if d]
        matches = [e for e in libs if e.name == name]
        if matches and norm(entry_path(matches[0])) not in expect:
            result["action"] = "name-conflict"
            matches = None
        if matches is not None:
            # collapse accidental duplicates of our own entry; re-scan after every
            # removal because removing invalidates the sibling RNA references
            while True:
                matches = [e for e in libs if e.name == name]
                if len(matches) <= 1:
                    break
                remove_entry(matches[-1])
                changed = True
                result["action"] = "updated"
            matches = [e for e in libs if e.name == name]
            if not matches:
                if callable(getattr(libs, "new", None)):
                    try:
                        entry = libs.new(name=name, directory=directory)
                    except TypeError:
                        entry = libs.new(name=name)
                        set_entry_path(entry, directory)
                else:
                    bpy.ops.preferences.asset_library_add(directory=directory)
                    entry = libs[len(libs) - 1]
                    entry.name = name
                    set_entry_path(entry, directory)
                if hasattr(entry, "import_method"):
                    for method in ("APPEND_REUSE", "PACK", "APPEND"):
                        try:
                            entry.import_method = method
                            break
                        except TypeError:
                            continue
                changed = True
                result["action"] = "created"
            else:
                entry = matches[0]
                set_entry_path(entry, directory)
                changed = True
                result["action"] = "updated"
    if entry is not None and hasattr(entry, "enabled") and not entry.enabled:
        entry.enabled = True
        changed = True
        if result["action"] == "unchanged":
            result["action"] = "updated"
else:
    dirs = [norm(d) for d in payload.get("dirs", []) if d]
    removed = 0
    while True:
        victim = next(
            (e for e in libs if e.name == name and (not dirs or norm(entry_path(e)) in dirs)),
            None,
        )
        if victim is None:
            break
        remove_entry(victim)
        changed = True
        removed += 1
    result["action"] = "removed" if removed else "absent"

if changed:
    try:
        bpy.ops.wm.save_userpref()
    except Exception as exc:
        sys.stderr.write("<<<BHUB_ERROR>>>could not save preferences: " + str(exc) + "<<<BHUB_END>>>\\n")
        sys.stderr.flush()
        raise SystemExit(1)

sys.stdout.write("<<<BHUB_ADDONS>>>" + json.dumps(result) + "<<<BHUB_END>>>\\n")
sys.stdout.flush()
`

// --- folder + starter content --------------------------------------------

export function getAssetsDir(): string {
  return join(getDataRoot(), 'assets')
}

// Catalogs (not subfolders) form the tree Blender shows inside the library, so a
// fresh library opens structured instead of blank. Physical subfolders are NOT
// created on purpose: Blender scans .blend files recursively and never shows
// folders, so they would only suggest a false "folder = section" model.
const STARTER_CATALOGS = ['Brushes', 'Materials', 'Node Groups', 'Objects', 'Poses']

const README_TEXT = `Blender Hub asset library
=========================

Save .blend files with assets (Mark as Asset) into this folder and they appear
in every installed Blender version under "Blender Hub" in the Asset Browser.
Brushes (Blender 4.3+) can be saved here directly from the brush's asset menu.
Assets live inside .blend files; blender_assets.cats.txt keeps the catalog tree
shown in Blender - better not delete it. The folder travels with the launcher's
data directory.

Библиотека ассетов Blender Hub
==============================

Сохраняйте .blend-файлы с ассетами (Mark as Asset) в эту папку — они появятся
во всех установленных версиях Blender в разделе «Blender Hub» Asset Browser.
Кисти (Blender 4.3+) сохраняются сюда прямо из asset-меню кисти. Ассеты живут
внутри .blend-файлов; blender_assets.cats.txt хранит дерево каталогов, видимое
в Blender, — лучше его не удалять. Папка переезжает вместе с папкой data лаунчера.
`

async function fileExists(path: string): Promise<boolean> {
  return stat(path).then(
    (found) => found.isFile(),
    () => false
  )
}

export async function ensureAssetsDirBootstrap(): Promise<void> {
  const dir = getAssetsDir()
  await mkdir(dir, { recursive: true })
  const catsPath = join(dir, 'blender_assets.cats.txt')
  if (!(await fileExists(catsPath))) {
    const lines = [
      '# This is an Asset Catalog Definition file for Blender.',
      '#',
      '# Empty lines and lines starting with `#` will be ignored.',
      '# The first non-ignored line should be the version indicator.',
      '# Other lines are of the format "UUID:catalog/path/for/assets:simple catalog name"',
      '',
      'VERSION 1',
      '',
      ...STARTER_CATALOGS.map((catalog) => `${randomUUID()}:${catalog}:${catalog}`),
      ''
    ]
    await writeFile(catsPath, lines.join('\n'))
  }
  const readmePath = join(dir, 'README.txt')
  if (!(await fileExists(readmePath))) {
    await writeFile(readmePath, README_TEXT)
  }
}

// --- per-machine registration state ---------------------------------------
//
// Tracks what WE did to each prefs base, so a vanished entry is recognized as
// the user's own deletion (respected, never silently re-added) and a moved
// data/ folder can adopt a user-renamed entry by its previous path. Kept in a
// per-machine file inside data/: userpref.blend is per-machine, and two machines
// sharing a cloud-synced data/ folder may use identical base paths — suffixing
// the file name avoids any cross-machine merge entirely.

interface StoredRegistration {
  status: 'registered' | 'user-removed'
  /** the entry's name inside Blender — ours, or the user's rename we adopted */
  name: string
  directory: string
  updatedAt: string
}

interface AssetLibraryState {
  registrations: Record<string, StoredRegistration>
}

function machineId(): string {
  const raw = hostname()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  return raw || 'machine'
}

const statePath = (): string => join(getDataRoot(), `asset-library-state.${machineId()}.json`)

async function readState(): Promise<AssetLibraryState> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(statePath(), 'utf8'))
  } catch {
    return { registrations: {} }
  }
  const registrations: Record<string, StoredRegistration> = {}
  const raw = (parsed as { registrations?: unknown })?.registrations
  if (raw && typeof raw === 'object') {
    for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
      const entry = value as Partial<StoredRegistration> | null
      if (
        entry &&
        (entry.status === 'registered' || entry.status === 'user-removed') &&
        typeof entry.name === 'string' &&
        typeof entry.directory === 'string'
      ) {
        registrations[key] = {
          status: entry.status,
          name: entry.name,
          directory: entry.directory,
          updatedAt: typeof entry.updatedAt === 'string' ? entry.updatedAt : ''
        }
      }
    }
  }
  return { registrations }
}

// same discipline as config.ts: serialized queue + atomic tmp+rename writes;
// unknown top-level keys and unknown per-entry fields survive a read-modify-write
// (a newer launcher sharing the portable folder may have added fields)
let stateQueue: Promise<unknown> = Promise.resolve()

function updateState(
  mutate: (current: AssetLibraryState) => AssetLibraryState
): Promise<void> {
  const run = stateQueue.then(async () => {
    let raw: Record<string, unknown> = {}
    try {
      const parsed: unknown = JSON.parse(await readFile(statePath(), 'utf8'))
      if (parsed && typeof parsed === 'object') raw = parsed as Record<string, unknown>
    } catch {
      // no file yet, or unreadable — start fresh
    }
    const next = mutate(await readState())
    const rawRegs =
      raw.registrations && typeof raw.registrations === 'object'
        ? (raw.registrations as Record<string, unknown>)
        : {}
    const registrations: Record<string, unknown> = {}
    for (const [key, entry] of Object.entries(next.registrations)) {
      const rawEntry = rawRegs[key]
      registrations[key] =
        rawEntry && typeof rawEntry === 'object' ? { ...rawEntry, ...entry } : entry
    }
    await mkdir(getDataRoot(), { recursive: true })
    const target = statePath()
    await writeFile(`${target}.tmp`, JSON.stringify({ ...raw, registrations }, null, 2))
    await rename(`${target}.tmp`, target)
  })
  stateQueue = run.catch(() => {})
  return run
}

// --- base enumeration ------------------------------------------------------

interface BaseTarget {
  base: string
  minor: string
  version: string
  executable: string
  portable: boolean
  userprefPath: string
  supported: boolean
}

const pathKey = (path: string): string => {
  const normalized = normalize(path).replace(/[\\/]+$/, '')
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized
}

export const samePath = (a: string, b: string): boolean =>
  a.length > 0 && b.length > 0 && pathKey(a) === pathKey(b)

// released copies over candidates, then newest — the same preference the sync
// scan uses for its per-minor representative
function preferBuild(candidate: InstalledBuild, current: InstalledBuild): boolean {
  const released =
    Number(isReleasedCycle(candidate.releaseCycle)) - Number(isReleasedCycle(current.releaseCycle))
  if (released !== 0) return released > 0
  return compareVersionsDesc(candidate.version, current.version) < 0
}

/**
 * The unit of work is a prefs BASE, not an install: every copy of one minor
 * shares the standard base, while a portable build brings its own — so two 4.5
 * copies collapse into one target and a portable 4.5 stays separate.
 */
async function enumerateBases(): Promise<BaseTarget[]> {
  const grouped = new Map<string, { build: InstalledBuild; dirs: BlenderUserDirs; minor: string }>()
  for (const build of await listInstalled()) {
    const minor = minorOf(build.version)
    let dirs: BlenderUserDirs
    try {
      dirs = resolveUserDirs(build.executable, minor)
    } catch {
      continue
    }
    const key = pathKey(dirs.base)
    const current = grouped.get(key)
    if (!current || preferBuild(build, current.build)) grouped.set(key, { build, dirs, minor })
  }
  return [...grouped.values()]
    .map(({ build, dirs, minor }) => ({
      base: dirs.base,
      minor,
      version: build.version,
      executable: build.executable,
      portable: dirs.portable,
      userprefPath: dirs.userprefPath,
      // asset libraries exist since Blender 3.0
      supported: Number.parseInt(minor, 10) >= 3
    }))
    .sort((a, b) => compareVersionsDesc(a.version, b.version))
}

// --- phase 1: assessment ---------------------------------------------------

export type BaseAssessment =
  | { kind: 'registered'; entryName: string }
  /** our entry exists but its path is outdated — phase 2 repairs it via `entryName` */
  | { kind: 'stale'; entryName: string }
  | { kind: 'unregistered' }
  | { kind: 'user-removed' }
  /** a foreign library already owns our name — never touched, surfaced as an error */
  | { kind: 'name-conflict' }

/**
 * Pure decision core (exported for the test harness). Ownership is matched by
 * PATH first, then by name: a moved data/ folder must not orphan the entry, and
 * an entry the user merely renamed (path still ours) stays adopted as-is.
 */
export function assessEntries(
  entries: ParsedAssetLibrary[],
  stored: StoredRegistration | undefined,
  dir: string
): BaseAssessment {
  const byDir = entries.find((entry) => samePath(entry.directory, dir))
  if (byDir) return { kind: 'registered', entryName: byDir.name || ASSET_LIBRARY_NAME }
  const byName = entries.find((entry) => entry.name === ASSET_LIBRARY_NAME)
  if (byName) {
    // ours ONLY while it still points at the path we last wrote — an entry the
    // user redirected to their own folder is theirs now (treated like a removal
    // of ours, never silently repointed back)
    if (stored && samePath(byName.directory, stored.directory)) {
      return { kind: 'stale', entryName: ASSET_LIBRARY_NAME }
    }
    if (stored) return { kind: 'user-removed' }
    return { kind: 'name-conflict' }
  }
  if (stored?.status === 'registered') {
    const byFormerDir = entries.find((entry) => samePath(entry.directory, stored.directory))
    // user renamed our entry AND the folder moved since: adopt the rename, repair the path
    if (byFormerDir) return { kind: 'stale', entryName: byFormerDir.name }
    return { kind: 'user-removed' }
  }
  if (stored?.status === 'user-removed') return { kind: 'user-removed' }
  return { kind: 'unregistered' }
}

type TargetAssessment =
  | { kind: BaseAssessment['kind']; entryName?: string }
  | { kind: 'no-userpref' }
  | { kind: 'unsupported' }
  | { kind: 'unreadable'; message: string }

async function assessTarget(
  target: BaseTarget,
  stored: StoredRegistration | undefined,
  dir: string
): Promise<TargetAssessment> {
  if (!target.supported) return { kind: 'unsupported' }
  if (!(await fileExists(target.userprefPath))) return { kind: 'no-userpref' }
  try {
    const parsed = await parseUserpref(target.userprefPath)
    return assessEntries(parsed.assetLibraries, stored, dir)
  } catch (error) {
    return { kind: 'unreadable', message: error instanceof Error ? error.message : String(error) }
  }
}

const statusOf = (
  target: BaseTarget,
  assessment: TargetAssessment
): AssetLibraryVersionStatus => {
  const common = {
    minor: target.minor,
    version: target.version,
    portable: target.portable
  }
  switch (assessment.kind) {
    case 'registered':
      return { ...common, status: 'registered' }
    case 'stale':
      return { ...common, status: 'stale' }
    case 'unregistered':
      return { ...common, status: 'unregistered' }
    case 'user-removed':
      return { ...common, status: 'user-removed' }
    case 'no-userpref':
      return { ...common, status: 'no-userpref' }
    case 'unsupported':
      return { ...common, status: 'unsupported' }
    case 'name-conflict':
      return {
        ...common,
        status: 'error',
        error: `A different library named "${ASSET_LIBRARY_NAME}" already exists in this version`
      }
    case 'unreadable':
      return { ...common, status: 'error', error: assessment.message }
  }
}

async function isEnabled(): Promise<boolean> {
  return assetLibraryEnabled((await readUiState())[ASSET_LIBRARY_KEY])
}

/**
 * Self-healing corrections discovered by a read: an entry present on disk adopts
 * `registered` (covers registrations made by the sync fixup and lost state files),
 * a vanished entry flips `registered` -> `user-removed`. Collected per read, then
 * written once.
 */
function stateCorrection(
  assessment: TargetAssessment,
  stored: StoredRegistration | undefined,
  dir: string
): StoredRegistration | null {
  if (assessment.kind === 'registered') {
    const entryName = assessment.entryName ?? ASSET_LIBRARY_NAME
    if (stored?.status !== 'registered' || stored.name !== entryName || !samePath(stored.directory, dir)) {
      return { status: 'registered', name: entryName, directory: dir, updatedAt: new Date().toISOString() }
    }
    return null
  }
  if (assessment.kind === 'user-removed' && stored?.status === 'registered') {
    return { ...stored, status: 'user-removed', updatedAt: new Date().toISOString() }
  }
  return null
}

async function applyCorrections(corrections: Map<string, StoredRegistration>): Promise<void> {
  if (corrections.size === 0) return
  await updateState((current) => ({
    registrations: { ...current.registrations, ...Object.fromEntries(corrections) }
  }))
}

export async function readAssetLibraryStatus(): Promise<AssetLibraryInfo> {
  const enabled = await isEnabled()
  const dir = getAssetsDir()
  const bases = await enumerateBases()
  const state = await readState()
  const corrections = new Map<string, StoredRegistration>()
  const versions: AssetLibraryVersionStatus[] = []
  for (const target of bases) {
    const stored = state.registrations[pathKey(target.base)]
    const assessment = await assessTarget(target, stored, dir)
    const correction = stateCorrection(assessment, stored, dir)
    if (correction) corrections.set(pathKey(target.base), correction)
    versions.push(statusOf(target, assessment))
  }
  await applyCorrections(corrections)
  return { enabled, dir, versions }
}

// --- phase 2: headless writes ----------------------------------------------

interface WriteJob {
  target: BaseTarget
  /** the entry name the script matches — ours, or a user rename being repaired */
  entryName: string
  /** paths the launcher recorded writing — the script's ownership proof for name matches */
  expectDirs: string[]
}

// jobs are per BASE and run concurrently, while two bases can share one minor
// (portable next to standard) — the payload file name must be unique per run,
// or one job's Blender could read the other's payload mid-write
let payloadSeq = 0

async function runRegisterScript(
  executable: string,
  minor: string,
  payload: Record<string, unknown>
): Promise<{ action: string }> {
  const scriptPath = await ensureScript('.asset-library.py', REGISTER_SCRIPT)
  const payloadPath = await writeDataFile(
    `.asset-library-${minor}-${payloadSeq++}.json`,
    JSON.stringify(payload)
  )
  const stdout = await runBlenderScript(
    executable,
    ['--background', '--python-exit-code', '1', '--python', scriptPath],
    {
      // one prefs load + one list edit — the sync fixup ceiling fits comfortably
      timeoutMs: 150_000,
      env: { BLH_ASSETLIB_FILE: payloadPath },
      failMessage: 'Blender could not update its asset libraries'
    }
  )
  // malformed output = failure, exit code alone is not enough
  return JSON.parse(extractMarked(stdout)) as { action: string }
}

export interface ReconcileOptions {
  /**
   * true — an explicit user action (enable toggle, Fix button): re-adds entries
   * the user deleted inside Blender and retries unreadable prefs. Silent runs
   * (startup, post-install) leave both alone.
   */
  force?: boolean
  onProgress?: (progress: AssetLibraryProgress) => void
}

export async function reconcileAssetLibraries(options: ReconcileOptions = {}): Promise<AssetLibraryInfo> {
  const enabled = await isEnabled()
  const dir = getAssetsDir()
  if (!enabled) return readAssetLibraryStatus()
  await ensureAssetsDirBootstrap()

  const bases = await enumerateBases()
  const state = await readState()
  const corrections = new Map<string, StoredRegistration>()
  const outcomes = new Map<string, AssetLibraryVersionStatus>()
  const jobs: WriteJob[] = []

  for (const target of bases) {
    const stored = state.registrations[pathKey(target.base)]
    const assessment = await assessTarget(target, stored, dir)
    const correction = stateCorrection(assessment, stored, dir)
    if (correction) corrections.set(pathKey(target.base), correction)
    const expectDirs = stored ? [stored.directory] : []
    if (assessment.kind === 'unregistered' || assessment.kind === 'stale') {
      jobs.push({ target, entryName: assessment.entryName ?? ASSET_LIBRARY_NAME, expectDirs })
    } else if (options.force && (assessment.kind === 'user-removed' || assessment.kind === 'unreadable')) {
      jobs.push({ target, entryName: ASSET_LIBRARY_NAME, expectDirs })
    } else {
      outcomes.set(pathKey(target.base), statusOf(target, assessment))
    }
  }

  // a running Blender re-saves prefs from memory on exit and would silently undo
  // the write — defer those bases to a later reconcile instead
  let pending = jobs
  if (jobs.length > 0) {
    const runningMinors = new Set(
      (await listRunningBlenders([...new Set(jobs.map((job) => job.target.minor))])).map(
        (entry) => entry.minor
      )
    )
    pending = jobs.filter((job) => {
      if (!runningMinors.has(job.target.minor)) return true
      outcomes.set(pathKey(job.target.base), {
        minor: job.target.minor,
        version: job.target.version,
        portable: job.target.portable,
        status: 'running'
      })
      return false
    })
  }

  const total = pending.length
  let done = 0
  options.onProgress?.({ action: 'register', done, total })
  await mapPool(pending, BLENDER_POOL, async (job) => {
    const key = pathKey(job.target.base)
    try {
      const result = await runRegisterScript(job.target.executable, job.target.minor, {
        action: 'register',
        name: job.entryName,
        dir,
        expect_dirs: job.expectDirs
      })
      if (result.action === 'name-conflict') {
        // the script's own ownership re-check refused a foreign same-named entry
        // (reachable when the prefs were unreadable to the phase-1 parser)
        outcomes.set(key, statusOf(job.target, { kind: 'name-conflict' }))
        done += 1
        options.onProgress?.({ action: 'register', done, total })
        return
      }
      corrections.set(key, {
        status: 'registered',
        name: job.entryName,
        directory: dir,
        updatedAt: new Date().toISOString()
      })
      outcomes.set(key, {
        minor: job.target.minor,
        version: job.target.version,
        portable: job.target.portable,
        status: 'registered'
      })
    } catch (error) {
      outcomes.set(key, {
        minor: job.target.minor,
        version: job.target.version,
        portable: job.target.portable,
        status: 'error',
        error: error instanceof Error ? error.message : String(error)
      })
    }
    done += 1
    options.onProgress?.({ action: 'register', done, total })
  })

  await applyCorrections(corrections)
  return {
    enabled,
    dir,
    versions: bases.map((target) => outcomes.get(pathKey(target.base)) ?? statusOf(target, { kind: 'unregistered' }))
  }
}

export async function unregisterAssetLibraries(
  onProgress?: (progress: AssetLibraryProgress) => void
): Promise<AssetLibraryInfo> {
  const dir = getAssetsDir()
  const bases = await enumerateBases()
  const state = await readState()
  const outcomes = new Map<string, AssetLibraryVersionStatus>()
  const jobs: { target: BaseTarget; name: string; dirs: string[] }[] = []

  for (const target of bases) {
    const stored = state.registrations[pathKey(target.base)]
    const assessment = await assessTarget(target, stored, dir)
    const common = { minor: target.minor, version: target.version, portable: target.portable }
    if (
      assessment.kind === 'registered' ||
      assessment.kind === 'stale' ||
      assessment.kind === 'unreadable'
    ) {
      // removal is keyed by name AND path — a foreign same-named library with its
      // own folder is never touched
      jobs.push({
        target,
        name: ('entryName' in assessment ? assessment.entryName : undefined) ?? stored?.name ?? ASSET_LIBRARY_NAME,
        dirs: [dir, ...(stored ? [stored.directory] : [])]
      })
    } else {
      outcomes.set(pathKey(target.base), { ...common, status: 'unregistered' })
    }
  }

  let pending = jobs
  if (jobs.length > 0) {
    const runningMinors = new Set(
      (await listRunningBlenders([...new Set(jobs.map((job) => job.target.minor))])).map(
        (entry) => entry.minor
      )
    )
    pending = jobs.filter((job) => {
      if (!runningMinors.has(job.target.minor)) return true
      outcomes.set(pathKey(job.target.base), {
        minor: job.target.minor,
        version: job.target.version,
        portable: job.target.portable,
        status: 'running'
      })
      return false
    })
  }

  const total = pending.length
  let done = 0
  onProgress?.({ action: 'unregister', done, total })
  const cleared: string[] = []
  await mapPool(pending, BLENDER_POOL, async (job) => {
    const key = pathKey(job.target.base)
    const common = { minor: job.target.minor, version: job.target.version, portable: job.target.portable }
    try {
      await runRegisterScript(job.target.executable, job.target.minor, {
        action: 'remove',
        name: job.name,
        dirs: job.dirs
      })
      cleared.push(key)
      outcomes.set(key, { ...common, status: 'unregistered' })
    } catch (error) {
      outcomes.set(key, {
        ...common,
        status: 'error',
        error: error instanceof Error ? error.message : String(error)
      })
    }
    done += 1
    onProgress?.({ action: 'unregister', done, total })
  })

  if (cleared.length > 0) {
    await updateState((current) => {
      const registrations = { ...current.registrations }
      for (const key of cleared) delete registrations[key]
      return { registrations }
    })
  }
  return {
    enabled: await isEnabled(),
    dir,
    versions: bases.map(
      (target) =>
        outcomes.get(pathKey(target.base)) ??
        ({ minor: target.minor, version: target.version, portable: target.portable, status: 'unregistered' } as AssetLibraryVersionStatus)
    )
  }
}

// --- sync integration -------------------------------------------------------

/**
 * Piggyback payload for the sync fixup: an Apply of 'preferences' replaces the
 * target's library list with the source's, so the fixup (which re-saves prefs
 * anyway) restores our entry in the same run — no drift, no extra launch.
 * Restore-only, per target base: attached ONLY when the launcher recorded a
 * registration there — a base the user removed the entry from (user-removed) or
 * never had it must not get one through this side path. The recorded name rides
 * along, so a user-renamed entry is restored under the user's chosen name.
 */
export async function getAssetLibraryFixupExtra(
  targetBase: string
): Promise<{ name: string; dir: string } | null> {
  if (!(await isEnabled())) return null
  const stored = (await readState()).registrations[pathKey(targetBase)]
  if (stored?.status !== 'registered') return null
  await ensureAssetsDirBootstrap()
  return { name: stored.name || ASSET_LIBRARY_NAME, dir: getAssetsDir() }
}

// --- background scheduling --------------------------------------------------
//
// Auto-triggered reconciles (startup, toggle flip, a finished install) must not
// collide with a user-driven Apply: the shared op-lock THROWS when busy, so the
// silent path swallows that and re-arms a retry instead of surfacing an error.

let scheduled: NodeJS.Timeout | null = null
let silentRun: Promise<void> | null = null

export function scheduleAssetLibraryReconcile(delayMs = 5_000): void {
  if (scheduled) return
  scheduled = setTimeout(() => {
    scheduled = null
    void runSilentReconcile()
  }, delayMs)
  // a pending timer must not keep the app alive on quit
  scheduled.unref?.()
}

/**
 * Called by the IPC layer before an EXPLICIT reconcile/unregister: absorbs the
 * silent safety net so it cannot steal the op-lock from the user's own action
 * (the enable flow may park behind the running-Blender gate for minutes — long
 * past any scheduling delay).
 */
export async function yieldBackgroundReconcile(): Promise<void> {
  if (scheduled) {
    clearTimeout(scheduled)
    scheduled = null
  }
  if (silentRun) await silentRun.catch(() => {})
}

async function runSilentReconcile(): Promise<void> {
  const run = (async (): Promise<void> => {
    if (!(await isEnabled())) return
    const outcome = await withExclusiveOp('asset library', () =>
      reconcileAssetLibraries({ force: false })
    )
    // deferred bases (Blender open, version not run yet) are picked up by
    // re-arming — without this a skip would stick for the whole session
    if (outcome.versions.some((row) => row.status === 'running' || row.status === 'no-userpref')) {
      scheduleAssetLibraryReconcile(10 * 60_000)
    }
  })()
  silentRun = run
  try {
    await run
  } catch {
    // busy op-lock or a transient failure — user operations take priority, retry later
    scheduleAssetLibraryReconcile(120_000)
  } finally {
    if (silentRun === run) silentRun = null
  }
}

export function setupAssetLibrary(): void {
  onUiStateSet((key, value) => {
    // the enabling window runs its own explicit reconcile — the delay keeps this
    // silent safety net (other windows, a cloud-synced toggle) from grabbing the
    // op-lock first and failing that explicit run with a busy error
    if (key === ASSET_LIBRARY_KEY && assetLibraryEnabled(value)) scheduleAssetLibraryReconcile(10_000)
  })
  // deferred so a cold start paints the window before any prefs parsing begins
  scheduleAssetLibraryReconcile(15_000)
}
