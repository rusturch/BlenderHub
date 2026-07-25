/**
 * Color themes. A theme is a JSON file { "name": "...", "colors": { "<key>": "<css color>" } }:
 * built-in presets ship with the app (renderer/src/themes/*.json), user themes live in
 * <dataRoot>/themes/*.json. Applying a theme overrides the CSS variables below on the
 * document element at runtime — Tailwind v4 utilities all resolve through var(), so the
 * whole interface recolors without a rebuild and without touching components.
 */

/** theme color key → the CSS variable it overrides */
export const THEME_COLOR_VARS = {
  accent: '--color-blender',
  /** solid primary-button fill — split from accent so buttons recolor without touching tabs/text/borders */
  'accent-button': '--color-accent-button',
  /** solid primary-button fill on hover */
  'accent-button-hover': '--color-accent-button-hover',
  /** the bar behind the selected item — carries its own alpha (#rrggbbaa), so a
      theme sets both the tint's color and how strong it reads */
  selection: '--color-selection',
  /** label of the selected item (defaults to the highlight color) */
  'selection-text': '--color-selection-text',
  /** neutral icons (sidebar nav, icon-only buttons), one key per state — they
      no longer follow the text color of whatever holds them */
  icon: '--color-icon',
  'icon-hover': '--color-icon-hover',
  'icon-selected': '--color-icon-selected',
  /** outline around a project card on hover (drawn as a /40 tint of this color) */
  'card-outline': '--color-card-outline',
  /** project card background on hover */
  'card-hover': '--color-card-hover',
  background: '--color-background',
  foreground: '--color-foreground',
  /** text on solid accent/danger buttons */
  'on-accent': '--color-on-accent',
  /** tint behind hovers and hairline borders (white/5, white/10, …) */
  overlay: '--color-white',
  /** dimming behind dialogs and thumbnail gradients (black/60, …) */
  shade: '--color-black',
  /** fade over the edges of a horizontally-scrolled table — carries its own alpha */
  'scroll-shadow': '--color-scroll-shadow',
  scrollbar: '--color-scrollbar',
  'surface-inset': '--color-surface-inset',
  'surface-drawer': '--color-surface-drawer',
  'surface-input': '--color-surface-input',
  'surface-card': '--color-surface-card',
  'surface-hover': '--color-surface-hover',
  'surface-panel': '--color-surface-panel',
  'surface-dialog': '--color-surface-dialog',
  'surface-menu': '--color-surface-menu',
  'gray-100': '--color-zinc-100',
  'gray-200': '--color-zinc-200',
  'gray-300': '--color-zinc-300',
  'gray-400': '--color-zinc-400',
  'gray-500': '--color-zinc-500',
  'gray-600': '--color-zinc-600',
  'gray-700': '--color-zinc-700',
  'gray-800': '--color-zinc-800',
  'danger-300': '--color-red-300',
  'danger-400': '--color-red-400',
  'danger-500': '--color-red-500',
  'warning-300': '--color-amber-300',
  'warning-400': '--color-amber-400',
  'warning-500': '--color-amber-500',
  'success-400': '--color-emerald-400',
  'success-500': '--color-emerald-500',
  'info-300': '--color-sky-300',
  'info-400': '--color-sky-400',
  'info-500': '--color-sky-500',
  'purple-400': '--color-purple-400',
  'purple-500': '--color-purple-500',
  'violet-500': '--color-violet-500'
} as const

export type ThemeColorKey = keyof typeof THEME_COLOR_VARS

/**
 * Keys whose stock value is defined in CSS as another token (see main.css) —
 * a theme that omits them has to follow its own palette, not the default one,
 * so they are left out when filling a partial theme with the stock values.
 */
export const DERIVED_THEME_COLOR_KEYS = [
  'accent-button',
  'selection',
  'selection-text',
  'scroll-shadow',
  'card-outline',
  'card-hover'
] as const satisfies readonly ThemeColorKey[]

export const THEME_COLOR_KEYS = Object.keys(THEME_COLOR_VARS) as ThemeColorKey[]

/** a theme may cover any subset of keys; missing ones keep the built-in dark values */
export type ThemeColors = Partial<Record<ThemeColorKey, string>>

/**
 * ui-state.json keys. The selected id ('builtin:dark' / 'user:<id>') drives the
 * Settings UI; the flattened color map is what actually gets applied — the renderer
 * reads it synchronously before first paint and main styles the window chrome
 * (background, title-bar buttons) from it without ever resolving theme files.
 */
export const THEME_SELECTED_UI_KEY = 'launcher.theme'
export const THEME_COLORS_UI_KEY = 'launcher.themeColors'
export const THEME_DIRTY_UI_KEY = 'launcher.themeDirty'

/** user theme id doubles as the file name under data/themes — keep it path-safe */
export const THEME_ID_RE = /^[a-z0-9][a-z0-9-]{0,40}$/

/** DOS device basenames resolve to devices on pre-11 Windows even with .json appended */
const WINDOWS_RESERVED_ID_RE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/

export function isThemeId(id: string): boolean {
  return THEME_ID_RE.test(id) && !WINDOWS_RESERVED_ID_RE.test(id)
}

export const THEME_NAME_MAX = 60

/**
 * Plain CSS color forms only — no var()/url()/nesting, the value goes straight
 * into style.setProperty and into window-chrome color parsing in main.
 */
const COLOR_VALUE_RE =
  /^(#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})|(?:rgb|rgba|hsl|hsla|oklch|oklab|color)\([-+0-9a-zA-Z.,%/\s]{1,48}\))$/

export function isThemeColorValue(value: unknown): value is string {
  return typeof value === 'string' && COLOR_VALUE_RE.test(value)
}

/** keep only known keys carrying plausible color values (input: file, IPC or ui-state JSON) */
export function sanitizeThemeColors(raw: unknown): ThemeColors {
  const result: ThemeColors = {}
  if (!raw || typeof raw !== 'object') return result
  for (const key of THEME_COLOR_KEYS) {
    const value = (raw as Record<string, unknown>)[key]
    if (isThemeColorValue(value)) result[key] = value
  }
  return result
}

/** derive a file-safe id from a display name ("My Theme!" → "my-theme") */
export function themeIdFromName(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40)
  return isThemeId(slug) ? slug : 'theme'
}
