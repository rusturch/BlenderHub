import type { Page } from './types'

// Which tabs the tray's quick-jump section can offer, in menu order. Activity and
// Settings are deliberately absent — the tray jumps to work, not to chrome.
export const TRAY_PAGE_IDS: readonly Page[] = ['projects', 'installs', 'addons', 'sync']

/** ui-state key holding the enabled tray tabs as a comma-separated list */
export const TRAY_PAGES_KEY = 'tray.pages'

/** what an unset key means — a deliberately minimal menu */
export const DEFAULT_TRAY_PAGES: readonly Page[] = ['projects']

/**
 * Enabled tray tabs, always in TRAY_PAGE_IDS order and free of ids this build no
 * longer knows. Absent (renderer's uiGet yields null, main's ui-state map yields
 * undefined) means never configured → the default; an empty string is a real
 * choice the user made: no tabs at all.
 */
export function parseTrayPages(raw: string | null | undefined): Page[] {
  if (raw === null || raw === undefined) return [...DEFAULT_TRAY_PAGES]
  const enabled = new Set(raw.split(','))
  return TRAY_PAGE_IDS.filter((page) => enabled.has(page))
}

export function serializeTrayPages(pages: readonly Page[]): string {
  return TRAY_PAGE_IDS.filter((page) => pages.includes(page)).join(',')
}
