import { rm, stat } from 'fs/promises'
import { basename, dirname } from 'path'
import { BrowserWindow, ipcMain } from 'electron'
import { downloadArchiveByUrl } from '../addons/extensions-api'
import { addToLibraryOrExisting } from '../addons/library'
import { getSuperhiveToken, SUPERHIVE_HOST } from '../addons/superhive'
import { installLocalArchive } from '../blender/installs'
import { addProjectFile } from '../projects/store'
import { requireString } from '../ipc-util'
import { classifyDroppedPath, extensionLinkFileName, EXTENSION_LINK_HOSTS } from './classify'
import type { DroppedItemKind, DropHandleResult } from '../../shared/types'

// Application Security Requirement: unlike the rest of the IPC surface, these paths DO
// originate in the renderer — an OS drag-and-drop is the one flow where the user hands
// the app arbitrary paths without a native dialog. The handlers only read those paths
// or copy FROM them into launcher-managed places (project list, add-on library, installs
// folder); nothing outside launcher-managed data is ever written, moved or deleted.

const MAX_DROPPED_PATHS = 100

const HANDLED_KINDS: ReadonlySet<string> = new Set([
  'project',
  'addon',
  'addon-url',
  'build-archive'
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
    case 'addon': {
      const { entry, existed } = await addToLibraryOrExisting(path)
      if (!existed) broadcast('addons:library-changed', undefined)
      return { status: existed ? 'skipped' : 'ok', detail: entry.name }
    }
    case 'addon-url': {
      // re-validate here — the kind string came from the renderer, so the URL rules
      // (https + trusted repo host) must hold regardless of what classify said earlier
      const url = new URL(path)
      // the repo sites put the archive's checksum right into the download path
      // (…/download/sha256:<hex>/<file>.zip) — when present, verify against it
      const sha256 = /\/sha256:([a-fA-F0-9]{64})\//.exec(url.pathname)?.[1]?.toLowerCase() ?? null
      const host = url.hostname.toLowerCase()
      const superhive = host === SUPERHIVE_HOST || host.endsWith(`.${SUPERHIVE_HOST}`)
      const token = superhive ? ((await getSuperhiveToken()) ?? undefined) : undefined
      const temp = await downloadArchiveByUrl(path, EXTENSION_LINK_HOSTS, sha256, extensionLinkFileName(url), token)
      try {
        const { entry, existed } = await addToLibraryOrExisting(temp)
        if (!existed) broadcast('addons:library-changed', undefined)
        return { status: existed ? 'skipped' : 'ok', detail: entry.name }
      } finally {
        await rm(dirname(temp), { recursive: true, force: true }).catch(() => {})
      }
    }
    case 'build-archive': {
      const build = await installLocalArchive(path, (progress) => broadcast('builds:install-progress', progress))
      return { status: 'ok', detail: `Blender ${build.version}` }
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
