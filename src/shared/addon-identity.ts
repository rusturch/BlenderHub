import { compareVersionsDesc } from './blender-builds'
import type { AddonInfo, AddonOrigin, VersionAddons } from './types'

// Cross-version add-on identity.
//
// The problem: the SAME logical add-on has different identities across Blender versions.
// Blender 4.2 moved most bundled add-ons to the extensions platform, and the package id
// was NOT reliably preserved — three outcomes exist (verified against extensions.blender.org
// and the blender-addons repo at the 4.1/4.2 tags):
//   1. kept as a core bundled module (module name unchanged, never an extension): node_wrangler…
//   2. migrated with id == old module name: magic_uv, sun_position…
//   3. migrated but RENAMED: mesh_looptools -> looptools, object_print3d_utils -> print3d_toolbox…
// So identity cannot be computed by string-transforming the module name. We bridge the eras
// with an explicit alias table and NEVER auto-merge on a guess.
//
// Safety invariant: the id produced here is for DISPLAY GROUPING ONLY. Writing enable/disable
// state (phase 2) must always use the exact per-version module string Blender itself reported —
// never a value derived from the canonical id. A wrong grouping is therefore cosmetic and
// reversible; it can never toggle the wrong module.

export type RepoKind = 'official' | 'local' | 'custom'

/**
 * How confidently two version-cells were joined into one row:
 * - 'exact'     — same extension pkg id across versions (trustworthy)
 * - 'alias'     — legacy module bridged to its migrated extension via the curated table
 * - 'core'      — a known kept-bundled core module, same across versions
 * - 'heuristic' — unknown same-name legacy modules merged because display name / author agree ("~ verify")
 * - 'suggested' — left separate; a merge is only offered, never applied automatically
 * - 'user'      — grouping forced by a user override
 */
export type MatchTier = 'exact' | 'alias' | 'core' | 'heuristic' | 'suggested' | 'user'

/**
 * Where the user got an add-on, for filtering:
 * - 'builtin'     — ships with Blender
 * - 'user'        — installed by the user (legacy zip/py, or a local user_default extension)
 * - 'blender_org' — an extension from extensions.blender.org
 * - 'superhive'   — a purchase identified against the connected Superhive catalog
 */
export type AddonSource = 'builtin' | 'user' | 'blender_org' | 'superhive'

export interface AddonGroupRow {
  /** unique, stable row key (canonical id, or canonicalId#minor for split-out rows) */
  groupId: string
  canonicalId: string
  /** display name, taken from the newest version's cell */
  name: string
  category: string
  /** what Blender itself shows for this add-on (bl_info 'description' / manifest 'tagline'),
   *  taken from the newest cell that has one; null when no scanned cell carries it */
  description: string | null
  /** the add-on's own page, from whichever scanned version declares one (http(s) only) */
  website: string | null
  origins: Set<AddonOrigin>
  /** the user installed this themselves somewhere (user or extension origin) */
  manual: boolean
  /**
   * every source bucket this row belongs to — tabs are filters, not exclusive buckets,
   * so an add-on bundled in old versions AND on blender.org in new ones is in both
   */
  sources: Set<AddonSource>
  matchTier: MatchTier
  /** minor version -> the exact AddonInfo Blender reported there (carries the real module string) */
  perMinor: Map<string, AddonInfo>
  enabledAnywhere: boolean
  members: { minor: string; module: string; repoKind: RepoKind | null }[]
}

// Curated legacy-module -> extension-pkgId map for the migrated (renamed) add-ons.
// Unmapped pairs stay separate rather than risk a false merge — the failure mode is graceful.
const LEGACY_TO_EXTENSION: Record<string, string> = {
  mesh_looptools: 'looptools',
  mesh_f2: 'f2',
  mesh_bsurfaces: 'bsurfaces_gpl_edition',
  object_fracture_cell: 'cell_fracture',
  object_print3d_utils: 'print3d_toolbox',
  object_carver: 'carver',
  object_collection_manager: 'collection_manager',
  space_view3d_copy_attributes: 'copy_attributes_menu',
  space_view3d_math_vis: 'math_vis_console',
  space_view3d_pie_menus: 'viewport_pie_menus',
  space_view3d_stored_views: 'stored_views',
  add_mesh_ant_landscape: 'antlandscape',
  ant_landscape: 'antlandscape',
  add_mesh_extra_objects: 'extra_mesh_objects',
  add_curve_extra_objects: 'extra_curve_objects',
  io_export_paper_model: 'export_paper_model',
  render_freestyle_svg: 'freestyle_svg_exporter',
  materials_utils: 'material_utilities',
  storypencil: 'storypencil_storyboard_tools',
  // the legacy folder is 'mesh_tissue' — the extension id 'tissue' only LOOKS like an
  // exact match; verified live against extensions.blender.org (id 'tissue')
  mesh_tissue: 'tissue',
  add_mesh_BoltFactory: 'boltfactory',
  // Bulk-verified 2026-07: cross-referenced every bundled add-on shipped in 4.1
  // scripts/addons against the live extensions.blender.org catalog by display name.
  // For each of these the migrated extension id is the slug of the add-on's bl_info
  // name while the old folder name was historical — so string-transforming the module
  // would never find them. (A few ids differ from a naive slug: Simplify Curves+ ->
  // simplify_curves_plus, 3D Navigation -> navigation, Export Pointcache (.pc2) ->
  // export_pointcache_formatpc2.) Display-grouping only; writes still use the exact module.
  add_curve_ivygen: 'ivygen',
  add_curve_sapling: 'sapling_tree_gen',
  add_mesh_discombobulator: 'discombobulator',
  add_mesh_geodesic_domes: 'geodesic_domes',
  animation_add_corrective_shape_key: 'corrective_shape_keys',
  animation_animall: 'animall',
  blender_id: 'blender_id_authentication',
  btrace: 'btracer',
  camera_turnaround: 'turnaround_camera',
  curve_assign_shapekey: 'assign_shape_keys',
  curve_simplify: 'simplify_curves_plus',
  development_edit_operator: 'edit_operator_source',
  development_icon_get: 'icon_viewer',
  development_iskeyfree: 'is_key_free',
  greasepencil_tools: 'grease_pencil_tools',
  io_anim_camera: 'export_camera_animation',
  io_anim_nuke_chan: 'nuke_animation_format_chan',
  io_export_dxf: 'export_autocad_dxf_format_dxf',
  io_export_pc2: 'export_pointcache_formatpc2',
  io_import_dxf: 'import_autocad_dxf_format_dxf',
  io_import_palette: 'import_palettes',
  io_mesh_atomic: 'atomic_blender_pdb_xyz',
  io_mesh_stl: 'stl_format_legacy',
  io_scene_x3d: 'web3d_x3d_vrml2_format',
  io_shape_mdd: 'newtek_mdd_format',
  lighting_dynamic_sky: 'dynamic_sky',
  lighting_tri_lights: 'tri_lighting',
  materials_library_vx: 'material_library',
  mesh_auto_mirror: 'auto_mirror',
  mesh_inset: 'inset_straight_skeleton',
  mesh_tiny_cad: 'tinycad_mesh_tools',
  mesh_tools: 'edit_mesh_tools',
  object_boolean_tools: 'bool_tool',
  object_edit_linked: 'edit_linked_library',
  object_scatter: 'scatter_objects',
  object_skinify: 'skinify_rig',
  paint_palette: 'paint_palettes',
  precision_drawing_tools: 'precision_drawing_tools_pdt',
  render_copy_settings: 'copy_render_settings',
  render_ui_animation_render: 'ui_animation_render',
  space_clip_editor_refine_solution: 'refine_tracking_solution',
  space_view3d_3d_navigation: 'navigation',
  space_view3d_align_tools: 'align_tools',
  space_view3d_brush_menus: 'dynamic_brush_menus',
  space_view3d_modifier_tools: 'modifier_tools',
  space_view3d_spacebar_menu: 'dynamic_context_menu',
  system_blend_info: 'scene_information',
  system_demo_mode: 'demo_mode',
  system_property_chart: 'property_chart',
  // migrated but BOTH id and display name changed, so a name-only sweep misses them —
  // found by keyword search of the live catalog (io_scene_3ds -> "Autodesk 3D Studio (.3ds)",
  // mesh_snap_utilities_line -> "Snap Line Tool")
  io_scene_3ds: 'autodesk_3ds_format',
  mesh_snap_utilities_line: 'snap_utilities_line'
}

// Migrated add-ons whose extension id equals the old legacy module name (self-bridge).
const EXACT_MIGRATIONS: ReadonlySet<string> = new Set([
  'magic_uv',
  'sun_position',
  'archimesh',
  'curve_tools',
  'power_sequencer',
  'node_presets',
  'amaranth',
  'real_snow',
  'measureit',
  'vdm_brush_baker',
  // Bulk-verified 2026-07 (same pass as LEGACY_TO_EXTENSION): bundled in 4.1, migrated to
  // extensions.blender.org keeping the exact module name as the extension id.
  'add_camera_rigs',
  'node_arrange',
  'object_color_rules'
])

// Add-ons kept bundled as core in 4.2+ (scripts/addons_core). They are NEVER extensions on a
// stock install, so a stray custom extension sharing the id must not merge into them.
const CORE_KEPT_MODULES: ReadonlySet<string> = new Set([
  'node_wrangler',
  'rigify',
  'io_scene_gltf2',
  'io_scene_fbx',
  'io_anim_bvh',
  'io_curve_svg',
  'io_mesh_uv_layout',
  'hydra_storm',
  'pose_library',
  'ui_translate',
  'viewport_vr_preview',
  // graduated further, from a bundled add-on to an always-on core startup operator (5.x):
  // still "core kept", never an extension — protect their identity the same way.
  'copy_global_transform',
  'bone_selection_sets',
  'io_import_images_as_planes',
  // rewritten as compiled-in C++ operators (wm.ply_import/export, wm.obj_import/export) already
  // between 3.6 and 4.0 — no blender.org replacement exists, but nothing is lost functionally
  'io_mesh_ply',
  'io_scene_obj'
])

// Former bundled add-ons that Blender DROPPED in 4.2+ with no extensions.blender.org
// replacement and no core equivalent (verified by keyword search of the live catalog).
// The launcher can still carry a user's old copy forward via the Library (legacy install
// works in 5.x), but it is unsupported — `note` says why it may not work.
export const REMOVED_BUNDLED: Record<string, { name: string; note: string }> = {
  render_povray: {
    name: 'POV-Ray render engine',
    note: 'Removed in Blender 4.0 and moved to an external community repo. Needs the POV-Ray binary and is unmaintained — carrying it forward likely will not work.'
  },
  io_coat3D: {
    name: '3D-Coat Applink',
    note: 'Removed from the bundle in 4.2; not on extensions.blender.org. Needs the 3D-Coat application installed to be useful.'
  },
  io_import_BrushSet: {
    name: 'Import BrushSet',
    note: 'Removed from the bundle in 4.2; not on extensions.blender.org. Pure-Python — may still work as a legacy add-on.'
  },
  depsgraph_debug: {
    name: 'Dependency Graph Debug',
    note: 'A developer/debug add-on removed from release builds; not on extensions.blender.org. Pure-Python — may still work.'
  }
}

/** the removed-add-on info for a row's canonical id (mod:<module>), or null */
export function removedBundledInfo(canonicalId: string): { name: string; note: string } | null {
  if (!canonicalId.startsWith('mod:')) return null
  return REMOVED_BUNDLED[canonicalId.slice('mod:'.length)] ?? null
}

/** legacy module -> extension pkgId, folding in the exact self-bridges */
function aliasTarget(module: string): string | null {
  if (module in LEGACY_TO_EXTENSION) return LEGACY_TO_EXTENSION[module]
  if (EXACT_MIGRATIONS.has(module)) return module
  return null
}

export function classifyRepo(repoModule: string | null | undefined): RepoKind | null {
  if (!repoModule) return null
  if (repoModule === 'blender_org') return 'official'
  if (repoModule === 'user_default') return 'local'
  return 'custom'
}

interface Canonical {
  canonicalId: string
  repoKind: RepoKind | null
  /** true when a legacy module was bridged to an extension id via the alias table */
  viaAlias: boolean
}

export function computeCanonicalId(addon: AddonInfo): Canonical {
  const isExtension = addon.origin === 'extension' || addon.module.startsWith('bl_ext.')
  if (isExtension) {
    const pkgId = addon.pkgId ?? addon.module.split('.')[2] ?? addon.module
    const repoKind = classifyRepo(addon.repoModule)
    // quarantine custom/Superhive repos: a same-id add-on from a foreign repo may be a different
    // fork, so it gets its own canonical id and is only ever OFFERED as a merge, never auto-joined.
    const canonicalId = repoKind === 'custom' ? `ext:${pkgId}@${addon.repoModule}` : `ext:${pkgId}`
    return { canonicalId, repoKind, viaAlias: false }
  }
  // legacy add-on: bridge to its migrated extension id when known, else keep its plain module
  const target = CORE_KEPT_MODULES.has(addon.module) ? null : aliasTarget(addon.module)
  if (target) return { canonicalId: `ext:${target}`, repoKind: null, viaAlias: true }
  return { canonicalId: `mod:${addon.module}`, repoKind: null, viaAlias: false }
}

interface Cell {
  minor: string
  addon: AddonInfo
  canonicalId: string
  repoKind: RepoKind | null
  viaAlias: boolean
  nameKey: string
  authorKey: string
}

const collapse = (value: string): string => value.trim().replace(/\s+/g, ' ').toLowerCase()

function makeRow(groupId: string, tier: MatchTier, cells: Cell[]): AddonGroupRow {
  const perMinor = new Map<string, AddonInfo>()
  const origins = new Set<AddonOrigin>()
  const members: AddonGroupRow['members'] = []
  let enabledAnywhere = false
  for (const cell of cells) {
    perMinor.set(cell.minor, cell.addon)
    origins.add(cell.addon.origin)
    if (cell.addon.enabled) enabledAnywhere = true
    members.push({ minor: cell.minor, module: cell.addon.module, repoKind: cell.repoKind })
  }
  // name/category/description from the newest version present (avoids stale or localized older labels);
  // description falls back to the newest cell that actually has one, since not every era of Blender
  // reported it the same way (a headless-scanned extension cell may have it while an older direct-scanned one doesn't)
  const sortedByVersion = [...cells].sort((a, b) => compareVersionsDesc(a.minor, b.minor))
  const newest = sortedByVersion[0]
  const category = cells.map((c) => c.addon.category).find((value) => value) ?? ''
  const description = sortedByVersion.map((c) => c.addon.description ?? null).find((value) => value) ?? null
  const website = sortedByVersion.map((c) => c.addon.website ?? null).find((value) => value) ?? null
  return {
    groupId,
    canonicalId: cells[0].canonicalId,
    name: newest.addon.name || newest.addon.module,
    category,
    description,
    website,
    origins,
    manual: origins.has('user') || origins.has('extension'),
    sources: new Set(), // assigned in groupAddons once the Superhive catalog is known
    matchTier: tier,
    perMinor,
    enabledAnywhere,
    members
  }
}

/** classify a finished row into a source bucket for the filter tabs */
function rowSource(row: AddonGroupRow, superhivePkgIds?: ReadonlySet<string>): Set<AddonSource> {
  const pkgId = row.canonicalId.startsWith('ext:') ? row.canonicalId.slice('ext:'.length).split('@')[0] : null
  const cells = [...row.perMinor.values()]
  const sources = new Set<AddonSource>()
  if (pkgId && superhivePkgIds?.has(pkgId)) sources.add('superhive')
  // installed as a blender.org extension anywhere…
  if (cells.some((addon) => addon.origin === 'extension' && addon.repoModule === 'blender_org')) {
    sources.add('blender_org')
  }
  // …or known-migrated to extensions.blender.org via the curated alias table (BoltFactory etc.),
  // even before that release is installed anywhere — still actionable from that tab
  if (pkgId && row.matchTier === 'alias') sources.add('blender_org')
  // ships with Blender in any of the user's versions — as a bundled add-on or as always-on core
  if (cells.some((addon) => addon.origin === 'bundled' || addon.origin === 'core')) sources.add('builtin')
  // self-installed: legacy user add-ons, or local/other-repo extensions that are not purchases
  if (cells.some((addon) => addon.origin === 'user')) sources.add('user')
  if (
    !sources.has('superhive') &&
    cells.some((addon) => addon.origin === 'extension' && addon.repoModule !== 'blender_org')
  ) {
    sources.add('user')
  }
  if (sources.size === 0) sources.add('builtin') // scanned rows always have ≥1 origin
  return sources
}

/**
 * Group per-version add-ons into cross-version rows. Auto-merges only on trustworthy evidence
 * (same extension id, curated alias, or core module); unknown same-name legacy modules merge
 * only when their display name or author agrees (tier 'heuristic'), otherwise they are split
 * into separate rows so the user can decide. Never merges quarantined custom-repo extensions.
 */
export function groupAddons(
  data: VersionAddons[],
  options: { superhivePkgIds?: ReadonlySet<string> } = {}
): AddonGroupRow[] {
  // PASS A — a record per (version, add-on)
  const records: Cell[] = []
  for (const version of data) {
    for (const addon of version.addons) {
      const { canonicalId, repoKind, viaAlias } = computeCanonicalId(addon)
      records.push({
        minor: version.minor,
        addon,
        canonicalId,
        repoKind,
        viaAlias,
        nameKey: collapse(addon.name || addon.module),
        authorKey: collapse(addon.author ?? '')
      })
    }
  }

  // PASS B — bucket by canonical id
  const buckets = new Map<string, Cell[]>()
  for (const record of records) {
    const bucket = buckets.get(record.canonicalId)
    if (bucket) bucket.push(record)
    else buckets.set(record.canonicalId, [record])
  }

  const rows: AddonGroupRow[] = []
  for (const [canonicalId, recs] of buckets) {
    // one representative per minor; a repeated minor (should be impossible for one install)
    // is split off rather than silently overwritten — catches over-broad aliasing
    const byMinor = new Map<string, Cell>()
    const duplicates: Cell[] = []
    for (const record of recs) {
      if (byMinor.has(record.minor)) duplicates.push(record)
      else byMinor.set(record.minor, record)
    }
    const cells = [...byMinor.values()]
    const isLegacyMod = canonicalId.startsWith('mod:')
    const multiMinor = cells.length > 1

    if (isLegacyMod && multiMinor) {
      const module = canonicalId.slice('mod:'.length)
      if (CORE_KEPT_MODULES.has(module)) {
        rows.push(makeRow(canonicalId, 'core', cells))
      } else {
        // unknown same-name legacy across versions — could be two unrelated add-ons.
        // merge only if display name OR author agrees; otherwise keep separate (suggested).
        const names = new Set(cells.map((c) => c.nameKey))
        const authors = new Set(cells.map((c) => c.authorKey))
        const agree = names.size === 1 || (authors.size === 1 && !authors.has(''))
        if (agree) {
          rows.push(makeRow(canonicalId, 'heuristic', cells))
        } else {
          for (const cell of cells) rows.push(makeRow(`${canonicalId}#${cell.minor}`, 'suggested', [cell]))
        }
      }
    } else {
      const tier: MatchTier = canonicalId.startsWith('ext:')
        ? cells.some((c) => c.viaAlias)
          ? 'alias'
          : 'exact'
        : 'exact'
      rows.push(makeRow(canonicalId, tier, cells))
    }

    for (const duplicate of duplicates) {
      // module makes the key unique when several same-id records share one minor
      rows.push(makeRow(`${canonicalId}#dup#${duplicate.minor}#${duplicate.addon.module}`, 'suggested', [duplicate]))
    }
  }

  for (const row of rows) row.sources = rowSource(row, options.superhivePkgIds)

  return rows.sort(
    (a, b) => Number(b.enabledAnywhere) - Number(a.enabledAnywhere) || a.name.localeCompare(b.name)
  )
}
