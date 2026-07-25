import {
  DERIVED_THEME_COLOR_KEYS,
  sanitizeThemeColors,
  THEME_COLOR_KEYS,
  THEME_COLOR_VARS,
  THEME_COLORS_UI_KEY,
  THEME_DIRTY_UI_KEY,
  THEME_SELECTED_UI_KEY
} from '../../../shared/theme'
import type { ThemeColors } from '../../../shared/theme'
import { onUiChanged, uiGet, uiSet } from './ui-store'

const BUILTIN_PREFIX = 'builtin:'

// Runtime side of theming: presets bundled like locales (drop a JSON into
// renderer/src/themes and it appears in Settings), applied by overriding the
// CSS variables from shared/theme.ts on <html>. The active theme's flattened
// colors live in ui-state (THEME_COLORS_UI_KEY) so the look is restored
// synchronously before first paint and main can style the window chrome.

export interface ThemePreset {
  id: string
  name: string
  colors: ThemeColors
  /** "default": true in the file — the look a fresh install starts on */
  isDefault: boolean
}

// mod.default is the parsed JSON; its own "default" field is the flag marking
// the preset a fresh install starts on
const presetModules = import.meta.glob<{
  default: { name?: unknown; colors?: unknown; default?: unknown }
}>('../themes/*.json', { eager: true })

/** the two plain looks head the list (even when neither is the default one);
    everything else, the default preset included, sorts by name */
const PINNED_PRESET_IDS = ['dark', 'light']

const presetRank = (id: string): number => {
  const at = PINNED_PRESET_IDS.indexOf(id)
  return at === -1 ? PINNED_PRESET_IDS.length : at
}

// preset names are data that travels with the theme file (like Blender's own
// presets and user-typed theme names) — deliberately not localized
export const BUILTIN_THEMES: ThemePreset[] = Object.entries(presetModules)
  .flatMap(([path, mod]) => {
    const id = path.match(/([^/]+)\.json$/)?.[1]
    if (!id) return []
    const name = typeof mod.default.name === 'string' ? mod.default.name : id
    return [
      {
        id,
        name,
        colors: sanitizeThemeColors(mod.default.colors),
        isDefault: mod.default.default === true
      }
    ]
  })
  .sort((a, b) => presetRank(a.id) - presetRank(b.id) || a.name.localeCompare(b.name))

/**
 * The preset a fresh install starts on: whichever theme file carries
 * "default": true, so switching it is a one-line edit in the theme itself and
 * never touches code. With none (or several) flagged, the list order decides.
 */
export const DEFAULT_PRESET_ID =
  BUILTIN_THEMES.find((preset) => preset.isDefault)?.id ?? BUILTIN_THEMES[0]?.id ?? 'dark'

/** the stock look — also the value base for themes that omit some keys */
export const DEFAULT_THEME_COLORS: ThemeColors =
  BUILTIN_THEMES.find((preset) => preset.id === DEFAULT_PRESET_ID)?.colors ?? {}

/**
 * Complete a theme with the stock values. Derived keys are left out: their CSS
 * defaults are written in terms of the theme's own colors, so a theme saved
 * before such a key existed keeps following its own palette instead of
 * inheriting the default theme's.
 */
export function withThemeDefaults(colors: ThemeColors): ThemeColors {
  const merged: ThemeColors = { ...DEFAULT_THEME_COLORS }
  for (const key of DERIVED_THEME_COLOR_KEYS) {
    if (!colors[key]) delete merged[key]
  }
  return { ...merged, ...colors }
}

/** override the variables for the given keys, restore defaults for the missing ones */
export function applyThemeColors(colors: ThemeColors): void {
  const style = document.documentElement.style
  for (const key of THEME_COLOR_KEYS) {
    const value = colors[key]
    if (value) style.setProperty(THEME_COLOR_VARS[key], value)
    else style.removeProperty(THEME_COLOR_VARS[key])
  }
  // native control chrome (select popups, checkboxes, the color-input swatch)
  // follows color-scheme, not CSS backgrounds — derive it from the theme
  const hex = cssColorToHex(colors.background ?? DEFAULT_THEME_COLORS.background ?? '#0d0d0d')
  if (hex) {
    const [r, g, b] = [1, 3, 5].map((at) => parseInt(hex.slice(at, at + 2), 16))
    const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255
    style.colorScheme = luminance > 0.5 ? 'light' : 'dark'
  } else {
    style.colorScheme = 'dark'
  }
}

// Selection changes made through pickers in THIS window — ui-store's onUiChanged
// only reports foreign windows (own writes are filtered as echoes), so the
// Settings card and the title-bar picker subscribe here to stay in sync.
type ThemeSelectionListener = () => void
const selectionListeners = new Set<ThemeSelectionListener>()

export function onThemeSelectionChanged(listener: ThemeSelectionListener): () => void {
  selectionListeners.add(listener)
  return () => {
    selectionListeners.delete(listener)
  }
}

/** apply a theme and persist it as the active selection (drops any dirty edits) */
export function applyThemeSelection(selectionId: string, colors: ThemeColors): void {
  const next = withThemeDefaults(colors)
  applyThemeColors(next)
  uiSet(THEME_SELECTED_UI_KEY, selectionId)
  uiSet(THEME_DIRTY_UI_KEY, '0')
  uiSet(THEME_COLORS_UI_KEY, JSON.stringify(plainThemeColors(next)))
  for (const listener of selectionListeners) listener()
}

/** restore the persisted look; runs after initUiStore, before the first render */
export function initTheme(): void {
  applyPersistedTheme()
  // edits made in another window (the floating theme editor) land here live
  onUiChanged((key, value) => {
    if (key !== THEME_COLORS_UI_KEY) return
    try {
      applyThemeColors(sanitizeThemeColors(JSON.parse(value)))
    } catch {
      // half-written value — keep the current look
    }
  })
}

function applyPersistedTheme(): void {
  // A built-in preset with no unsaved edits always applies from its current
  // definition, so preset updates propagate without a manual re-select and the
  // stored snapshot never lags behind a newly added color key. User themes and
  // edited presets restore from the stored snapshot.
  // nothing chosen yet (first run) means the default preset, not the bare CSS
  // fallback — otherwise a fresh install shows neither preset's look
  const selected = uiGet(THEME_SELECTED_UI_KEY) ?? `${BUILTIN_PREFIX}${DEFAULT_PRESET_ID}`
  const dirty = uiGet(THEME_DIRTY_UI_KEY) === '1'
  if (selected.startsWith(BUILTIN_PREFIX) && !dirty) {
    const preset = BUILTIN_THEMES.find((p) => p.id === selected.slice(BUILTIN_PREFIX.length))
    if (preset) {
      const colors = withThemeDefaults(preset.colors)
      applyThemeColors(colors)
      // keep the stored snapshot (read by main for window chrome, and by the
      // editor) in sync with the freshly applied preset
      const flat = JSON.stringify(plainThemeColors(colors))
      if (flat !== uiGet(THEME_COLORS_UI_KEY)) uiSet(THEME_COLORS_UI_KEY, flat)
      return
    }
  }
  const stored = uiGet(THEME_COLORS_UI_KEY)
  if (!stored) return
  try {
    applyThemeColors(sanitizeThemeColors(JSON.parse(stored)))
  } catch {
    // stale/corrupt value — keep the default look
  }
}

/** flatten to a plain key/value map (only keys carrying a value), for persistence */
function plainThemeColors(colors: ThemeColors): Record<string, string> {
  const record: Record<string, string> = {}
  for (const key of THEME_COLOR_KEYS) {
    const value = colors[key]
    if (value) record[key] = value
  }
  return record
}

let colorProbe: CanvasRenderingContext2D | null | undefined

/**
 * Normalize any CSS color to #rrggbb (or #rrggbbaa when it carries alpha, as
 * the selection tint does). Rendered through a 1×1 canvas pixel — the fillStyle
 * getter no longer normalizes CSS Color 4 values (oklch et al come back
 * verbatim), but getImageData always yields sRGB bytes. An unparseable value
 * keeps the black the probe was primed with.
 */
export function cssColorToHex(value: string): string | null {
  const trimmed = value.trim()
  if (/^#[0-9a-fA-F]{6}$/.test(trimmed) || /^#[0-9a-fA-F]{8}$/.test(trimmed))
    return trimmed.toLowerCase()
  if (colorProbe === undefined) {
    const canvas = document.createElement('canvas')
    canvas.width = 1
    canvas.height = 1
    colorProbe = canvas.getContext('2d', { willReadFrequently: true })
  }
  if (!colorProbe) return null
  colorProbe.clearRect(0, 0, 1, 1)
  colorProbe.fillStyle = '#000000'
  colorProbe.fillStyle = trimmed
  colorProbe.fillRect(0, 0, 1, 1)
  const [r, g, b, a] = colorProbe.getImageData(0, 0, 1, 1).data
  const channel = (n: number): string => n.toString(16).padStart(2, '0')
  const rgb = `#${channel(r)}${channel(g)}${channel(b)}`
  return a >= 255 ? rgb : `${rgb}${channel(a)}`
}
