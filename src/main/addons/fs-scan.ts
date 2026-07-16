import { readdir, readFile, stat } from 'fs/promises'
import { basename, join } from 'path'
import { minorOf } from '../../shared/blender-archive'
import { compareVersionsDesc } from '../../shared/blender-builds'
import { parseBlInfo, parseManifest } from './addon-meta'
import { resolveUserDirs, versionDir } from './blender-paths'
import {
  parseUserpref,
  REPO_FLAG_DISABLED,
  REPO_FLAG_USE_CUSTOM_DIRECTORY,
  REPO_FLAG_USE_REMOTE_URL,
  REPO_SOURCE_SYSTEM
} from './userpref-parser'
import type { AddonInfo, AddonOrigin, InstalledBuild, VersionAddons } from '../../shared/types'

// Direct (no-Blender) scan of one installed version: the enabled list and the
// repo/script-dir map come from userpref.blend, installed add-ons from walking
// the same directories Blender walks. Throws on ANY surprise — the caller falls
// back to the headless scan, which is always the source of truth.

const MAX_META_BYTES = 256 * 1024

const atLeast = (version: string, base: string): boolean => compareVersionsDesc(version, base) <= 0

async function readMetaText(filePath: string): Promise<string> {
  try {
    const info = await stat(filePath)
    if (info.size > 4 * 1024 * 1024) return ''
    const text = await readFile(filePath, 'utf8')
    return text.length > MAX_META_BYTES ? text.slice(0, MAX_META_BYTES) : text
  } catch {
    return ''
  }
}

async function listDir(dir: string): Promise<{ dirs: string[]; pyFiles: string[] } | null> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return null // directory does not exist — a normal case, not an error
  }
  const dirs: string[] = []
  const pyFiles: string[] = []
  for (const entry of entries) {
    const name = entry.name
    if (name.startsWith('.') || name === '__pycache__') continue
    let isDirectory = entry.isDirectory()
    if (!isDirectory && entry.isSymbolicLink()) {
      try {
        isDirectory = (await stat(join(dir, name))).isDirectory()
      } catch {
        continue
      }
    }
    if (isDirectory) dirs.push(name)
    else if (name.toLowerCase().endsWith('.py')) pyFiles.push(name)
  }
  return { dirs, pyFiles }
}

interface Collector {
  addons: AddonInfo[]
  seen: Set<string>
  enabled: Set<string>
}

function push(collector: Collector, addon: AddonInfo): void {
  // first hit wins — mirrors Blender's path precedence for duplicate modules
  if (collector.seen.has(addon.module)) return
  collector.seen.add(addon.module)
  collector.addons.push(addon)
}

async function scanLegacyDir(collector: Collector, dir: string, origin: AddonOrigin): Promise<void> {
  const listing = await listDir(dir)
  if (!listing) return
  for (const moduleDir of listing.dirs) {
    // bpy.path.module_names() hard-codes this exclusion for legacy add-on dirs
    if (moduleDir === 'modules') continue
    const initPath = join(dir, moduleDir, '__init__.py')
    try {
      await stat(initPath)
    } catch {
      continue // not a python package — not an add-on
    }
    const meta = parseBlInfo(await readMetaText(initPath))
    push(collector, {
      module: moduleDir,
      name: meta.name ?? moduleDir,
      version: meta.version,
      category: meta.category ?? '',
      enabled: collector.enabled.has(moduleDir),
      origin,
      repoModule: null,
      pkgId: null,
      blInfoId: null,
      author: meta.author,
      description: meta.description
    })
  }
  for (const pyFile of listing.pyFiles) {
    // module_names() never lists a top-level __init__.py (a badly-unzipped add-on)
    if (pyFile === '__init__.py') continue
    const module = basename(pyFile, '.py')
    const meta = parseBlInfo(await readMetaText(join(dir, pyFile)))
    push(collector, {
      module,
      name: meta.name ?? module,
      version: meta.version,
      category: meta.category ?? '',
      enabled: collector.enabled.has(module),
      origin,
      repoModule: null,
      pkgId: null,
      blInfoId: null,
      author: meta.author,
      description: meta.description
    })
  }
}

async function scanExtensionRepoDir(
  collector: Collector,
  root: string,
  repoModule: string
): Promise<void> {
  const listing = await listDir(root)
  if (!listing) return
  for (const pkgDir of listing.dirs) {
    const manifestPath = join(root, pkgDir, 'blender_manifest.toml')
    let manifestText: string
    try {
      await stat(manifestPath)
      manifestText = await readMetaText(manifestPath)
    } catch {
      continue // not an extension package (e.g. the .local wheels dir)
    }
    // Blender lists a package only when __init__.py exists — a manifest-only dir
    // (theme extension, broken copy) is invisible to it and must stay invisible here
    try {
      if (!(await stat(join(root, pkgDir, '__init__.py'))).isFile()) continue
    } catch {
      continue
    }
    const meta = parseManifest(manifestText)
    const module = `bl_ext.${repoModule}.${pkgDir}`
    push(collector, {
      module,
      name: meta.name ?? pkgDir,
      version: meta.version,
      category: '',
      enabled: collector.enabled.has(module),
      origin: 'extension',
      repoModule,
      pkgId: pkgDir,
      blInfoId: null,
      author: meta.maintainer,
      description: meta.description
    })
  }
}

export async function scanVersionDirect(build: InstalledBuild): Promise<VersionAddons> {
  const minor = minorOf(build.version)
  const dirs = resolveUserDirs(build.executable, minor)
  // throws when userpref.blend is missing or unfamiliar — that includes a
  // never-launched version, where compiled-in defaults only Blender knows apply
  const prefs = await parseUserpref(dirs.userprefPath)

  const collector: Collector = {
    addons: [],
    seen: new Set(),
    enabled: new Set(prefs.enabledModules)
  }
  const installSide = versionDir(build.executable, minor)

  // bundled add-ons: addons_core (4.2+) and scripts/addons (≤4.1; harmless if absent)
  await scanLegacyDir(collector, join(installSide, 'scripts', 'addons_core'), 'bundled')
  await scanLegacyDir(collector, join(installSide, 'scripts', 'addons'), 'bundled')
  // user legacy add-ons
  await scanLegacyDir(collector, join(dirs.scriptsDir, 'addons'), 'user')
  // extra script directories configured in preferences
  for (const scriptDir of prefs.scriptDirectories) {
    if (scriptDir) await scanLegacyDir(collector, join(scriptDir, 'addons'), 'user')
  }

  // extensions (4.2+): resolve each repo directory exactly like Blender does
  if (atLeast(minor, '4.2')) {
    for (const repo of prefs.extensionRepos) {
      if (repo.flag & REPO_FLAG_DISABLED) continue // Blender does not enumerate these
      let root: string
      if (repo.flag & REPO_FLAG_USE_CUSTOM_DIRECTORY) {
        // Blender uses custom_dirpath verbatim even when empty (loads nothing) —
        // mirror that; enabled modules then surface honestly as missing rows
        if (!repo.customDirectory) continue
        root = repo.customDirectory
      } else {
        // remote repos always live under the user dir, even if marked SYSTEM
        const isSystem =
          repo.source === REPO_SOURCE_SYSTEM && !(repo.flag & REPO_FLAG_USE_REMOTE_URL)
        root = isSystem
          ? join(installSide, 'extensions', repo.module)
          : join(dirs.extensionsDir, repo.module)
      }
      await scanExtensionRepoDir(collector, root, repo.module)
    }
  }

  // preferences may list modules whose files are gone — show them honestly
  for (const module of collector.enabled) {
    if (collector.seen.has(module)) continue
    const isExtension = module.startsWith('bl_ext.')
    // built-ins Blender compiles in (e.g. 'cycles') are not on-disk add-ons; skip them
    if (!isExtension && module === 'cycles') continue
    collector.addons.push({
      module,
      name: module.split('.').pop() ?? module,
      version: null,
      category: '',
      enabled: true,
      origin: isExtension ? 'extension' : 'user',
      repoModule: isExtension ? (module.split('.')[1] ?? null) : null,
      pkgId: isExtension ? (module.split('.')[2] ?? null) : null,
      blInfoId: null,
      author: null,
      missing: true
    })
  }

  return {
    installId: build.id,
    version: build.version,
    minor,
    releaseCycle: build.releaseCycle,
    addons: collector.addons,
    scanMethod: 'direct'
  }
}

// Former bundled add-ons that graduated into always-on core, two different ways:
//  - `file` set: the Python code moved to scripts/startup/bl_operators (still a .py file, just
//    no longer toggleable) — existence of that file draws the era boundary per version.
//  - `file: null`: rewritten as a compiled-in C++ operator (e.g. wm.ply_import/wm.ply_export,
//    gated by bpy.app.build_options at compile time) — there is no Python file anywhere to
//    check, so once the legacy module stops appearing in a scan we treat it as always-core.
//    (io_mesh_ply/io_scene_obj: gone already between 3.6 and 4.0, no extensions.blender.org
//    replacement exists — verified against the live catalog and Blender's space_topbar.py.)
// Keyed by the legacy module name (the stable cross-version identity, so the row still merges
// with the old bundled cells) -> the file that now provides it (or null) + its display name.
const CORE_GRADUATED: Record<string, { file: string | null; name: string }> = {
  copy_global_transform: { file: 'copy_global_transform.py', name: 'Copy Global Transform' },
  bone_selection_sets: { file: 'bone_selection_sets.py', name: 'Selection Sets' },
  io_import_images_as_planes: { file: 'image_as_planes.py', name: 'Import Images as Planes' },
  io_mesh_ply: { file: null, name: 'Stanford PLY format' },
  io_scene_obj: { file: null, name: 'Wavefront OBJ format' }
}

/**
 * Detect former add-ons now baked into core for this version. Existence of the startup file
 * is the signal — it naturally draws the era boundary (while still a toggleable bundled
 * add-on the file is NOT in bl_operators, so nothing is reported and the normal cell stands).
 * A `file: null` entry has no file to check — always reported once the module itself is absent,
 * since the native operator it was rewritten into is compiled into Blender, not a script on disk.
 * `alreadyScanned` skips any module a scan already surfaced as a real (toggleable) add-on.
 */
export async function detectCoreGraduated(
  build: InstalledBuild,
  alreadyScanned: ReadonlySet<string>
): Promise<AddonInfo[]> {
  const opsDir = join(versionDir(build.executable, minorOf(build.version)), 'scripts', 'startup', 'bl_operators')
  const out: AddonInfo[] = []
  for (const [module, { file, name }] of Object.entries(CORE_GRADUATED)) {
    if (alreadyScanned.has(module)) continue
    if (file) {
      try {
        if (!(await stat(join(opsDir, file))).isFile()) continue
      } catch {
        continue // not present in this version
      }
    }
    out.push({
      module,
      name,
      version: null,
      category: '',
      enabled: true,
      origin: 'core',
      repoModule: null,
      pkgId: null,
      blInfoId: null,
      author: null
    })
  }
  return out
}
