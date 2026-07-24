import { BrowserWindow } from 'electron'
import { onUiStateSet, readUiState } from '../ui-state'
import { sanitizeThemeColors, THEME_COLORS_UI_KEY } from '../../shared/theme'

// Native window chrome (pre-paint background, Windows title-bar button overlay)
// follows the active theme. Main never resolves theme files — the renderer flattens
// whatever theme is active into the launcher.themeColors ui-state value, which is
// also what the page itself applies before first paint.

export interface WindowChromeColors {
  background: string
  titlebar: string
  symbol: string
}

const DEFAULT_CHROME: WindowChromeColors = {
  background: '#0d0d0d', // --color-background
  titlebar: '#181818', // --color-surface-panel
  symbol: '#e5e7eb' // --color-foreground
}

// Electron chrome colors want plain opaque hex; themes may hold oklch()/rgb()
// strings — those fall back to the dark defaults rather than feeding Electron
// garbage. Short and alpha hex forms are normalizable, so accept them.
const HEX_RE = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/

function normalizeHex(color: string | undefined): string | null {
  if (!color || !HEX_RE.test(color)) return null
  let hex = color.slice(1)
  if (hex.length <= 4) hex = [...hex].map((digit) => digit + digit).join('')
  return `#${hex.slice(0, 6)}`
}

function chromeFromValue(value: string | undefined): WindowChromeColors {
  if (!value) return DEFAULT_CHROME
  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    return DEFAULT_CHROME
  }
  const colors = sanitizeThemeColors(parsed)
  const pick = (color: string | undefined, fallback: string): string =>
    normalizeHex(color) ?? fallback
  return {
    background: pick(colors.background, DEFAULT_CHROME.background),
    titlebar: pick(colors['surface-panel'], DEFAULT_CHROME.titlebar),
    symbol: pick(colors.foreground, DEFAULT_CHROME.symbol)
  }
}

let current = DEFAULT_CHROME

export function currentWindowChrome(): WindowChromeColors {
  return current
}

function applyTo(window: BrowserWindow): void {
  window.setBackgroundColor(current.background)
  if (process.platform === 'win32') {
    try {
      // only exists for windows created with titleBarOverlay; height stays as constructed
      window.setTitleBarOverlay({ color: current.titlebar, symbolColor: current.symbol })
    } catch {
      // windows with a standard OS titlebar (the theme editor) have no overlay
    }
  }
}

/** call once before the first createWindow so the pre-paint background matches the theme */
export async function initWindowChrome(): Promise<void> {
  current = chromeFromValue((await readUiState())[THEME_COLORS_UI_KEY])
  onUiStateSet((key, value) => {
    if (key !== THEME_COLORS_UI_KEY) return
    current = chromeFromValue(value)
    for (const window of BrowserWindow.getAllWindows()) applyTo(window)
  })
}
