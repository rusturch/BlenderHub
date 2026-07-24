import { getLauncherApi } from './preview-fallback'

// Synchronous facade over the persisted UI state (ui-state.json in the data
// folder), so display settings travel with the portable folder. The cache is
// hydrated once before React renders (see main.tsx) — components keep the
// simple `useState(() => uiGet(...))` initializer pattern.

let cache = new Map<string, string>()

// cross-window mirror: another window's uiSet lands here (the floating theme
// editor recoloring the main window live). Own writes are filtered out by the
// cache check — uiSet already updated it synchronously in the writing window.
type UiChangeListener = (key: string, value: string) => void
const changeListeners = new Set<UiChangeListener>()

export function onUiChanged(listener: UiChangeListener): () => void {
  changeListeners.add(listener)
  return () => {
    changeListeners.delete(listener)
  }
}

export async function initUiStore(): Promise<void> {
  const { api, isDesktop } = getLauncherApi()
  try {
    cache = new Map(Object.entries(await api.uiState.getAll()))
  } catch {
    cache = new Map() // broken bridge: uiGet falls back to localStorage below
  }
  api.uiState.onChanged((key, value) => {
    if (cache.get(key) === value) return
    cache.set(key, value)
    try {
      localStorage.setItem(key, value)
    } catch {
      // mirror only — the file copy is authoritative
    }
    for (const listener of changeListeners) listener(key, value)
  })
  if (!isDesktop) return
  // one-time carry-over: settings saved by pre-portable builds live in
  // localStorage; the file always wins once a key exists there
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)
    if (!key || cache.has(key)) continue
    const value = localStorage.getItem(key)
    if (value === null || value.length > 4096) continue
    cache.set(key, value)
    void api.uiState.set(key, value).catch(() => {})
  }
}

export function uiGet(key: string): string | null {
  return cache.get(key) ?? localStorage.getItem(key)
}

export function uiSet(key: string, value: string): void {
  cache.set(key, value)
  try {
    localStorage.setItem(key, value)
  } catch {
    // storage may be unavailable (private mode preview) — the file copy suffices
  }
  const { api, isDesktop } = getLauncherApi()
  if (isDesktop) void api.uiState.set(key, value).catch(() => {})
}
