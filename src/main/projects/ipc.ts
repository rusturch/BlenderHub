import { execFile, spawn } from 'child_process'
import { existsSync } from 'fs'
import { dialog, ipcMain, shell } from 'electron'
import { basename, isAbsolute, join, relative, resolve } from 'path'
import { findInstalled } from '../blender/installs'
import { requireString } from '../ipc-util'
import { refreshTrayMenu } from '../tray'
import { listUnavailableFolders, scanProjectFiles } from './service'
import {
  clearPreviewSidecar,
  deleteProject,
  duplicateProject,
  findMissingFile,
  moveProject,
  PREVIEW_EXTENSIONS,
  relinkMissingFiles,
  renameProject,
  setPreviewSidecar
} from './manage'
import {
  addProjectFile,
  addProjectFolder,
  getKnownFiles,
  getProjectFiles,
  getProjectFolders,
  recordProjectOpened,
  relocateProjectFolder,
  removeProjectFolder,
  setKnownFiles,
  untrackProjectPaths
} from './store'
import type { ProjectFolder } from '../../shared/types'

// Application Security Requirement: file paths received over IPC are only acted on
// after verifying they belong to a user-registered project folder or file, and Blender
// is spawned with an argument array (no shell) — no path or command injection from the
// page. New-project files are written only inside a folder the user picked in a dialog.

async function assertAllowed(filePath: string): Promise<string> {
  const target = resolve(filePath)
  const [folders, files] = await Promise.all([getProjectFolders(), getProjectFiles()])
  if (files.some((known) => resolve(known) === target)) return target
  for (const folder of folders) {
    const rel = relative(resolve(folder), target)
    if (rel && !rel.startsWith('..') && !isAbsolute(rel)) return target
  }
  throw new Error('File is outside of the registered projects')
}

// basename('E:\') is '' — a drive root has no name segment to extract, so fall
// back to the path itself (e.g. "E:\") rather than showing an empty pill
async function listFoldersWithStatus(): Promise<ProjectFolder[]> {
  const folders = await getProjectFolders()
  const unavailable = new Set(await listUnavailableFolders(folders))
  return folders.map((path) => ({
    path,
    name: basename(path) || path,
    missing: unavailable.has(path)
  }))
}

// scan with the current config and hand back the missing entries (folder-level
// unavailability is already excluded by the scan itself)
async function scanMissingFiles(): Promise<{ missingPaths: string[]; folders: string[] }> {
  const [folders, files, known] = await Promise.all([
    getProjectFolders(),
    getProjectFiles(),
    getKnownFiles()
  ])
  const scan = await scanProjectFiles(folders, files, known)
  return {
    missingPaths: scan.files.filter((file) => file.missing).map((file) => file.path),
    folders
  }
}

function createEmptyBlend(executable: string, cwd: string, targetPath: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    // path is passed via env var, never interpolated into the Python source
    execFile(
      executable,
      [
        '--background',
        '--factory-startup',
        '--python-expr',
        'import bpy, os; bpy.ops.wm.save_as_mainfile(filepath=os.environ["BL_NEW_PROJECT"])'
      ],
      { cwd, windowsHide: true, timeout: 90_000, env: { ...process.env, BL_NEW_PROJECT: targetPath } },
      (error) => {
        if (error) reject(new Error('Blender could not create the project file'))
        else if (!existsSync(targetPath)) reject(new Error('Blender did not write the file'))
        else resolvePromise()
      }
    )
  })
}

export function registerProjectsIpc(): void {
  ipcMain.handle('projects:list-folders', async () => listFoldersWithStatus())

  ipcMain.handle('projects:add-folder', async () => {
    const picked = await dialog.showOpenDialog({
      title: 'Add project folder',
      properties: ['openDirectory']
    })
    if (!picked.canceled && picked.filePaths[0]) {
      await addProjectFolder(picked.filePaths[0])
    }
    return listFoldersWithStatus()
  })

  ipcMain.handle('projects:add-file', async () => {
    const picked = await dialog.showOpenDialog({
      title: 'Add .blend file',
      properties: ['openFile'],
      filters: [{ name: 'Blender files', extensions: ['blend'] }]
    })
    if (picked.canceled || !picked.filePaths[0]) return null
    await addProjectFile(picked.filePaths[0])
    return picked.filePaths[0]
  })

  ipcMain.handle('projects:pick-folder', async () => {
    const picked = await dialog.showOpenDialog({
      title: 'Choose project location',
      properties: ['openDirectory']
    })
    return picked.canceled ? null : (picked.filePaths[0] ?? null)
  })

  ipcMain.handle('projects:remove-folder', async (_event, rawPath: unknown) => {
    await removeProjectFolder(requireString(rawPath, 'folder path'))
    return listFoldersWithStatus()
  })

  ipcMain.handle('projects:relocate-folder', async (_event, rawPath: unknown) => {
    const oldRoot = resolve(requireString(rawPath, 'folder path'))
    const folders = await getProjectFolders()
    if (!folders.some((known) => resolve(known) === oldRoot)) {
      throw new Error('Not a registered project folder')
    }
    const picked = await dialog.showOpenDialog({
      title: 'Set the new folder location',
      properties: ['openDirectory']
    })
    if (picked.canceled || !picked.filePaths[0]) return null
    await relocateProjectFolder(oldRoot, picked.filePaths[0])
    refreshTrayMenu()
    return listFoldersWithStatus()
  })

  ipcMain.handle('projects:remove-missing', async () => {
    const { missingPaths } = await scanMissingFiles()
    await untrackProjectPaths(missingPaths)
  })

  ipcMain.handle('projects:relink-missing', async () => {
    const picked = await dialog.showOpenDialog({
      title: 'Find missing files — choose a folder to search',
      properties: ['openDirectory']
    })
    if (picked.canceled || !picked.filePaths[0]) return null
    const { missingPaths, folders } = await scanMissingFiles()
    const relinked = await relinkMissingFiles(missingPaths, picked.filePaths[0], folders)
    if (relinked > 0) refreshTrayMenu()
    return { relinked, total: missingPaths.length }
  })

  ipcMain.handle('projects:list-files', async () => {
    const [folders, files, known] = await Promise.all([
      getProjectFolders(),
      getProjectFiles(),
      getKnownFiles()
    ])
    const scan = await scanProjectFiles(folders, files, known)
    await setKnownFiles(scan.known)
    return scan.files
  })

  ipcMain.handle('projects:list-tracked-files', async () => getProjectFiles())

  ipcMain.handle('projects:rename-file', async (_event, rawPath: unknown, rawName: unknown) => {
    const path = await assertAllowed(requireString(rawPath, 'file path'))
    if (!path.toLowerCase().endsWith('.blend')) throw new Error('Not a .blend file')
    // same character policy as projects:create — the renderer sends a bare name, not a path
    const safeName = requireString(rawName, 'file name')
      .slice(0, 120)
      .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
      .trim()
    if (!safeName || safeName.toLowerCase() === '.blend') throw new Error('Enter a valid file name')
    const fileName = safeName.toLowerCase().endsWith('.blend') ? safeName : `${safeName}.blend`
    const renamed = await renameProject(path, fileName)
    refreshTrayMenu()
    return renamed
  })

  ipcMain.handle('projects:duplicate-file', async (_event, rawPath: unknown) => {
    const path = await assertAllowed(requireString(rawPath, 'file path'))
    if (!path.toLowerCase().endsWith('.blend')) throw new Error('Not a .blend file')
    return duplicateProject(path)
  })

  ipcMain.handle('projects:set-preview', async (_event, rawPath: unknown) => {
    const path = await assertAllowed(requireString(rawPath, 'file path'))
    const picked = await dialog.showOpenDialog({
      title: 'Choose a preview image',
      properties: ['openFile'],
      filters: [{ name: 'Images', extensions: PREVIEW_EXTENSIONS }]
    })
    if (picked.canceled || !picked.filePaths[0]) return false
    await setPreviewSidecar(path, picked.filePaths[0])
    return true
  })

  ipcMain.handle('projects:clear-preview', async (_event, rawPath: unknown) => {
    const path = await assertAllowed(requireString(rawPath, 'file path'))
    await clearPreviewSidecar(path)
  })

  ipcMain.handle('projects:move', async (_event, rawPath: unknown) => {
    const path = await assertAllowed(requireString(rawPath, 'file path'))
    const picked = await dialog.showOpenDialog({
      title: 'Move project to…',
      properties: ['openDirectory']
    })
    if (picked.canceled || !picked.filePaths[0]) return null
    return moveProject(path, picked.filePaths[0])
  })

  ipcMain.handle('projects:find-missing', async (_event, rawPath: unknown) => {
    const path = resolve(requireString(rawPath, 'file path'))
    const [files, known] = await Promise.all([getProjectFiles(), getKnownFiles()])
    if (![...files, ...known].some((tracked) => resolve(tracked) === path)) {
      throw new Error('Not a tracked project file')
    }
    const picked = await dialog.showOpenDialog({
      title: 'Find missing file — choose a folder to search',
      properties: ['openDirectory']
    })
    if (picked.canceled || !picked.filePaths[0]) return null
    const found = await findMissingFile(path, picked.filePaths[0])
    if (!found) throw new Error('Could not find the file in the selected folder')
    return found
  })

  ipcMain.handle('projects:remove-from-list', async (_event, rawPath: unknown) => {
    const path = await assertAllowed(requireString(rawPath, 'file path'))
    // drops the entry only; a file living in (or returning to) a tracked folder
    // is picked up by the next scan again
    await untrackProjectPaths([path])
  })

  ipcMain.handle('projects:delete-file', async (_event, rawPath: unknown) => {
    const path = await assertAllowed(requireString(rawPath, 'file path'))
    if (!path.toLowerCase().endsWith('.blend')) throw new Error('Not a .blend file')
    await deleteProject(path)
  })

  ipcMain.handle('projects:create', async (_event, raw: unknown) => {
    const input = (raw ?? {}) as { name?: unknown; installId?: unknown; folder?: unknown }
    const rawName = requireString(input.name, 'project name').trim()
    const installId = requireString(input.installId, 'install id')
    const folder = resolve(requireString(input.folder, 'folder'))

    const safeName = rawName.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim()
    if (!safeName) throw new Error('Enter a valid project name')
    const fileName = safeName.toLowerCase().endsWith('.blend') ? safeName : `${safeName}.blend`
    const targetPath = join(folder, fileName)
    if (existsSync(targetPath)) throw new Error('A file with this name already exists in that folder')

    const build = await findInstalled(installId)
    await createEmptyBlend(build.executable, build.path, targetPath)
    await addProjectFile(targetPath)
    return targetPath
  })

  ipcMain.handle('projects:open-file', async (_event, rawPath: unknown, rawInstallId: unknown) => {
    const filePath = await assertAllowed(requireString(rawPath, 'file path'))
    if (!filePath.toLowerCase().endsWith('.blend')) throw new Error('Not a .blend file')
    const build = await findInstalled(requireString(rawInstallId, 'install id'))
    // windowsHide: blender.exe is a console-subsystem app; detached without it makes
    // Windows spawn a fresh (visible) console for it. CREATE_NO_WINDOW keeps it hidden.
    const child = spawn(build.executable, [filePath], {
      cwd: build.path,
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    })
    child.unref()
    // best-effort bookkeeping for the tray's Recent Projects — must never fail the open itself
    recordProjectOpened(filePath)
      .then(() => refreshTrayMenu())
      .catch(() => {})
  })

  ipcMain.handle('projects:reveal', async (_event, rawPath: unknown) => {
    shell.showItemInFolder(await assertAllowed(requireString(rawPath, 'file path')))
  })
}
