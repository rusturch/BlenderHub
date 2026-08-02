import { stat } from 'fs/promises'
import { join } from 'path'
import { parseUserpref } from '../addons/userpref-parser'
import { standardUserBase } from '../addons/blender-paths'
import {
  BLENDER_POOL,
  ensureScript,
  extractMarked,
  mapPool,
  runBlenderScript,
  writeDataFile
} from '../addons/runner'
import type {
  SettingsSyncOutcome,
  SettingsSyncRequest,
  SyncApplyProgress,
  SyncComponentId,
  SyncOpResult
} from '../../shared/types'
import { getAssetLibraryFixupExtra } from '../asset-library/service'
import { copyComponentItems, expandEntries, fingerprintComponent } from './components'
import type { ComponentFingerprint, ResolvedItem } from './components'
import { createSnapshot, findBackup } from './backups'
import { resolveColumns, scanSettings } from './scan'
import { baselineKey, readSyncState, updateSyncState } from './state'
import type { BaselineEntry } from './state'

// After copying userpref.blend from another version, the target would wake up with the
// SOURCE's enabled-add-on list. This script (run headless in the TARGET version, which
// loads the freshly copied prefs) swaps that list back to what the target had before
// the copy — everything else in the copied preferences stays — then saves, which also
// rewrites the file in the target version's own format. Same invariants as the add-ons
// batch script: constant code, payload via file + env var, registry state decides success.
export const FIXUP_SCRIPT = `import bpy, json, os, sys

with open(os.environ["BLH_SYNC_FILE"], "r", encoding="utf-8") as f:
    payload = json.load(f)

enabled = payload.get("enabled")

def is_enabled(module):
    return module in bpy.context.preferences.addons

current = set(a.module for a in bpy.context.preferences.addons)

# enabled == None -> the launcher could not read the previous list: keep whatever
# the copied preferences enable; this run only re-saves in this version's format
desired = set(enabled) if enabled is not None else set(current)

results = []

# bpy.ops raises on ANY Error-level report, including noise from unrelated broken
# repositories — so the verified registry state decides success, not the exception.
for module in sorted(current - desired):
    error = None
    try:
        bpy.ops.preferences.addon_disable(module=module)
    except Exception as exc:
        error = str(exc)
    still = is_enabled(module)
    results.append({"op": "disable", "module": module, "ok": not still,
                    "error": (error or "Blender did not disable it") if still else None})

for module in sorted(desired - current):
    error = None
    try:
        bpy.ops.preferences.addon_enable(module=module)
    except Exception as exc:
        error = str(exc)
    ok = is_enabled(module)
    results.append({"op": "enable", "module": module, "ok": ok,
                    "error": None if ok else (error or "could not enable it — its files may be missing, or its extension repository is not part of the copied preferences")})

# the copied preferences carry the SOURCE's asset-library list; the launcher's
# own entry must survive the copy — restored here so the very save that fixes
# the add-ons also fixes the library (no drift, no extra launch). The payload is
# attached per TARGET and only when the launcher recorded a registration there
# (getAssetLibraryFixupExtra), so a base the user removed the entry from never
# gets it back through this side path. Path-first match: an entry already
# pointing at the folder counts, whatever its name.
lib = payload.get("asset_library")
if lib:
    libs = bpy.context.preferences.filepaths.asset_libraries
    def lib_path(e):
        return e.path if hasattr(e, "path") else getattr(e, "directory", "")
    def lib_set_path(e, value):
        if hasattr(e, "path"):
            e.path = value
        else:
            e.directory = value
    def lib_norm(p):
        return os.path.normcase(os.path.normpath(p)) if p else ""
    directory = os.path.normpath(lib["dir"])
    if not any(lib_norm(lib_path(e)) == lib_norm(directory) for e in libs):
        match = next((e for e in libs if e.name == lib["name"]), None)
        if match is not None:
            lib_set_path(match, directory)
        elif callable(getattr(libs, "new", None)):
            try:
                entry = libs.new(name=lib["name"], directory=directory)
            except TypeError:
                entry = libs.new(name=lib["name"])
                lib_set_path(entry, directory)
            if hasattr(entry, "import_method"):
                for method in ("APPEND_REUSE", "PACK", "APPEND"):
                    try:
                        entry.import_method = method
                        break
                    except TypeError:
                        continue
        else:
            bpy.ops.preferences.asset_library_add(directory=directory)
            libs[len(libs) - 1].name = lib["name"]

try:
    bpy.ops.wm.save_userpref()
except Exception as exc:
    sys.stderr.write("<<<BHUB_ERROR>>>could not save preferences: " + str(exc) + "<<<BHUB_END>>>\\n")
    sys.stderr.flush()
    raise SystemExit(1)

sys.stdout.write("<<<BHUB_ADDONS>>>" + json.dumps(results) + "<<<BHUB_END>>>\\n")
sys.stdout.flush()
`

interface FixupRaw {
  op: string
  module: string
  ok: boolean
  error: string | null
}

const setsEqual = (a: Set<string>, b: Set<string>): boolean =>
  a.size === b.size && [...a].every((value) => b.has(value))

async function readEnabledModules(base: string): Promise<Set<string> | null> {
  return new Set((await parseUserpref(join(base, 'config', 'userpref.blend'))).enabledModules)
}

export async function applySettingsSync(
  request: SettingsSyncRequest,
  onProgress?: (progress: SyncApplyProgress) => void
): Promise<SettingsSyncOutcome> {
  const columns = await resolveColumns()
  const byMinor = new Map(columns.map((entry) => [entry.column.minor, entry]))

  const source = byMinor.get(request.sourceMinor)
  if (!source) throw new Error(`No settings found for Blender ${request.sourceMinor}`)
  const targets = request.targets.map(({ minor, components }) => {
    const target = byMinor.get(minor)
    // targets must be installed: creating config for a version that cannot run is pointless,
    // and the preserve-add-ons pass needs an executable
    if (!target?.column.installed || !target.executable) throw new Error(`Blender ${minor} is not installed`)
    return { entry: target, components }
  })

  // what actually exists in the source decides the work; a component missing there is
  // reported per target as skipped — target files are never deleted because of it
  const allComponents = [...new Set(request.targets.flatMap((target) => target.components))]
  const sourceItems = new Map<SyncComponentId, ResolvedItem[]>()
  for (const component of allComponents) {
    sourceItems.set(component, await expandEntries(source.base, component))
  }
  const prefsInSource = (sourceItems.get('preferences')?.length ?? 0) > 0

  // source fingerprints are captured BEFORE any copying: if the user edits the
  // source mid-run, the baseline must reflect what actually traveled — a too-old
  // fingerprint safely re-flags "source changed", a too-new one would hide it
  const sourceFp = new Map<SyncComponentId, ComponentFingerprint>()
  for (const component of allComponents) {
    if ((sourceItems.get(component)?.length ?? 0) > 0) {
      sourceFp.set(component, await fingerprintComponent(source.base, component))
    }
  }

  // source's enabled set powers the "already matches" shortcut; a failed parse just skips it
  let sourceEnabled: Set<string> | null = null
  const anyPrefsTarget = targets.some(({ components }) => components.includes('preferences'))
  if (prefsInSource && anyPrefsTarget) {
    sourceEnabled = await readEnabledModules(source.base).catch(() => null)
  }

  const results: SyncOpResult[] = []
  // cells whose copy succeeded — their baselines are re-recorded after the run
  const appliedCells: { minor: string; component: SyncComponentId }[] = []
  const total = targets.length

  await mapPool(targets, BLENDER_POOL, async ({ entry: target, components }, index) => {
    const minor = target.column.minor
    const report = (
      component: SyncOpResult['component'],
      status: SyncOpResult['status'],
      detail: string | null = null
    ): void => {
      results.push({ minor, component, status, detail })
    }
    const copiesPrefs = components.includes('preferences') && prefsInSource

    // Sync NEVER changes which add-ons are enabled — that is the Add-ons tab's job.
    // Copying userpref.blend would smuggle the source's enabled list in, so the
    // target's own set is read BEFORE the file gets replaced and put back after.
    let savedModules: Set<string> | null = null
    if (copiesPrefs) {
      const prefsPath = join(target.base, 'config', 'userpref.blend')
      const exists = await stat(prefsPath).then(
        (found) => found.isFile(),
        () => false
      )
      if (exists) {
        // null = unreadable: the fixup still runs (normalize-only), with a note
        savedModules = await readEnabledModules(target.base).catch(() => null)
      } else {
        // no previous prefs = nothing was enabled here; strip the source's list too
        savedModules = new Set()
      }
    }

    onProgress?.({ minor, index, total, phase: 'backup' })
    try {
      const snapshot = await createSnapshot(minor, target.base, components, 'sync', request.sourceMinor)
      if (snapshot) report('backup', 'ok', `Replaced files saved as backup ${snapshot.id}`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      report('backup', 'error', message)
      for (const component of components) {
        report(component, 'skipped', 'Skipped — the safety backup failed, nothing was overwritten')
      }
      onProgress?.({ minor, index, total, phase: 'error', error: message })
      return
    }

    onProgress?.({ minor, index, total, phase: 'copying' })
    const copied: SyncComponentId[] = []
    for (const component of components) {
      const items = sourceItems.get(component) ?? []
      if (items.length === 0) {
        report(component, 'skipped', 'Not present in the source version')
        continue
      }
      try {
        await copyComponentItems(source.base, target.base, items)
        copied.push(component)
        appliedCells.push({ minor, component })
        report(component, 'ok', null)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        report(
          component,
          'error',
          /EBUSY|EPERM/i.test(message)
            ? `${message} — close Blender ${minor} and retry (the backup above can restore this version)`
            : message
        )
      }
    }

    // Gate on ATTEMPTED, not fully-succeeded: a partial copy failure (a locked
    // template file after the main userpref.blend was already replaced) must
    // still get the fixup, or the target would wake with the SOURCE's add-ons.
    let prefsFixupFailed = false
    if (copiesPrefs) {
      // The re-save is UNCONDITIONAL, even when the add-on sets already match:
      // besides restoring the target's enabled add-ons it rewrites the copied
      // file in the target version's OWN format. Without that, the drift
      // baseline would hold a foreign-version file, and the first no-change
      // re-save inside that Blender (versioning code runs on load) would flag
      // a false "changed in that version".
      onProgress?.({ minor, index, total, phase: 'fixup' })
      try {
        const scriptPath = await ensureScript('.settings-sync-fixup.py', FIXUP_SCRIPT)
        // launcher asset library (when this TARGET is recorded as registered):
        // restored by the fixup in the same save, so an Apply from a
        // not-yet-registered source cannot strip the target's entry
        const assetLibraryExtra = await getAssetLibraryFixupExtra(target.base).catch(() => null)
        const payloadPath = await writeDataFile(
          `.sync-fixup-${minor}.json`,
          JSON.stringify({
            enabled: savedModules ? [...savedModules] : null,
            asset_library: assetLibraryExtra
          })
        )
        const stdout = await runBlenderScript(
          target.executable as string,
          ['--background', '--python-exit-code', '1', '--python', scriptPath],
          {
            // one prefs load + one toggle pass — far below the add-ons batch ceiling
            timeoutMs: 150_000,
            env: { BLH_SYNC_FILE: payloadPath },
            failMessage: 'Blender could not restore the enabled add-ons'
          }
        )
        const raw = JSON.parse(extractMarked(stdout)) as FixupRaw[]
        const failed = raw.filter((item) => !item.ok)
        if (failed.length === 0) {
          const summary = !savedModules
            ? 'Re-saved by this version; the previous enabled-add-on list could not be read — review it on the Add-ons tab'
            : sourceEnabled && setsEqual(savedModules, sourceEnabled)
              ? "Enabled add-ons already matched — re-saved in this version's own format"
              : savedModules.size > 0
                ? `Kept this version's enabled add-ons (${savedModules.size})`
                : "Removed the source's enabled-add-on list (this version had none enabled)"
          report('addons-fixup', 'ok', summary)
        } else {
          prefsFixupFailed = true
          report(
            'addons-fixup',
            'error',
            `Preferences were copied, but some add-ons could not be re-matched: ${failed
              .map((item) => `${item.module} (${item.error ?? `${item.op} failed`})`)
              .join('; ')}`
          )
        }
      } catch (error) {
        prefsFixupFailed = true
        const message = error instanceof Error ? error.message : String(error)
        report('addons-fixup', 'error', `Preferences were copied, but re-applying the enabled add-ons failed: ${message}`)
      }
    }

    // a failed fixup means the prefs sync did NOT complete (foreign format, maybe
    // the source's add-on list) — no baseline, so the cell stays actionable and a
    // retry Apply re-copies instead of everything looking "in sync"
    if (prefsFixupFailed) {
      const applied = appliedCells.findIndex(
        (cell) => cell.minor === minor && cell.component === 'preferences'
      )
      if (applied >= 0) appliedCells.splice(applied, 1)
    }

    const failedHere = results.some((result) => result.minor === minor && result.status === 'error')
    onProgress?.({ minor, index, total, phase: failedHere ? 'error' : 'done' })
  })

  // record baselines for drift detection — but only when this run flows from the
  // profile source (a reverse "pull into the source" must not fake sync points)
  const state = await readSyncState()
  if (appliedCells.length > 0 && state.links.sourceMinor === request.sourceMinor) {
    const entries: Record<string, BaselineEntry> = {}
    for (const { minor, component } of appliedCells) {
      const src = sourceFp.get(component) // captured before the copies, see above
      const target = byMinor.get(minor)
      if (!src || !target || src.hash === null) continue
      const tgt = await fingerprintComponent(target.base, component) // post-copy, post-fixup
      if (tgt.hash === null) continue
      entries[baselineKey(minor, component)] = {
        source: src.hash,
        target: tgt.hash,
        syncedAt: new Date().toISOString(),
        sourceFiles: src.files,
        targetFiles: tgt.files,
        ...(src.prefs ? { sourcePrefs: src.prefs } : {}),
        ...(tgt.prefs ? { targetPrefs: tgt.prefs } : {}),
        ...(src.lines ? { sourceLines: src.lines } : {}),
        ...(tgt.lines ? { targetLines: tgt.lines } : {})
      }
    }
    if (Object.keys(entries).length > 0) {
      await updateSyncState((current) => ({
        ...current,
        baselines: {
          ...current.baselines,
          [request.sourceMinor]: { ...(current.baselines[request.sourceMinor] ?? {}), ...entries }
        }
      }))
    }
  }

  return { results, data: await scanSettings() }
}

/**
 * Record the current state of a cell as its new sync point — no files move, both
 * sides are fingerprinted into the baseline. Used after "Copy into source…" to mark
 * the pulled pair as freshly in sync.
 */
export async function recordSyncPoint(
  minor: string,
  component: SyncComponentId
): Promise<SettingsSyncOutcome['data']> {
  const state = await readSyncState()
  const sourceKey = state.links.sourceMinor
  if (!sourceKey) throw new Error('No sync source is set')
  const resolved = await resolveColumns()
  const source = resolved.find((entry) => entry.column.minor === state.links.sourceMinor)
  const target = resolved.find((entry) => entry.column.minor === minor)
  if (!source || !target) throw new Error(`No settings found for Blender ${minor}`)
  const src = await fingerprintComponent(source.base, component)
  const tgt = await fingerprintComponent(target.base, component)
  if (src.hash === null || tgt.hash === null) throw new Error('Nothing to sync — the component is missing')
  const entry: BaselineEntry = {
    source: src.hash,
    target: tgt.hash,
    syncedAt: new Date().toISOString(),
    sourceFiles: src.files,
    targetFiles: tgt.files,
    ...(src.prefs ? { sourcePrefs: src.prefs } : {}),
    ...(tgt.prefs ? { targetPrefs: tgt.prefs } : {}),
    ...(src.lines ? { sourceLines: src.lines } : {}),
    ...(tgt.lines ? { targetLines: tgt.lines } : {})
  }
  await updateSyncState((current) => ({
    ...current,
    baselines: {
      ...current.baselines,
      [sourceKey]: { ...(current.baselines[sourceKey] ?? {}), [baselineKey(minor, component)]: entry }
    }
  }))
  return scanSettings()
}

export async function restoreSettingsBackup(
  backupId: string,
  onProgress?: (progress: SyncApplyProgress) => void
): Promise<SettingsSyncOutcome> {
  const { info, dir } = await findBackup(backupId)
  const filesDir = join(dir, 'files')
  // resolve the live base at restore time — an install may have appeared/vanished since
  const live = (await resolveColumns()).find((entry) => entry.column.minor === info.minor)
  const base = live?.base ?? standardUserBase(info.minor)

  const results: SyncOpResult[] = []
  const progress = (phase: SyncApplyProgress['phase'], error?: string): void =>
    onProgress?.({ minor: info.minor, index: 0, total: 1, phase, ...(error ? { error } : {}) })

  progress('backup')
  // the restore itself must be undoable — snapshot the current state first
  const undo = await createSnapshot(info.minor, base, info.components, 'restore', null)
  if (undo) results.push({ minor: info.minor, component: 'backup', status: 'ok', detail: `Current files saved as backup ${undo.id}` })

  progress('copying')
  for (const component of info.components) {
    const items = await expandEntries(filesDir, component)
    if (items.length === 0) {
      results.push({ minor: info.minor, component, status: 'skipped', detail: 'Nothing stored for this component' })
      continue
    }
    try {
      // exact bytes back, no fixup — this is an undo, not a merge
      await copyComponentItems(filesDir, base, items)
      results.push({ minor: info.minor, component, status: 'ok', detail: null })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      results.push({
        minor: info.minor,
        component,
        status: 'error',
        detail: /EBUSY|EPERM/i.test(message) ? `${message} — close Blender ${info.minor} and retry` : message
      })
    }
  }

  const failed = results.some((result) => result.status === 'error')
  progress(failed ? 'error' : 'done')
  return { results, data: await scanSettings() }
}
