import { readdir, stat } from 'fs/promises'
import { join } from 'path'
import { listInstalled } from '../blender/installs'
import { representativesByMinor } from '../addons/scan'
import { resolveUserDirs, standardUserBase, userBaseRoot } from '../addons/blender-paths'
import { minorOf } from '../../shared/blender-archive'
import { compareVersionsDesc } from '../../shared/blender-builds'
import { HIDDEN_SYNC_COMPONENT_IDS, SYNC_COMPONENT_IDS } from '../../shared/types'
import type {
  SyncCellStatus,
  SyncComponentId,
  SyncComponentState,
  SyncScanResult,
  SyncVersionColumn
} from '../../shared/types'
import { fingerprintComponent, fingerprintMatches, measureComponent } from './components'
import type { ComponentFingerprint, FileStamp } from './components'
import { describePrefsDrift } from './prefs-diff'
import type { DriftDescription } from './prefs-diff'
import { baselineKey, readSyncState, updateSyncState } from './state'
import type { BaselineEntry } from './state'

const MINOR_DIR_RE = /^\d+\.\d+$/

/** a matrix column plus everything main needs to act on it (never sent to the renderer) */
export interface ResolvedColumn {
  column: SyncVersionColumn
  base: string
  executable: string | null
}

/**
 * Every version that has settings on disk or an installed build. Installed minors
 * resolve through the executable (so portable installs get their portable base);
 * leftover config dirs of uninstalled versions still count — as sources only.
 */
export async function resolveColumns(): Promise<ResolvedColumn[]> {
  const byMinor = new Map<string, ResolvedColumn>()
  for (const build of representativesByMinor(await listInstalled())) {
    const minor = minorOf(build.version)
    const dirs = resolveUserDirs(build.executable, minor)
    byMinor.set(minor, {
      base: dirs.base,
      executable: build.executable,
      column: {
        minor,
        installed: true,
        installId: build.id,
        version: build.version,
        releaseCycle: build.releaseCycle,
        portable: dirs.portable,
        userprefMtimeMs: null,
        components: {} as Record<SyncComponentId, SyncComponentState>
      }
    })
  }
  let onDisk: string[] = []
  try {
    onDisk = (await readdir(userBaseRoot(), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && MINOR_DIR_RE.test(entry.name))
      .map((entry) => entry.name)
  } catch {
    onDisk = [] // no Blender config root on this machine yet
  }
  for (const minor of onDisk) {
    if (byMinor.has(minor)) continue
    byMinor.set(minor, {
      base: standardUserBase(minor),
      executable: null,
      column: {
        minor,
        installed: false,
        installId: null,
        version: null,
        releaseCycle: null,
        portable: false,
        userprefMtimeMs: null,
        components: {} as Record<SyncComponentId, SyncComponentState>
      }
    })
  }
  const resolved = [...byMinor.values()]
  await Promise.all(
    resolved.map(async (entry) => {
      for (const id of SYNC_COMPONENT_IDS) {
        entry.column.components[id] = await measureComponent(entry.base, id)
      }
      try {
        entry.column.userprefMtimeMs = (await stat(join(entry.base, 'config', 'userpref.blend'))).mtimeMs
      } catch {
        entry.column.userprefMtimeMs = null
      }
    })
  )
  // a config dir with nothing recognizable in it is noise, not a version
  const kept = resolved.filter(
    (entry) => entry.column.installed || SYNC_COMPONENT_IDS.some((id) => entry.column.components[id].present)
  )
  kept.sort((a, b) => compareVersionsDesc(a.column.minor, b.column.minor))
  return kept
}

// scripts/presets/<category>/… → the kind users see in the presets menus;
// unknown categories (add-ons ship their own) fall back to a prettified name
const PRESET_CATEGORY_LABELS: Record<string, string> = {
  interface_theme: 'Theme',
  keyconfig: 'Keymap',
  camera: 'Camera preset',
  cloth: 'Cloth preset',
  fluid: 'Fluid preset',
  hair_dynamics: 'Hair dynamics preset',
  gpencil_material: 'Grease Pencil material preset',
  brush: 'Brush preset',
  render: 'Render preset',
  ffmpeg: 'FFmpeg preset',
  framerate: 'Frame rate preset',
  safe_areas: 'Safe areas preset',
  tracking_camera: 'Tracking camera preset',
  tracking_settings: 'Tracking settings preset',
  tracking_track_color: 'Track color preset',
  cycles: 'Cycles preset',
  eevee: 'EEVEE preset',
  world: 'World preset'
}

/** "scripts/presets/interface_theme/My_Theme.xml" → "Theme 'My Theme'" */
function presetLine(rel: string): string {
  const parts = rel.split('/')
  if (parts.length < 4 || parts[0] !== 'scripts' || parts[1] !== 'presets') return rel
  const category = parts[2]
  const stem = parts[parts.length - 1].replace(/\.(py|xml)$/i, '').replace(/_/g, ' ')
  if (category === 'operator') {
    return parts.length >= 5 ? `Operator preset (${parts[3]}) '${stem}'` : `Operator preset '${stem}'`
  }
  const label =
    PRESET_CATEGORY_LABELS[category] ??
    `${category.charAt(0).toUpperCase()}${category.slice(1).replace(/_/g, ' ')} preset`
  return `${label} '${stem}'`
}

/** manifest diff of a dir component: "2 added, 1 changed" + one line per file */
function describeDrift(
  component: SyncComponentId,
  before: FileStamp[] | null,
  after: FileStamp[] | null
): DriftDescription | null {
  if (!before || !after) return null
  const beforeMap = new Map(before.map((stamp) => [stamp.rel, stamp]))
  const afterMap = new Map(after.map((stamp) => [stamp.rel, stamp]))
  const added = [...afterMap.keys()].filter((rel) => !beforeMap.has(rel))
  const removed = [...beforeMap.keys()].filter((rel) => !afterMap.has(rel))
  const changed = [...afterMap.entries()]
    .filter(([rel, stamp]) => {
      const old = beforeMap.get(rel)
      return old !== undefined && (old.size !== stamp.size || old.mtimeMs !== stamp.mtimeMs)
    })
    .map(([rel]) => rel)
  const parts: string[] = []
  if (added.length > 0) parts.push(`${added.length} added`)
  if (removed.length > 0) parts.push(`${removed.length} removed`)
  if (changed.length > 0) parts.push(`${changed.length} changed`)
  if (parts.length === 0) return null
  const show = component === 'presets' ? presetLine : (rel: string): string => rel
  const FILE_CAP = 20
  const lines = [
    ...added.map((rel) => `added: ${show(rel)}`),
    ...changed.map((rel) => `changed: ${show(rel)}`),
    ...removed.map((rel) => `removed: ${show(rel)}`)
  ]
  const changes = lines.slice(0, FILE_CAP)
  if (lines.length > FILE_CAP) changes.push(`+${lines.length - FILE_CAP} more`)
  return { summary: parts.join(', '), changes }
}

/** bookmarks: entry-level diff of the [Bookmarks] section */
function describeLineDrift(
  before: string[] | undefined,
  after: string[] | undefined
): DriftDescription | null {
  if (!before || !after) return null
  const beforeSet = new Set(before)
  const afterSet = new Set(after)
  const added = after.filter((line) => !beforeSet.has(line))
  const removed = before.filter((line) => !afterSet.has(line))
  if (added.length === 0 && removed.length === 0) return null
  const parts: string[] = []
  if (added.length > 0) parts.push(`${added.length} added`)
  if (removed.length > 0) parts.push(`${removed.length} removed`)
  const LINE_CAP = 20
  const lines = [
    ...added.map((line) => `added: ${line}`),
    ...removed.map((line) => `removed: ${line}`)
  ]
  const changes = lines.slice(0, LINE_CAP)
  if (lines.length > LINE_CAP) changes.push(`+${lines.length - LINE_CAP} more`)
  return { summary: parts.join(', '), changes }
}


/** drift statuses for every linked cell, comparing fingerprints against the baselines */
async function computeStatuses(resolved: ResolvedColumn[]): Promise<{
  statuses: SyncCellStatus[]
  links: SyncScanResult['links']
}> {
  const state = await readSyncState()
  const statuses: SyncCellStatus[] = []
  const sourceMinor = state.links.sourceMinor
  const source = sourceMinor ? resolved.find((entry) => entry.column.minor === sourceMinor) : undefined
  if (!source || !sourceMinor) return { statuses, links: state.links }
  // each source keeps its own sync history — statuses always read the active source's set
  const activeBaselines = state.baselines[sourceMinor] ?? {}

  const linkedComponents = new Set(Object.values(state.links.cells).flat())
  const sourceFp = new Map<SyncComponentId, ComponentFingerprint>()
  for (const component of SYNC_COMPONENT_IDS) {
    if (linkedComponents.has(component)) sourceFp.set(component, await fingerprintComponent(source.base, component))
  }

  // baselines written before the semantic-prefs upgrade carry byte hashes and no
  // profiles; whenever a side verifiably matches, silently refresh it in place
  const upgrades: Record<string, BaselineEntry> = {}

  for (const [minor, components] of Object.entries(state.links.cells)) {
    if (minor === state.links.sourceMinor) continue
    const target = resolved.find((entry) => entry.column.minor === minor)
    if (!target?.column.installed) continue
    for (const component of components) {
      // parked components: stored links stay dormant, but never surface or act
      if (HIDDEN_SYNC_COMPONENT_IDS.includes(component)) continue
      const src = sourceFp.get(component)
      if (!src || src.hash === null) continue // gone from the source — cell not actionable
      const baseline = activeBaselines[baselineKey(minor, component)]
      if (!baseline) {
        statuses.push({ minor, component, condition: 'new', detail: null, changes: null })
        continue
      }
      const tgt = await fingerprintComponent(target.base, component)
      const sourceChanged = !fingerprintMatches(baseline.source, src)
      const targetChanged = tgt.hash === null || !fingerprintMatches(baseline.target, tgt)

      let upgraded: BaselineEntry | null = null
      if (
        !sourceChanged &&
        (baseline.source !== src.hash ||
          (src.prefs && !baseline.sourcePrefs) ||
          (src.lines && !baseline.sourceLines))
      ) {
        upgraded = {
          ...baseline,
          source: src.hash,
          sourceFiles: src.files,
          ...(src.prefs ? { sourcePrefs: src.prefs } : {}),
          ...(src.lines ? { sourceLines: src.lines } : {})
        }
      }
      if (
        !targetChanged &&
        tgt.hash !== null &&
        (baseline.target !== tgt.hash ||
          (tgt.prefs && !baseline.targetPrefs) ||
          (tgt.lines && !baseline.targetLines))
      ) {
        upgraded = {
          ...(upgraded ?? baseline),
          target: tgt.hash,
          targetFiles: tgt.files,
          ...(tgt.prefs ? { targetPrefs: tgt.prefs } : {}),
          ...(tgt.lines ? { targetLines: tgt.lines } : {})
        }
      }
      if (upgraded) upgrades[baselineKey(minor, component)] = upgraded

      let condition: SyncCellStatus['condition']
      if (sourceChanged && targetChanged) {
        condition = 'conflict'
      } else if (sourceChanged) {
        condition = 'sourceChanged'
      } else if (targetChanged) {
        condition = 'targetChanged'
      } else {
        condition = 'inSync'
      }
      let detail: string | null = null
      let changes: string[] | null = null
      if (condition === 'targetChanged' || condition === 'conflict') {
        const drift =
          describePrefsDrift(baseline.targetPrefs, tgt.prefs) ??
          describeLineDrift(baseline.targetLines, tgt.lines) ??
          describeDrift(component, baseline.targetFiles, tgt.files)
        detail = drift?.summary ?? null
        changes = drift?.changes ?? null
      } else if (condition === 'sourceChanged') {
        const drift =
          describePrefsDrift(baseline.sourcePrefs, src.prefs) ??
          describeLineDrift(baseline.sourceLines, src.lines) ??
          describeDrift(component, baseline.sourceFiles, src.files)
        detail = drift?.summary ?? null
        changes = drift?.changes ?? null
      }
      statuses.push({ minor, component, condition, detail, changes })
    }
  }

  if (Object.keys(upgrades).length > 0) {
    await updateSyncState((current) => ({
      ...current,
      baselines: {
        ...current.baselines,
        [sourceMinor]: { ...(current.baselines[sourceMinor] ?? {}), ...upgrades }
      }
    }))
  }
  return { statuses, links: state.links }
}

export async function scanSettings(): Promise<SyncScanResult> {
  const resolved = await resolveColumns()
  const { statuses, links } = await computeStatuses(resolved)
  return { columns: resolved.map((entry) => entry.column), links, statuses }
}
