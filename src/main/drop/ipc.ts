import { stat } from 'fs/promises'
import { basename } from 'path'
import { BrowserWindow, ipcMain } from 'electron'
import { addToLibraryOrExisting } from '../addons/library'
import { getInstallsDir, installLocalArchive } from '../blender/installs'
import { locateInstalls } from '../blender/locate'
import { addProjectFile, addProjectFolder } from '../projects/store'
import { requireString } from '../ipc-util'
import { classifyDroppedPath } from './classify'
import type { DroppedItemKind, DropHandleResult } from '../../shared/types'

// Application Security Requirement: unlike the rest of the IPC surface, these paths DO
// originate in the renderer — an OS drag-and-drop is the one flow where the user hands
// the app arbitrary paths without a native dialog. The handlers only read those paths
// or copy FROM them into launcher-managed places (project list, add-on library, installs
// folder); nothing outside launcher-managed data is ever written, moved or deleted.

const MAX_DROPPED_PATHS = 100

const HANDLED_KINDS: ReadonlySet<string> = new Set([
  'project',
  'project-folder',
  'addon',
  'build-archive',
  'build-folder'
] satisfies DroppedItemKind[])

function requirePaths(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new Error('Expected dropped paths')
  if (raw.length > MAX_DROPPED_PATHS) throw new Error(`Too many dropped files (limit ${MAX_DROPPED_PATHS})`)
  return raw.map((entry) => requireString(entry, 'dropped path'))
}

function requireKind(raw: unknown): DroppedItemKind {
  const kind = requireString(raw, 'dropped item kind')
  if (!HANDLED_KINDS.has(kind)) throw new Error('Unsupported dropped item kind')
  return kind as DroppedItemKind
}

function broadcast(channel: string, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send(channel, payload)
  }
}

async function handleItem(path: string, kind: DroppedItemKind): Promise<DropHandleResult> {
  switch (kind) {
    case 'project': {
      if (!path.toLowerCase().endsWith('.blend')) throw new Error('Not a .blend file')
      await stat(path) // must still exist
      await addProjectFile(path)
      return { status: 'ok', detail: basename(path) }
    }
    case 'project-folder': {
      if (!(await stat(path)).isDirectory()) throw new Error('Not a folder')
      await addProjectFolder(path)
      return { status: 'ok', detail: basename(path) || path }
    }
    case 'addon': {
      const { entry, existed } = await addToLibraryOrExisting(path)
      if (!existed) broadcast('addons:library-changed', undefined)
      return { status: existed ? 'skipped' : 'ok', detail: entry.name }
    }
    case 'build-archive': {
      const build = await installLocalArchive(path, (progress) => broadcast('builds:install-progress', progress))
      return { status: 'ok', detail: `Blender ${build.version}` }
    }
    case 'build-folder': {
      // builds inside the launcher's own installs folder come back [] — the
      // regular listing adopts those automatically, so the drop is a no-op
      const added = await locateInstalls(path, await getInstallsDir())
      if (added.length === 0) return { status: 'skipped', detail: null }
      return { status: 'ok', detail: added.map((build) => `Blender ${build.version}`).join(', ') }
    }
    default:
      throw new Error('Unsupported dropped item kind')
  }
}

export function registerDropIpc(): void {
  ipcMain.handle('drop:classify', (_event, rawPaths: unknown) =>
    Promise.all(requirePaths(rawPaths).map(classifyDroppedPath))
  )

  // errors come back as a result, not a rejection — one bad item must not look
  // like a failure of the whole batch the renderer is walking through
  ipcMain.handle('drop:handle', async (_event, rawPath: unknown, rawKind: unknown): Promise<DropHandleResult> => {
    const path = requireString(rawPath, 'dropped path')
    const kind = requireKind(rawKind)
    try {
      return await handleItem(path, kind)
    } catch (error) {
      return { status: 'error', detail: error instanceof Error ? error.message : String(error) }
    }
  })
}
