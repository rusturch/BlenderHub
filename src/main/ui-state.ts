import { BrowserWindow, ipcMain } from 'electron'
import { mkdir, readFile, rename, writeFile } from 'fs/promises'
import { join } from 'path'
import { getDataRoot } from './paths'

// Renderer display settings (card sizes, visible columns, language, sidebar state)
// persisted as a flat key/value JSON in the data folder so they travel with it.
// localStorage remains only as the browser-preview fallback and as the source for
// a one-time carry-over from pre-portable profiles (see renderer lib/ui-store.ts).

const STATE_FILE = 'ui-state.json'
const KEY_RE = /^[A-Za-z0-9_.-]{1,64}$/
const MAX_VALUE_LENGTH = 4096
const MAX_KEYS = 500

const statePath = (): string => join(getDataRoot(), STATE_FILE)

export async function readUiState(): Promise<Record<string, string>> {
  let text: string
  try {
    text = await readFile(statePath(), 'utf8')
  } catch {
    return {}
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return {} // display settings are cheap to lose — no corrupt-file ceremony
  }
  if (!parsed || typeof parsed !== 'object') return {}
  const state: Record<string, string> = {}
  for (const [key, value] of Object.entries(parsed)) {
    if (KEY_RE.test(key) && typeof value === 'string' && value.length <= MAX_VALUE_LENGTH) {
      state[key] = value
    }
  }
  return state
}

// main-process modules (tray) react to renderer setting flips without polling the file
type UiStateListener = (key: string, value: string) => void
const listeners = new Set<UiStateListener>()

export function onUiStateSet(listener: UiStateListener): void {
  listeners.add(listener)
}

// same discipline as config.ts: serialized queue + atomic tmp+rename writes
let writeQueue: Promise<unknown> = Promise.resolve()

function setUiValue(key: string, value: string): Promise<void> {
  const run = writeQueue.then(async () => {
    const state = await readUiState()
    if (state[key] === value) return
    state[key] = value
    if (Object.keys(state).length > MAX_KEYS) throw new Error('UI state is full')
    await mkdir(getDataRoot(), { recursive: true })
    const target = statePath()
    await writeFile(`${target}.tmp`, JSON.stringify(state, null, 2))
    await rename(`${target}.tmp`, target)
  })
  writeQueue = run.catch(() => {})
  return run
}

export function registerUiStateIpc(): void {
  ipcMain.handle('ui:get-state', () => readUiState())
  ipcMain.handle('ui:set-state', (_event, rawKey: unknown, rawValue: unknown) => {
    if (typeof rawKey !== 'string' || !KEY_RE.test(rawKey)) {
      throw new Error('Invalid ui-state key')
    }
    if (typeof rawValue !== 'string' || rawValue.length > MAX_VALUE_LENGTH) {
      throw new Error('Invalid ui-state value')
    }
    return setUiValue(rawKey, rawValue).then(() => {
      for (const listener of listeners) listener(rawKey, rawValue)
      // windows mirror each other's settings live (e.g. the floating theme
      // editor recoloring the main window); renderers drop their own echoes
      for (const window of BrowserWindow.getAllWindows()) {
        window.webContents.send('ui:state-changed', rawKey, rawValue)
      }
    })
  })
}
