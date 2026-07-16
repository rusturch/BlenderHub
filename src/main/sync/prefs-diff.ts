import type { PrefsProfile } from '../addons/userpref-parser'
import { PREFS_VALUE_LABELS } from './prefs-value-labels'

// Presentation of a preferences diff: DNA field names → the labels users see in
// the Preferences window. Only names are mapped — values stay raw (enum/bitfield
// numbers), because value labels would need per-version RNA tables.

// top-level UserDef DNA fields → the Preferences sections users know them as
const PREFS_SECTION_LABELS: Record<string, string> = {
  themes: 'Themes',
  uifonts: 'Interface fonts',
  uistyles: 'Text styles',
  user_keymaps: 'Keymap',
  user_keyconfig_prefs: 'Keymap preferences',
  autoexec_paths: 'Auto-run safe paths',
  script_directories: 'Script directories',
  user_menus: 'Quick Favorites',
  asset_libraries: 'Asset libraries',
  extension_repos: 'Extension repositories',
  asset_shelves_settings: 'Asset shelves'
}

// fields whose DNA names do not spell their UI label; checked against
// rna_userdef.cc / the Preferences UI. The generic prettifier covers the rest.
const PREFS_FIELD_LABELS: Record<string, string> = {
  // options bitfields — one number holds several checkboxes of that area
  flag: 'General options',
  uiflag: 'Interface options',
  uiflag2: 'Interface options (2)',
  gpu_flag: 'GPU options',
  app_flag: 'App template options',
  statusbar_flag: 'Status Bar',
  gizmo_flag: 'Gizmos',
  tablet_flag: 'Tablet options',
  ndof_flag: 'NDOF options',
  keying_flag: 'Keying options',
  animation_flag: 'Animation options',
  text_flag: 'Text editor options',
  sequencer_editor_flag: 'Sequencer options',
  asset_flag: 'Assets options',
  extension_flag: 'Extensions options',
  pref_flag: 'Save Preferences options',
  dupflag: 'Duplicate Data',
  transopts: 'Translation options',
  gp_settings: 'Grease Pencil options',
  // Interface / Viewport
  ui_scale: 'Resolution Scale',
  ui_line_width: 'Line Width',
  color_picker_type: 'Color Picker Type',
  menuthreshold1: 'Menu Open Delay (Top Level)',
  menuthreshold2: 'Menu Open Delay (Sub Level)',
  text_render: 'Text Rendering',
  v2d_min_gridsize: '2D Minimum Grid Size',
  mini_axis_type: '3D Viewport Axes',
  rvisize: '3D Viewport Axes Size',
  rvibright: '3D Viewport Axes Brightness',
  gizmo_size_navigate_v3d: 'Navigate Gizmo Size',
  lookdev_sphere_size: 'HDRI Preview Size',
  light_param: 'Studio Lights',
  light_ambient: 'Ambient Color',
  smooth_viewtx: 'Smooth View',
  render_display_type: 'Render In',
  filebrowser_display_type: 'File Browser Display',
  // Input / Navigation
  dbl_click_time: 'Double Click Speed',
  mouse_emulate_3_button_modifier: 'Emulate 3 Button Modifier',
  move_threshold: 'Motion Threshold',
  pressure_threshold_max: 'Tablet Max Threshold',
  pressure_softness: 'Tablet Softness',
  viewzoom: 'Zoom Method',
  navigation_mode: 'View Navigation',
  pad_rot_angle: 'Orbit Rotation Angle',
  // Editing / Animation
  ipo_new: 'Default Interpolation',
  keyhandles_new: 'Default Keyframe Handles',
  auto_smoothing_new: 'Default Smoothing Mode',
  autokey_mode: 'Auto Keying Mode',
  key_insert_channels: 'Default Key Channels',
  fcu_inactive_alpha: 'F-Curve Visibility',
  node_margin: 'Auto-offset Margin',
  node_preview_res: 'Node Preview Resolution',
  gp_manhattandist: 'Grease Pencil Manhattan Distance',
  gp_euclideandist: 'Grease Pencil Euclidean Distance',
  gp_eraser: 'Grease Pencil Eraser Radius',
  gpencil_new_layer_col: 'Grease Pencil New Layer Color',
  sculpt_paint_overlay_col: 'Sculpt Overlay Color',
  coba_weight: 'Weight Paint Range',
  // Save & Load
  savetime: 'Auto Save Timer',
  versions: 'Save Versions',
  recent_files: 'Recent Files',
  // System
  memcachelimit: 'Memory Cache Limit',
  undosteps: 'Undo Steps',
  undomemory: 'Undo Memory Limit',
  scrollback: 'Console Scrollback Lines',
  glreslimit: 'GL Texture Limit',
  glalphaclip: 'Alpha Clip',
  anisotropic_filter: 'Anisotropic Filtering',
  viewport_aa: 'Viewport Anti-Aliasing',
  playback_fps_samples: 'FPS Samples',
  vbotimeout: 'VBO Time Out',
  vbocollectrate: 'VBO Collection Rate',
  textimeout: 'Texture Time Out',
  texcollectrate: 'Texture Collection Rate',
  image_draw_method: 'Image Display Method',
  sequencer_proxy_setup: 'Proxy Setup',
  compute_device_type: 'Cycles Render Device',
  audiodevice: 'Audio Device',
  audiorate: 'Audio Sample Rate',
  audioformat: 'Audio Sample Format',
  audiochannels: 'Audio Channels',
  mixbufsize: 'Audio Mixing Buffer',
  // File Paths
  tempdir: 'Temporary Files',
  fontdir: 'Fonts',
  renderdir: 'Render Output',
  render_cachedir: 'Render Cache',
  textudir: 'Textures',
  texture_cachedir: 'Texture Cache',
  sounddir: 'Sounds',
  i18ndir: 'Translation Files',
  image_editor: 'Image Editor',
  text_editor: 'Text Editor',
  text_editor_args: 'Text Editor Args',
  anim_player: 'Animation Player',
  anim_player_preset: 'Animation Player Preset',
  font_path_ui: 'Interface Font',
  font_path_ui_mono: 'Monospace Font',
  // misc
  keyconfigstr: 'Key Config',
  app_template: 'Application Template'
}

// tokens the word-by-word prettifier must not simply capitalize
const FIELD_TOKENS: Record<string, string> = {
  ui: 'UI',
  gpu: 'GPU',
  gl: 'GL',
  ndof: 'NDOF',
  api: 'API',
  fps: 'FPS',
  aa: 'Anti-Aliasing',
  xr: 'XR',
  hdri: 'HDRI',
  vbo: 'VBO',
  v3d: '3D View',
  v2d: '2D View',
  fcu: 'F-Curve',
  gp: 'Grease Pencil'
}

/** "walk_navigation.mouse_speed" → "Walk Navigation › Mouse Speed" */
function prettyPrefsField(path: string): string {
  return path
    .split('.')
    .map((segment) => {
      if (/^\d+$/.test(segment)) return `#${Number(segment) + 1}` // array index
      const alias = PREFS_FIELD_LABELS[segment]
      if (alias) return alias
      return segment
        .split('_')
        .filter(Boolean)
        .map((word) => FIELD_TOKENS[word] ?? word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ')
    })
    .join(' › ')
}

const versionLabel = (code: number): string => `${Math.floor(code / 100)}.${code % 100}`

const show = (value: string | number | undefined): string => {
  if (value === undefined || value === '') return '—'
  const text = String(value)
  return text.length > 40 ? `${text.slice(0, 40)}…` : text
}

/** one changed value as human lines: enum labels / one line per toggled checkbox / raw fallback */
function renderValueChange(
  key: string,
  before: string | number | undefined,
  after: string | number | undefined
): string[] {
  const name = prettyPrefsField(key)
  const table = PREFS_VALUE_LABELS[key]
  if (table && typeof before === 'number' && typeof after === 'number') {
    if (table.kind === 'enum') {
      return [`${name}: ${table.items[before] ?? before} → ${table.items[after] ?? after}`]
    }
    // a single-bit table is a plain toggle — the field name already says what it is
    const bitKeys = Object.keys(table.bits)
    if (table.kind === 'flags' && bitKeys.length === 1 && bitKeys[0] === '1') {
      const negated = table.negatedBits?.includes(1) ?? false
      return [`${name}: ${((after & 1) !== 0) !== negated ? 'enabled' : 'disabled'}`]
    }
    // flags: name each toggled checkbox on its own line, not two magic numbers
    const changed = (before ^ after) >>> 0
    const lines: string[] = []
    for (let index = 0; index <= 31; index++) {
      const bit = 2 ** index // 2**31 stays positive for the table lookup
      if (!(changed & bit)) continue
      const label = table.bits[bit] ?? `bit ${bit}`
      const turnedOn = (after & bit) !== 0
      const negated = table.negatedBits?.includes(bit) ?? false
      lines.push(`${name}: ${turnedOn !== negated ? '+' : '−'} ${label}`)
    }
    if (lines.length > 0) return lines
  }
  return [`${name}: ${show(before)} → ${show(after)}`]
}

/** a drift explained: one-line summary + individual changes for the expandable list */
export interface DriftDescription {
  summary: string
  changes: string[]
}

/** human description of a preferences diff: changed sections + exact value changes */
export function describePrefsDrift(
  before: PrefsProfile | undefined,
  after: PrefsProfile | undefined
): DriftDescription | null {
  if (!before || !after) return null
  const sectionKeys = new Set([...Object.keys(before.sections), ...Object.keys(after.sections)])
  const sections = [...sectionKeys]
    .filter((key) => before.sections[key] !== after.sections[key])
    .map((key) => PREFS_SECTION_LABELS[key] ?? prettyPrefsField(key))
  const valueKeys = new Set([...Object.keys(before.values), ...Object.keys(after.values)])
  const values = [...valueKeys].filter((key) => before.values[key] !== after.values[key])

  const lines: string[] = sections.map((label) => `${label}: changed`)
  for (const key of values) {
    lines.push(...renderValueChange(key, before.values[key], after.values[key]))
  }
  if (lines.length === 0 && before.version === after.version) return null

  const LINE_CAP = 30
  const changes = lines.slice(0, LINE_CAP)
  if (lines.length > LINE_CAP) changes.push(`+${lines.length - LINE_CAP} more`)
  if (before.version !== after.version) {
    changes.push(`re-saved by Blender ${versionLabel(after.version)}`)
  }
  const summary =
    lines.length > 0
      ? `${lines.length} change${lines.length === 1 ? '' : 's'}`
      : `re-saved by Blender ${versionLabel(after.version)}`
  return { summary, changes }
}
