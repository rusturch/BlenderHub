import { listInstalled } from '../blender/installs'
import { minorOf } from '../../shared/blender-archive'
import { compareVersionsDesc } from '../../shared/blender-builds'
import { detectCoreGraduated, scanVersionDirect } from './fs-scan'
import { extractMarked, runBlenderScript, writeDataFile } from './runner'
import type { AddonInfo, AddonScanProgress, InstalledBuild, VersionAddons } from '../../shared/types'

// Reading which add-ons a Blender version has enabled means reading its userpref.blend,
// which is a per-version binary — parsing it by hand is fragile across releases. Instead
// we launch Blender itself in --background and let it report its own state as JSON. This
// is the same code path Blender uses at startup, so what it prints is exactly the truth.
//
// The script text is a constant we control — no renderer input is interpolated into it.
const READ_SCRIPT = `import bpy, addon_utils, json, sys, os

def system_scripts():
    try:
        return os.path.realpath(bpy.utils.system_resource("SCRIPTS"))
    except Exception:
        return ""

def origin_of(mod, module, sys_scripts):
    # extensions are always user-added; bundled add-ons live inside the install's scripts dir
    if module.startswith("bl_ext."):
        return "extension"
    path = getattr(mod, "__file__", None)
    if path and sys_scripts:
        try:
            if os.path.realpath(path).startswith(sys_scripts + os.sep):
                return "bundled"
        except Exception:
            pass
    return "user"

def collect():
    prefs = getattr(bpy.context, "preferences", None) or getattr(bpy.context, "user_preferences", None)
    enabled = set()
    if prefs is not None:
        try:
            enabled = set(a.module for a in prefs.addons)
        except Exception:
            enabled = set()
    sys_scripts = system_scripts()
    items = []
    for mod in addon_utils.modules():
        module = getattr(mod, "__name__", None)
        if not module:
            continue
        try:
            info = addon_utils.module_bl_info(mod) or {}
        except Exception:
            info = getattr(mod, "bl_info", {}) or {}
        ver = info.get("version")
        if isinstance(ver, (tuple, list)):
            version = ".".join(str(x) for x in ver)
        elif isinstance(ver, str) and ver:
            version = ver
        else:
            version = None
        parts = module.split(".")
        if module.startswith("bl_ext.") and len(parts) >= 3:
            repo_module = parts[1]
            pkg_id = parts[2]
        else:
            repo_module = None
            pkg_id = None
        bl_id = info.get("id")
        author = info.get("author")
        description = info.get("description")
        # doc_url is bl_info's own field; extensions surface their manifest 'website' there too.
        # wiki_url/tracker_url are the pre-2.8 spellings still found in older add-ons.
        website = info.get("doc_url") or info.get("wiki_url") or info.get("tracker_url")
        if not (isinstance(website, str) and website.startswith(("http://", "https://"))):
            website = None
        items.append({
            "module": module,
            "name": info.get("name") or module,
            "version": version,
            "category": info.get("category") or "",
            "enabled": module in enabled,
            "origin": origin_of(mod, module, sys_scripts),
            "repoModule": repo_module,
            "pkgId": pkg_id,
            "blInfoId": bl_id if isinstance(bl_id, str) else None,
            "author": author if isinstance(author, str) else None,
            "description": description if isinstance(description, str) else None,
            "website": website,
        })
    return items

try:
    sys.stdout.write("<<<BHUB_ADDONS>>>" + json.dumps(collect()) + "<<<BHUB_END>>>\\n")
    sys.stdout.flush()
except Exception as exc:
    sys.stderr.write("<<<BHUB_ERROR>>>" + str(exc) + "<<<BHUB_END>>>\\n")
    sys.stderr.flush()
    raise SystemExit(1)
`

const SCAN_TIMEOUT_MS = 60_000

// Blender's own extensions client is hidden from its Add-ons UI (SECRET_ADDONS in
// bl_pkg/bl_extension_ui.py) — an internal system module, not a user-facing add-on.
const HIDDEN_SYSTEM_MODULES = new Set(['bl_pkg'])
const dropHiddenSystem = (addons: AddonInfo[]): AddonInfo[] =>
  addons.filter((addon) => !HIDDEN_SYSTEM_MODULES.has(addon.module))

// Append former add-ons that are now always-on core (invisible to any add-on listing),
// so both scan paths report them identically. Mutates the array in place.
async function appendCoreGraduated(build: InstalledBuild, addons: AddonInfo[]): Promise<void> {
  const seen = new Set(addons.map((addon) => addon.module))
  addons.push(...(await detectCoreGraduated(build, seen)))
}

interface RawAddon {
  module: unknown
  name: unknown
  version: unknown
  category: unknown
  enabled: unknown
  origin: unknown
  repoModule: unknown
  pkgId: unknown
  blInfoId: unknown
  author: unknown
  description: unknown
  website: unknown
}

function parseAddons(stdout: string): AddonInfo[] {
  const raw = JSON.parse(extractMarked(stdout)) as RawAddon[]
  const str = (value: unknown): string | null => (typeof value === 'string' && value ? value : null)
  return raw.map((entry) => {
    const module = String(entry.module)
    const origin = entry.origin === 'bundled' || entry.origin === 'extension' ? entry.origin : 'user'
    return {
      module,
      name: typeof entry.name === 'string' && entry.name ? entry.name : module,
      version: str(entry.version),
      category: typeof entry.category === 'string' ? entry.category : '',
      enabled: entry.enabled === true,
      origin,
      repoModule: str(entry.repoModule),
      pkgId: str(entry.pkgId),
      blInfoId: str(entry.blInfoId),
      author: str(entry.author),
      description: str(entry.description),
      website: str(entry.website)
    } satisfies AddonInfo
  })
}

/** one representative install per config generation (highest patch of each major.minor) */
export function representativesByMinor(installed: InstalledBuild[]): InstalledBuild[] {
  const byMinor = new Map<string, InstalledBuild>()
  for (const build of installed) {
    const minor = minorOf(build.version)
    const current = byMinor.get(minor)
    if (!current || compareVersionsDesc(build.version, current.version) < 0) {
      byMinor.set(minor, build)
    }
  }
  return [...byMinor.values()].sort((a, b) => compareVersionsDesc(a.version, b.version))
}

export async function scanAllAddons(
  onProgress?: (progress: AddonScanProgress) => void
): Promise<VersionAddons[]> {
  const targets = representativesByMinor(await listInstalled())
  if (targets.length === 0) return []
  const scriptPath = await writeDataFile('.addon-read.py', READ_SCRIPT)
  const total = targets.length
  const results: VersionAddons[] = []

  for (let index = 0; index < targets.length; index++) {
    const build = targets[index]
    const minor = minorOf(build.version)
    onProgress?.({ minor, version: build.version, index, total, phase: 'scanning' })
    const base = { installId: build.id, version: build.version, minor, releaseCycle: build.releaseCycle }

    // fast path: read config files directly; anything unfamiliar falls through
    // to the headless run below, which is always the source of truth
    try {
      const direct = await scanVersionDirect(build)
      direct.addons = dropHiddenSystem(direct.addons)
      await appendCoreGraduated(build, direct.addons)
      results.push(direct)
      onProgress?.({ minor, version: build.version, index, total, phase: 'done' })
      continue
    } catch {
      // fall through to the headless scan
    }

    try {
      // no --factory-startup: the real user preferences are where the enabled list lives
      const stdout = await runBlenderScript(
        build.executable,
        ['--background', '--python-exit-code', '1', '--python', scriptPath],
        { timeoutMs: SCAN_TIMEOUT_MS, failMessage: 'Blender could not report its add-ons' }
      )
      const addons = dropHiddenSystem(parseAddons(stdout))
      await appendCoreGraduated(build, addons)
      results.push({ ...base, addons, scanMethod: 'blender' })
      onProgress?.({ minor, version: build.version, index, total, phase: 'done' })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      results.push({ ...base, addons: [], error: message })
      onProgress?.({ minor, version: build.version, index, total, phase: 'error', error: message })
    }
  }
  return results
}
