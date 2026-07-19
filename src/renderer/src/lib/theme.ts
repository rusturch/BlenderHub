import {
  sanitizeThemeColors,
  THEME_COLOR_KEYS,
  THEME_COLOR_VARS,
  THEME_COLORS_UI_KEY
} from '../../../shared/theme'
import type { ThemeColors } from '../../../shared/theme'
import { uiGet } from './ui-store'

// Runtime side of theming: presets bundled like locales (drop a JSON into
// renderer/src/themes and it appears in Settings), applied by overriding the
// CSS variables from shared/theme.ts on <html>. The active theme's flattened
// colors live in ui-state (THEME_COLORS_UI_KEY) so the look is restored
// synchronously before first paint and main can style the window chrome.

export interface ThemePreset {
  id: string
  name: string
  colors: ThemeColors
}

const presetModules = import.meta.glob<{ default: { name?: unknown; colors?: unknown } }>(
  '../themes/*.json',
  { eager: true }
)

export const DEFAULT_PRESET_ID = 'dark'

// preset names are data that travels with the theme file (like Blender's own
// presets and user-typed theme names) — deliberately not localized
export const BUILTIN_THEMES: ThemePreset[] = Object.entries(presetModules)
  .flatMap(([path, mod]) => {
    const id = path.match(/([^/]+)\.json$/)?.[1]
    if (!id) return []
    const name = typeof mod.default.name === 'string' ? mod.default.name : id
    return [{ id, name, colors: sanitizeThemeColors(mod.default.colors) }]
  })
  .sort((a, b) =>
    a.id === DEFAULT_PRESET_ID ? -1 : b.id === DEFAULT_PRESET_ID ? 1 : a.name.localeCompare(b.name)
  )

/** the stock look — also the value base for themes that omit some keys */
export const DEFAULT_THEME_COLORS: ThemeColors =
  BUILTIN_THEMES.find((preset) => preset.id === DEFAULT_PRESET_ID)?.colors ?? {}

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

/** restore the persisted look; runs after initUiStore, before the first render */
export function initTheme(): void {
  const stored = uiGet(THEME_COLORS_UI_KEY)
  if (!stored) return
  try {
    applyThemeColors(sanitizeThemeColors(JSON.parse(stored)))
  } catch {
    // stale/corrupt value — keep the default look
  }
}

let colorProbe: CanvasRenderingContext2D | null | undefined

/**
 * Normalize any CSS color to #rrggbb for <input type="color">. Rendered through
 * a 1×1 canvas pixel — the fillStyle getter no longer normalizes CSS Color 4
 * values (oklch et al come back verbatim), but getImageData always yields sRGB
 * bytes. Alpha is dropped; an unparseable value paints black.
 */
export function cssColorToHex(value: string): string | null {
  const trimmed = value.trim()
  if (/^#[0-9a-fA-F]{6}$/.test(trimmed)) return trimmed.toLowerCase()
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
  if (a === 0) return null
  const channel = (n: number): string => n.toString(16).padStart(2, '0')
  return `#${channel(r)}${channel(g)}${channel(b)}`
}
