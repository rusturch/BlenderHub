import { rm } from 'fs/promises'
import { listInstalled } from '../blender/installs'
import { backupInstalledAddon } from './backup'
import { downloadRelease, findCompatibleRelease } from './extensions-api'
import { findLibraryEntry, installBlocker, verifiedLibraryFile } from './library'
import { representativesByMinor } from './scan'
import { downloadSuperhiveArchive } from './superhive'
import { guardPrefs } from './prefs-guard'
import { BLENDER_POOL, ensureScript, extractMarked, mapPool, runBlenderScript, writeDataFile } from './runner'

/** appended to a failure line when the crash damaged preferences and the guard put them back */
const PREFS_RESTORED_NOTE = '(its preferences were damaged by the crash and have been restored)'
import { minorOf } from '../../shared/blender-archive'
import { compareVersionsDesc } from '../../shared/blender-builds'
import { groupAddons } from '../../shared/addon-identity'
import type { AddonGroupRow } from '../../shared/addon-identity'
import type {
  AddonApplyProgress,
  AddonInfo,
  ApplyPlanOutcome,
  ApplyPlanRequest,
  InstalledBuild,
  LibraryAddon,
  LibraryInstallProgress,
  PlanInstallRequest,
  PlanOpResult,
  VersionAddons
} from '../../shared/types'

// The whole Apply in two phases. Phase 1 (no Blender): resolve every install source to a
// local file — verify Library hashes, download Superhive / extensions.blender.org builds,
// pack carried copies into the Library. Phase 2: ONE headless Blender run per affected
// version executes ALL of that version's operations (uninstalls → installs → toggles) and
// saves preferences once — several add-ons into one version no longer relaunch Blender.
// Versions run in parallel (each minor owns its config dir); the python is a constant,
// data travels via a per-minor JSON file + env var, and every outcome is verified against
// what Blender actually registered — same invariants as the old single-op scripts.
const BATCH_SCRIPT = `import bpy, addon_utils, json, os, sys

with open(os.environ["BLH_BATCH_FILE"], "r", encoding="utf-8") as f:
    payload = json.load(f)

results = []

def is_enabled(module):
    return module in bpy.context.preferences.addons

def known_modules():
    return set(getattr(m, "__name__", "") for m in addon_utils.modules(refresh=True))

# bpy.ops raises on ANY Error-level report, including noise from unrelated broken
# repositories — so the verified registry state decides success, not the exception.

# 1) uninstalls first: a version switch frees the slot before the new copy lands
for op in payload.get("uninstall", []):
    module = op["module"]
    repo = op.get("repo") or ""
    pkg = op.get("pkg") or ""
    error = None
    # disable first so a live registration can't hold files open (best-effort)
    try:
        bpy.ops.preferences.addon_disable(module=module)
    except Exception:
        pass
    if module.startswith("bl_ext.") and repo and pkg:
        # 4.2+ extension — remove via the extensions system (find the repo by its module name)
        try:
            repos = bpy.context.preferences.extensions.repos
            idx = -1
            for i, r in enumerate(repos):
                if getattr(r, "module", "") == repo:
                    idx = i
                    break
            if idx < 0:
                error = "The add-on's extension repository is not registered in this Blender"
            else:
                bpy.ops.extensions.package_uninstall(repo_index=idx, pkg_id=pkg)
        except Exception as exc:
            error = str(exc)
    else:
        # legacy add-on — addon_remove disables it and deletes its files from the user scripts dir
        try:
            bpy.ops.preferences.addon_remove(module=module)
        except Exception as exc:
            error = str(exc)
    removed = module not in known_modules() and not is_enabled(module)
    results.append({"op": "uninstall", "id": module, "ok": removed,
                    "error": None if removed else (error or "Blender still lists the add-on after the remove operator ran")})

# 2) installs — earlier ops in this same process may have changed the on-disk set,
# so the before/after registry checks always refresh
for op in payload.get("install", []):
    path = op["path"]
    opid = op["id"]
    error = None
    if op["format"] == "extension":
        module = "bl_ext.user_default." + op["pkg"]
        old = op.get("retire")
        result = None
        try:
            result = bpy.ops.extensions.package_install_files(filepath=path, repo="user_default", enable_on_install=True)
        except Exception as exc:
            error = str(exc)
        installed = module in known_modules()
        enabled = is_enabled(module)
        if not installed and error is None:
            status = ",".join(sorted(result)) if result else "no result"
            error = "Blender rejected the extension (" + status + ") — likely not compatible with this Blender version"
        if installed and enabled:
            error = None
        # when replacing a dangling entry from another repo, retire the dead module so
        # Blender stops trying to load it at startup
        if installed and old and old != module:
            try:
                bpy.ops.preferences.addon_disable(module=old)
            except Exception:
                pass
        old_enabled = bool(old) and is_enabled(old)
        results.append({"op": "install", "id": opid, "ok": installed, "module": module,
                        "enabled": enabled, "error": error, "oldEnabled": old_enabled})
    else:
        expected = op["module"]
        before = known_modules()
        try:
            bpy.ops.preferences.addon_install(overwrite=True, filepath=path)
        except Exception as exc:
            error = str(exc)
        after = known_modules()
        # the freshly-appeared module is the truth; fall back to the launcher's parsed name
        fresh = sorted(after - before)
        module = expected if expected in after else (fresh[0] if fresh else expected)
        if module not in after and error is None:
            error = "Blender did not report the add-on as installed (unexpected archive layout?)"
        if module in after:
            try:
                bpy.ops.preferences.addon_enable(module=module)
            except Exception as exc:
                error = str(exc)
        enabled = is_enabled(module)
        if module in after and enabled:
            error = None
        results.append({"op": "install", "id": opid, "ok": module in after, "module": module,
                        "enabled": enabled, "error": error})

# 3) plain enable/disable toggles
for module in payload.get("enable", []):
    error = None
    try:
        bpy.ops.preferences.addon_enable(module=module)
    except Exception as exc:
        error = str(exc)
    ok = is_enabled(module)
    results.append({"op": "enable", "id": module, "ok": ok,
                    "error": None if ok else (error or "Blender refused to enable it (see its console output)")})

for module in payload.get("disable", []):
    error = None
    try:
        bpy.ops.preferences.addon_disable(module=module)
    except Exception as exc:
        error = str(exc)
    still = is_enabled(module)
    results.append({"op": "disable", "id": module, "ok": not still,
                    "error": (error or "Blender did not disable it") if still else None})

try:
    bpy.ops.wm.save_userpref()
except Exception as exc:
    sys.stderr.write("<<<BHUB_ERROR>>>could not save preferences: " + str(exc) + "<<<BHUB_END>>>\\n")
    sys.stderr.flush()
    raise SystemExit(1)

sys.stdout.write("<<<BHUB_ADDONS>>>" + json.dumps(results) + "<<<BHUB_END>>>\\n")
sys.stdout.flush()
`

const atLeast = (version: string, base: string): boolean => compareVersionsDesc(version, base) <= 0
const EXTENSIONS_SINCE = '4.2'

interface ResolvedInstall {
  request: PlanInstallRequest
  /** position in the plan — keys the batch op so results map back exactly */
  seq: number
  format: 'legacy' | 'extension'
  path: string
  /** legacy → expected module; extension → pkg id */
  moduleId: string
  /** dangling module from another repo to retire after a successful extension install */
  retire?: string
  name: string
  version: string | null
  /** downloaded temp file — delete after the batches ran */
  cleanup: boolean
}

interface MinorBatch {
  minor: string
  build: InstalledBuild
  uninstalls: { module: string; repo: string; pkg: string }[]
  installs: ResolvedInstall[]
  enable: string[]
  disable: string[]
}

interface RawBatchResult {
  op: unknown
  id: unknown
  ok: unknown
  module?: unknown
  enabled?: unknown
  oldEnabled?: unknown
  error?: unknown
}

export async function applyPlan(
  cache: VersionAddons[] | null,
  plan: ApplyPlanRequest,
  onResolve?: (progress: LibraryInstallProgress) => void,
  onApply?: (progress: AddonApplyProgress) => void
): Promise<ApplyPlanOutcome> {
  const builds = new Map(
    representativesByMinor(await listInstalled()).map((build) => [minorOf(build.version), build])
  )
  const results: PlanOpResult[] = []
  const libraryChangedRef = { value: false }

  // ---- phase 1: resolve every install source to a local file (no Blender yet) ----
  let rowsCache: AddonGroupRow[] | null = null
  const rowsFor = (): AddonGroupRow[] => (rowsCache ??= groupAddons(cache ?? []))
  const verifiedFiles = new Map<string, Promise<string>>() // library id → hash-checked path
  const packs = new Map<string, Promise<LibraryAddon>>() // module@@sourceMinor → packed entry
  const resolved: ResolvedInstall[] = []
  const resolveTotal = plan.installs.length
  let resolveDone = 0

  await mapPool(plan.installs, BLENDER_POOL, async (request, seq) => {
    const fail = (status: 'skipped' | 'error', detail: string): void => {
      results.push({ op: 'install', minor: request.minor, id: request.id, status, detail })
    }
    try {
      const build = builds.get(request.minor)
      if (!build) return fail('error', 'This version is no longer installed')

      if (request.kind === 'library') {
        const entry = await findLibraryEntry(request.id)
        const blocked = installBlocker(entry, request.minor)
        if (blocked) return fail('skipped', blocked)
        let file = verifiedFiles.get(entry.id)
        if (!file) {
          file = verifiedLibraryFile(entry)
          verifiedFiles.set(entry.id, file)
        }
        resolved.push({
          request,
          seq,
          format: entry.format,
          path: await file,
          moduleId: entry.moduleId,
          name: entry.name,
          version: entry.version,
          cleanup: false
        })
        return
      }

      if (request.kind === 'superhive') {
        if (!atLeast(request.minor, EXTENSIONS_SINCE)) return fail('skipped', 'Extensions require Blender 4.2+')
        const got = await downloadSuperhiveArchive(build, request.id)
        if (!got.archive) return fail('skipped', got.skip ?? 'Not available on Superhive')
        resolved.push({
          request,
          seq,
          format: 'extension',
          path: got.archive.path,
          moduleId: request.id,
          name: got.archive.name,
          version: got.archive.version,
          cleanup: true
        })
        return
      }

      if (request.kind === 'blender_org') {
        // the id IS the catalog package id, same contract as Superhive. It cannot be derived
        // from a scanned row: most rows offering this source are catalog-only (the add-on is
        // installed nowhere yet). The listing below is the authority on whether the package
        // exists, and the download stays host-allowlisted + sha256-verified either way.
        const pkgId = request.id
        if (!atLeast(request.minor, EXTENSIONS_SINCE)) {
          return fail('skipped', 'Extensions require Blender 4.2+ — for older versions add a legacy .zip to the Library')
        }
        // a scanned row exists only once the add-on is installed somewhere; it decides
        // "already installed here" and which dangling module to retire. Custom-repo copies keep
        // their quarantined `ext:<pkg>@<repo>` id, so they never match an official package.
        const row = cache ? rowsFor().find((candidate) => candidate.canonicalId === `ext:${pkgId}`) : undefined
        const cell = row?.perMinor.get(request.minor)
        if (cell && !cell.missing) return fail('skipped', 'Already installed here — use its toggle instead')
        const fullVersion = /^\d+\.\d+\.\d+/.exec(build.version)?.[0] ?? `${request.minor}.0`
        const release = await findCompatibleRelease(pkgId, fullVersion)
        if (!release) return fail('skipped', `Not available for Blender ${request.minor} on extensions.blender.org`)
        const path = await downloadRelease(release)
        // a dangling entry from another repo gets retired in the same run
        const stale = cell?.module ?? null
        resolved.push({
          request,
          seq,
          format: 'extension',
          path,
          moduleId: pkgId,
          retire: stale && stale !== `bl_ext.user_default.${pkgId}` ? stale : undefined,
          name: release.name,
          version: release.version,
          cleanup: true
        })
        return
      }

      // backup: pack the installed copy from its source version into the Library, then
      // install that stored file — one pack feeds every target version of this request
      const module = request.module
      const sourceMinor = request.sourceMinor
      if (!module || !sourceMinor) return fail('error', 'Malformed carry request')
      const sourceBuild = builds.get(sourceMinor)
      if (!sourceBuild) return fail('error', `Blender ${sourceMinor} (the copy's source) is no longer installed`)
      const sourceEntry = cache?.find((candidate) => candidate.minor === sourceMinor)
      const addon = sourceEntry?.addons.find((candidate) => candidate.module === module)
      if (!addon) return fail('error', 'Add-on not found in the scanned data — rescan first')
      const packKey = `${module}@@${sourceMinor}`
      let pack = packs.get(packKey)
      if (!pack) {
        pack = backupInstalledAddon(sourceBuild, sourceMinor, addon).then(({ entry, existed }) => {
          if (!existed) libraryChangedRef.value = true
          return entry
        })
        packs.set(packKey, pack)
      }
      const saved = await pack
      const blocked = installBlocker(saved, request.minor)
      if (blocked) return fail('skipped', blocked)
      let file = verifiedFiles.get(saved.id)
      if (!file) {
        file = verifiedLibraryFile(saved)
        verifiedFiles.set(saved.id, file)
      }
      resolved.push({
        request,
        seq,
        format: saved.format,
        path: await file,
        moduleId: saved.moduleId,
        name: saved.name,
        version: saved.version,
        cleanup: false
      })
    } catch (error) {
      fail('error', error instanceof Error ? error.message : String(error))
    } finally {
      resolveDone++
      onResolve?.({
        libraryId: request.id,
        minor: request.minor,
        index: Math.max(0, resolveDone - 1),
        total: resolveTotal,
        phase: 'installing'
      })
    }
  })
  resolved.sort((a, b) => a.seq - b.seq)

  // from here on downloaded temp files exist — the finally below always deletes them,
  // even when toggle validation throws before any Blender ran
  try {
    // ---- collect per-version batches (uninstalls, installs, toggles) ----
    return await runBatches(cache, plan, builds, resolved, results, libraryChangedRef, onApply)
  } finally {
    await Promise.all(
      resolved.filter((item) => item.cleanup).map((item) => rm(item.path, { force: true }).catch(() => {}))
    )
  }
}

async function runBatches(
  cache: VersionAddons[] | null,
  plan: ApplyPlanRequest,
  builds: Map<string, InstalledBuild>,
  resolved: ResolvedInstall[],
  results: PlanOpResult[],
  libraryChangedRef: { value: boolean },
  onApply?: (progress: AddonApplyProgress) => void
): Promise<ApplyPlanOutcome> {
  const batches = new Map<string, MinorBatch>()
  const batchFor = (minor: string, build: InstalledBuild): MinorBatch => {
    let batch = batches.get(minor)
    if (!batch) {
      batch = { minor, build, uninstalls: [], installs: [], enable: [], disable: [] }
      batches.set(minor, batch)
    }
    return batch
  }

  for (const target of plan.uninstalls) {
    const entry = cache?.find((candidate) => candidate.minor === target.minor)
    const addon = entry?.addons.find((candidate) => candidate.module === target.module)
    const build = builds.get(target.minor)
    if (!addon) {
      results.push({ op: 'uninstall', minor: target.minor, id: target.module, status: 'skipped', detail: 'Not in the scan — rescan first' })
      continue
    }
    if (!build) {
      results.push({ op: 'uninstall', minor: target.minor, id: target.module, status: 'skipped', detail: 'This version is no longer installed' })
      continue
    }
    if (addon.origin !== 'user' && addon.origin !== 'extension') {
      results.push({ op: 'uninstall', minor: target.minor, id: target.module, status: 'skipped', detail: 'Built-in add-ons cannot be removed' })
      continue
    }
    batchFor(target.minor, build).uninstalls.push({
      module: target.module,
      repo: addon.origin === 'extension' ? (addon.repoModule ?? '') : '',
      pkg: addon.origin === 'extension' ? (addon.pkgId ?? '') : ''
    })
  }

  for (const item of resolved) {
    const build = builds.get(item.request.minor)
    if (build) batchFor(item.request.minor, build).installs.push(item)
  }

  // toggles reject unknown modules outright (same contract as the old apply handler):
  // the module must match what OUR scan read from that very version
  const snapshot = cache
  const toggles: { list: { minor: string; module: string }[]; key: 'enable' | 'disable' }[] = [
    { list: plan.enable, key: 'enable' },
    { list: plan.disable, key: 'disable' }
  ]
  for (const { list, key } of toggles) {
    for (const { minor, module } of list) {
      if (!snapshot) throw new Error('Scan the versions first')
      const entry = snapshot.find((candidate) => candidate.minor === minor)
      if (!entry || entry.error) throw new Error(`No scanned data for Blender ${minor} — rescan first`)
      if (!entry.addons.some((candidate) => candidate.module === module)) {
        throw new Error(`Unknown add-on module for Blender ${minor} — rescan first`)
      }
      const build = builds.get(minor)
      if (!build) {
        results.push({ op: key, minor, id: module, status: 'skipped', detail: 'This version is no longer installed' })
        continue
      }
      batchFor(minor, build)[key].push(module)
    }
  }

  // ---- phase 2: one headless Blender per affected version, in parallel ----
  const work = [...batches.values()].filter(
    (batch) => batch.uninstalls.length + batch.installs.length + batch.enable.length + batch.disable.length > 0
  )
  const total = work.length
  const scriptPath = await ensureScript('.addon-batch.py', BATCH_SCRIPT)

  await mapPool(work, BLENDER_POOL, async (batch, index) => {
    onApply?.({ minor: batch.minor, index, total, phase: 'applying' })
    // restore point for this version's preferences: a crash inside save_userpref would
    // otherwise leave them truncated (see prefs-guard.ts)
    const guard = await guardPrefs(batch.build.executable, batch.minor)
    try {
      const payloadPath = await writeDataFile(
        `.addon-batch-${batch.minor}.json`,
        JSON.stringify({
          uninstall: batch.uninstalls,
          install: batch.installs.map((item) => ({
            id: String(item.seq),
            format: item.format,
            path: item.path,
            module: item.format === 'legacy' ? item.moduleId : undefined,
            pkg: item.format === 'extension' ? item.moduleId : undefined,
            retire: item.retire
          })),
          enable: batch.enable,
          disable: batch.disable
        })
      )
      const timeoutMs = Math.min(
        600_000,
        120_000 +
          60_000 * (batch.uninstalls.length + batch.installs.length) +
          (batch.enable.length + batch.disable.length > 0 ? 30_000 : 0)
      )
      const stdout = await runBlenderScript(
        batch.build.executable,
        ['--background', '--python-exit-code', '1', '--python', scriptPath],
        { timeoutMs, env: { BLH_BATCH_FILE: payloadPath }, failMessage: 'Blender could not apply the changes' }
      )
      const raw = JSON.parse(extractMarked(stdout)) as RawBatchResult[]
      foldBatchResults(cache, batch, raw, results)
      onApply?.({ minor: batch.minor, index, total, phase: 'done' })
    } catch (error) {
      const failure = error instanceof Error ? error.message : String(error)
      // the run failed as a whole — nothing was reliably written for this version
      const restored = (await guard.finish()) === 'restored'
      const message = restored ? `${failure} ${PREFS_RESTORED_NOTE}` : failure
      for (const op of batch.uninstalls) {
        results.push({ op: 'uninstall', minor: batch.minor, id: op.module, status: 'error', detail: message })
      }
      for (const item of batch.installs) {
        results.push({ op: 'install', minor: batch.minor, id: item.request.id, status: 'error', detail: message })
      }
      for (const module of batch.enable) {
        results.push({ op: 'enable', minor: batch.minor, id: module, status: 'error', detail: message })
      }
      for (const module of batch.disable) {
        results.push({ op: 'disable', minor: batch.minor, id: module, status: 'error', detail: message })
      }
      onApply?.({ minor: batch.minor, index, total, phase: 'error', error: message })
      return
    }
    await guard.finish()
  })

  return { results, data: cache, libraryChanged: libraryChangedRef.value }
}

/** fold one version's verified batch report into the shared cache + result list */
function foldBatchResults(
  cache: VersionAddons[] | null,
  batch: MinorBatch,
  raw: RawBatchResult[],
  results: PlanOpResult[]
): void {
  let entry = cache?.find((candidate) => candidate.minor === batch.minor) ?? null
  if (cache && !entry) {
    // a version installed since the last scan — synthesize a matrix entry
    entry = {
      installId: batch.build.id,
      version: batch.build.version,
      minor: batch.minor,
      releaseCycle: batch.build.releaseCycle,
      addons: [],
      scanMethod: 'blender'
    }
    cache.push(entry)
  }

  for (const item of raw) {
    const ok = item.ok === true
    const error = typeof item.error === 'string' && item.error ? item.error : null

    if (item.op === 'uninstall') {
      const module = String(item.id)
      if (ok && entry) entry.addons = entry.addons.filter((candidate) => candidate.module !== module)
      results.push({
        op: 'uninstall',
        minor: batch.minor,
        id: module,
        status: ok ? 'ok' : 'error',
        detail: ok ? null : (error ?? 'Blender did not remove it')
      })
      continue
    }

    if (item.op === 'install') {
      const source = batch.installs.find((candidate) => String(candidate.seq) === String(item.id))
      if (!source) continue
      if (!ok) {
        results.push({
          op: 'install',
          minor: batch.minor,
          id: source.request.id,
          status: 'error',
          detail: error ?? 'Blender did not install the add-on'
        })
        continue
      }
      const module = typeof item.module === 'string' && item.module ? item.module : source.moduleId
      const enabled = item.enabled === true
      if (entry) {
        // drop the retired dangling record only when Blender confirmed it is gone
        if (source.retire && source.retire !== module && item.oldEnabled !== true) {
          entry.addons = entry.addons.filter((candidate) => candidate.module !== source.retire)
        }
        const isExtension = source.format === 'extension'
        const addon: AddonInfo = {
          module,
          name: source.name,
          version: source.version,
          category: '',
          enabled,
          origin: isExtension ? 'extension' : 'user',
          repoModule: isExtension ? 'user_default' : null,
          pkgId: isExtension ? source.moduleId : null,
          blInfoId: null,
          author: null
        }
        const existing = entry.addons.findIndex((candidate) => candidate.module === module)
        if (existing >= 0) entry.addons[existing] = addon
        else entry.addons.push(addon)
      }
      results.push({
        op: 'install',
        minor: batch.minor,
        id: source.request.id,
        status: 'ok',
        detail: error
          ? `Installed, but enabling failed: ${error}`
          : source.version
            ? `v${source.version}`
            : null
      })
      continue
    }

    if (item.op === 'enable' || item.op === 'disable') {
      const module = String(item.id)
      const addon = entry?.addons.find((candidate) => candidate.module === module)
      // the real post-write state, as Blender reported it
      if (addon) addon.enabled = item.op === 'enable' ? ok : !ok
      results.push({
        op: item.op,
        minor: batch.minor,
        id: module,
        status: ok ? 'ok' : 'error',
        detail: ok ? null : error
      })
    }
  }
}
