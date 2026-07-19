import { ipcMain, shell } from 'electron'
import { mkdir, readdir, readFile, rename, stat, writeFile } from 'fs/promises'
import { join } from 'path'
import { getDataRoot } from '../paths'
import { requireString } from '../ipc-util'
import { isThemeId, sanitizeThemeColors, THEME_NAME_MAX } from '../../shared/theme'
import type { UserThemeFile } from '../../shared/types'

// User themes: one JSON file per theme in <dataRoot>/themes, picked up on every
// list. Built-in presets are bundled with the renderer and never pass through here.

const MAX_FILE_BYTES = 64 * 1024
const MAX_THEMES = 200

const themesDir = (): string => join(getDataRoot(), 'themes')

const themePath = (id: string): string => join(themesDir(), `${id}.json`)

async function listThemes(): Promise<UserThemeFile[]> {
  let entries: string[]
  try {
    entries = await readdir(themesDir())
  } catch {
    return [] // the folder appears on first save
  }
  const themes: UserThemeFile[] = []
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue
    const id = entry.slice(0, -'.json'.length)
    if (!isThemeId(id)) continue
    try {
      const path = join(themesDir(), entry)
      // size-check before reading — the folder is user-writable, don't buffer surprises
      if ((await stat(path)).size > MAX_FILE_BYTES) continue
      const text = await readFile(path, 'utf8')
      const parsed = JSON.parse(text) as { name?: unknown; colors?: unknown }
      const rawName = typeof parsed.name === 'string' ? parsed.name.trim() : ''
      themes.push({
        id,
        name: rawName ? rawName.slice(0, THEME_NAME_MAX) : id,
        colors: sanitizeThemeColors(parsed.colors)
      })
    } catch (error) {
      console.warn(`[themes] skipping unreadable theme file ${entry}:`, error)
    }
    if (themes.length >= MAX_THEMES) break
  }
  themes.sort((a, b) => a.name.localeCompare(b.name))
  return themes
}

function requireThemeId(value: unknown): string {
  const id = requireString(value, 'theme id')
  if (!isThemeId(id)) throw new Error('Invalid theme id')
  return id
}

// saves to the same id share one tmp file — serialize them so concurrent writes
// (e.g. a rename committing on blur while Save is clicked) cannot interleave
const saveChains = new Map<string, Promise<void>>()

export function registerThemesIpc(): void {
  ipcMain.handle('themes:list', () => listThemes())

  ipcMain.handle(
    'themes:save',
    async (_event, rawId: unknown, rawName: unknown, rawColors: unknown) => {
      const id = requireThemeId(rawId)
      const name = requireString(rawName, 'theme name').trim().slice(0, THEME_NAME_MAX)
      if (!name) throw new Error('Invalid theme name')
      const colors = sanitizeThemeColors(rawColors)
      const write = async (): Promise<void> => {
        await mkdir(themesDir(), { recursive: true })
        const entries = await readdir(themesDir())
        const existing = entries.filter((entry) => entry.endsWith('.json'))
        if (!existing.includes(`${id}.json`) && existing.length >= MAX_THEMES) {
          throw new Error('Theme limit reached')
        }
        // whole-file replace: tmp+rename keeps a crash from leaving a half-written theme
        const target = themePath(id)
        await writeFile(`${target}.tmp`, JSON.stringify({ name, colors }, null, 2))
        await rename(`${target}.tmp`, target)
      }
      const run = (saveChains.get(id) ?? Promise.resolve()).then(write)
      saveChains.set(id, run.catch(() => {}))
      return run
    }
  )

  ipcMain.handle('themes:delete', async (_event, rawId: unknown) => {
    const target = themePath(requireThemeId(rawId))
    try {
      await stat(target)
    } catch {
      return // already gone — deleting twice is not an error
    }
    await shell.trashItem(target)
  })

  ipcMain.handle('themes:open-dir', async () => {
    await mkdir(themesDir(), { recursive: true })
    await shell.openPath(themesDir())
  })
}
