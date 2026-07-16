import { BrowserWindow, dialog, ipcMain, shell } from 'electron'
import { mkdir } from 'fs/promises'
import { basename } from 'path'
import { scanAllAddons } from './scan'
import { applyPlan } from './batch'
import {
  addToLibrary,
  DUPLICATE_ERROR,
  getLibraryDir,
  listLibrary,
  removeFromLibrary,
  resetLibraryDir,
  revealLibraryEntry,
  setLibraryDir
} from './library'
import { captureInstalledToLibrary } from './capture'
import {
  clearSuperhiveToken,
  getSuperhiveStatus,
  listSuperhiveCatalog,
  setSuperhiveToken
} from './superhive'
import { listBlenderOrgCatalog } from './blender-org'
import { requireString } from '../ipc-util'
import { withExclusiveOp } from '../op-lock'
import type {
  AddonUninstallOutcome,
  AddonUninstallResult,
  ApplyPlanOutcome,
  ApplyPlanRequest,
  LibraryAddResult,
  PlanInstallRequest,
  VersionAddons
} from '../../shared/types'

// Application Security Requirement: the renderer sends only primitives — module names
// are accepted solely when they match what the main process itself read from that very
// Blender version during the last scan; file paths come exclusively from dialogs here.
// Blender always runs via execFile with an argument array (no shell), and python
// payloads travel through files + env vars, never string interpolation.

let cache: VersionAddons[] | null = null

/** settings sync rewrites userpref.blend — the enabled flags cached here go stale */
export function invalidateAddonsCache(): void {
  cache = null
}

const MINOR_RE = /^\d+\.\d+$/

// A Blender add-on module is a Python module name OR a folder/file name — legacy single-file
// add-ons installed from a file whose name has spaces carry those spaces in the module. So we
// don't restrict to identifier characters; we reject only path-dangerous / malformed forms.
// The module never becomes code or a path here — it travels as a JSON value and is matched
// against our own scan cache in batch.ts, which is the real security boundary.
function requireModule(value: unknown): string {
  const module = requireString(value, 'module name')
  const hasControlChar = [...module].some((ch) => ch.charCodeAt(0) < 0x20)
  if (
    module.length > 200 ||
    module.includes('/') ||
    module.includes('\\') ||
    module.includes('..') ||
    hasControlChar
  ) {
    throw new Error('Invalid module name')
  }
  return module
}

function broadcast(channel: string, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send(channel, payload)
  }
}

// one add-on OPERATION at a time, sharing the launcher-wide lock with settings sync
// (both spawn headless Blender and write the same userpref.blend files). Inside an
// operation the engines parallelize across Blender versions (each minor has its own
// config dir, so cross-minor runs never race) — same-minor work stays sequential.
const withBusy = <T>(task: () => Promise<T>): Promise<T> => withExclusiveOp('add-on', task)

// Application Security Requirement: the plan arrives as ids/primitives only. Every string
// is validated here; sources are resolved to files inside main (batch.ts), backup modules
// are matched against our own scan cache, and file paths never come from the renderer.
function parsePlan(raw: unknown): ApplyPlanRequest {
  const { installs, uninstalls, enable, disable } = (raw ?? {}) as {
    installs?: unknown
    uninstalls?: unknown
    enable?: unknown
    disable?: unknown
  }
  const requireMinor = (value: unknown): string => {
    const minor = requireString(value, 'blender version')
    if (!MINOR_RE.test(minor)) throw new Error('Invalid blender version')
    return minor
  }
  const parsePairs = (value: unknown, cap: number): { minor: string; module: string }[] => {
    if (value === undefined) return []
    if (!Array.isArray(value) || value.length > cap) throw new Error('Invalid apply payload')
    return value.map((item) => ({
      minor: requireMinor((item as { minor?: unknown })?.minor),
      module: requireModule((item as { module?: unknown })?.module)
    }))
  }
  if (installs !== undefined && (!Array.isArray(installs) || installs.length > 150)) {
    throw new Error('Invalid apply payload')
  }
  const parsedInstalls: PlanInstallRequest[] = ((installs as unknown[]) ?? []).map((item) => {
    const { minor, kind, id, module, sourceMinor } = (item ?? {}) as Record<string, unknown>
    const kindStr = requireString(kind, 'install source')
    if (!['superhive', 'blender_org', 'library', 'backup'].includes(kindStr)) {
      throw new Error('Invalid install source')
    }
    const idStr = requireString(id, 'install id')
    if (idStr.length > 300) throw new Error('Invalid install id')
    if (kindStr === 'superhive' && !/^[A-Za-z0-9_]{1,120}$/.test(idStr)) throw new Error('Invalid extension id')
    if (kindStr === 'library' && !/^[a-f0-9]{12}$/.test(idStr)) throw new Error('Invalid library id')
    const request: PlanInstallRequest = {
      minor: requireMinor(minor),
      kind: kindStr as PlanInstallRequest['kind'],
      id: idStr
    }
    if (kindStr === 'backup') {
      request.module = requireModule(module)
      request.sourceMinor = requireMinor(sourceMinor)
    }
    return request
  })
  return {
    installs: parsedInstalls,
    uninstalls: parsePairs(uninstalls, 150),
    enable: parsePairs(enable, 400),
    disable: parsePairs(disable, 400)
  }
}

// Every scan and every Apply is followed by an automatic Library backup of whatever
// is installed (capture.ts) — moving the launcher folder then carries all add-ons
// along. It runs in the background AFTER the operation releases the op-lock: zipping
// a large first-run corpus must not stall the scan UI or block the next operation.
// When it stores anything new, the renderer is told to refresh its library list.
// Failures only log: a backup problem must not fail the scan/apply that triggered it.
let captureRunning = false
function scheduleAutoCapture(): void {
  if (captureRunning || !cache) return
  captureRunning = true
  // snapshot: an apply/uninstall may mutate the live cache while the capture walks it
  const snapshot = cache.map((version) => ({ ...version, addons: [...version.addons] }))
  captureInstalledToLibrary(snapshot)
    .then((result) => {
      for (const failure of result.failed) {
        console.warn(`[addons] auto-backup of ${failure.module} (${failure.minor}) failed: ${failure.error}`)
      }
      if (result.added > 0) broadcast('addons:library-changed', null)
    })
    .catch((error) => console.warn('[addons] auto-backup failed:', error))
    .finally(() => {
      captureRunning = false
    })
}

export function registerAddonsIpc(): void {
  ipcMain.handle('addons:get-cached', () => cache)

  // concurrent scan requests join the in-flight one instead of hitting the op-lock:
  // the page auto-scans on every mount, so a quick tab roundtrip must not error out
  let scanInFlight: Promise<VersionAddons[]> | null = null
  ipcMain.handle('addons:scan', () => {
    if (!scanInFlight) {
      scanInFlight = withBusy(async () => {
        cache = await scanAllAddons((progress) => broadcast('addons:scan-progress', progress))
        return cache
      }).finally(() => {
        scanInFlight = null
      })
      scanInFlight.then(() => scheduleAutoCapture()).catch(() => {})
    }
    return scanInFlight
  })

  ipcMain.handle('addons:apply-plan', (_event, raw: unknown) =>
    withBusy(async (): Promise<ApplyPlanOutcome> => {
      const plan = parsePlan(raw)
      return applyPlan(
        cache,
        plan,
        (progress) => broadcast('addons:library-progress', progress),
        (progress) => broadcast('addons:apply-progress', progress)
      )
    }).then((outcome) => {
      // fresh installs (e.g. a Superhive build) get their Library copy right away
      scheduleAutoCapture()
      return outcome
    })
  )

  ipcMain.handle('addons:uninstall', (_event, raw: unknown) =>
    withBusy(async (): Promise<AddonUninstallOutcome> => {
      if (!Array.isArray(raw) || raw.length > 150) throw new Error('Invalid uninstall request')
      if (!cache) throw new Error('Scan the versions first')
      // renderer sends only (minor, module) pairs; everything else is resolved from our own cache
      const targets = raw.map((item) => {
        const minor = requireString((item as { minor?: unknown })?.minor, 'blender version')
        if (!MINOR_RE.test(minor)) throw new Error('Invalid uninstall target')
        const module = requireModule((item as { module?: unknown })?.module)
        return { minor, module }
      })
      // same engine as Apply: modules of one version share a run, versions run in parallel
      const outcome = await applyPlan(
        cache,
        { installs: [], uninstalls: targets, enable: [], disable: [] },
        undefined,
        (progress) => broadcast('addons:apply-progress', progress)
      )
      const results: AddonUninstallResult[] = outcome.results.map((result) => ({
        minor: result.minor,
        module: result.id,
        status: result.status === 'ok' ? 'removed' : result.status,
        detail: result.detail
      }))
      return { results, data: cache }
    })
  )

  ipcMain.handle('addons:library-list', () => listLibrary())

  ipcMain.handle('superhive:status', () => getSuperhiveStatus())
  // the raw token is validated and encrypted in main; only a status ever returns
  ipcMain.handle('superhive:connect', (_event, rawToken: unknown) => setSuperhiveToken(rawToken))
  ipcMain.handle('superhive:disconnect', () => clearSuperhiveToken())
  ipcMain.handle('superhive:list', () => listSuperhiveCatalog())
  ipcMain.handle('addons:blender-org-list', () => listBlenderOrgCatalog())

  ipcMain.handle('addons:library-add', async (event): Promise<LibraryAddResult | null> => {
    // modal to the app window, so a double-click cannot stack two pickers
    const owner = BrowserWindow.fromWebContents(event.sender)
    const options = {
      title: 'Add add-ons to the library',
      properties: ['openFile' as const, 'multiSelections' as const],
      filters: [{ name: 'Blender add-on', extensions: ['zip', 'py'] }]
    }
    const picked = owner ? await dialog.showOpenDialog(owner, options) : await dialog.showOpenDialog(options)
    if (picked.canceled || picked.filePaths.length === 0) return null
    const result: LibraryAddResult = { added: [], skipped: [], failed: [] }
    // add sequentially — addToLibrary serializes the config write anyway, and one bad
    // file (duplicate / unreadable) must not abort the rest of the batch
    for (const filePath of picked.filePaths) {
      try {
        result.added.push(await addToLibrary(filePath))
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        // a file already in the library is a no-op skip, not a failure to surface loudly
        if (message === DUPLICATE_ERROR) result.skipped.push(basename(filePath))
        else result.failed.push({ fileName: basename(filePath), error: message })
      }
    }
    return result
  })

  ipcMain.handle('addons:library-remove', (_event, rawId: unknown) =>
    removeFromLibrary(requireString(rawId, 'library id'))
  )

  ipcMain.handle('addons:get-library-dir', () => getLibraryDir())

  ipcMain.handle('addons:pick-library-dir', async () => {
    const picked = await dialog.showOpenDialog({
      title: 'Choose a folder for stored add-on files',
      properties: ['openDirectory', 'createDirectory']
    })
    if (picked.canceled || !picked.filePaths[0]) return null
    // moving the stored files is a library write — serialize with installs/backups
    return withBusy(() => setLibraryDir(picked.filePaths[0]))
  })

  ipcMain.handle('addons:reset-library-dir', () => withBusy(() => resetLibraryDir()))

  ipcMain.handle('addons:open-library-dir', async () => {
    const dir = await getLibraryDir()
    await mkdir(dir, { recursive: true })
    await shell.openPath(dir)
  })

  ipcMain.handle('addons:library-reveal', (_event, rawId: unknown) =>
    revealLibraryEntry(requireString(rawId, 'library id'))
  )
}
