import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'fs/promises'
import { basename, join, resolve, sep } from 'path'
import { getDownloadsDir } from '../blender/installs'
import { addToLibraryOrExisting } from './library'
import { resolveUserDirs, versionDir } from './blender-paths'
import {
  parseUserpref,
  REPO_FLAG_DISABLED,
  REPO_FLAG_USE_CUSTOM_DIRECTORY,
  REPO_FLAG_USE_REMOTE_URL,
  REPO_SOURCE_SYSTEM
} from './userpref-parser'
import { buildZip, type ZipInput } from './zip-write'
import { REMOVED_BUNDLED } from '../../shared/addon-identity'
import type { AddonInfo, InstalledBuild, LibraryAddon } from '../../shared/types'

// "Save to Library" — pack an already-installed add-on's on-disk files into a .zip
// (or take its single .py) and hand it to the normal library so it can be reinstalled
// into other Blender versions. Only user/extension add-ons living inside that version's
// known directories are eligible; the resolved path is asserted to stay inside them.

const MAX_BACKUP_BYTES = 512 * 1024 * 1024

/** a single path component with no separators or traversal */
function safeComponent(value: string, label: string): string {
  if (!value || value.includes('/') || value.includes('\\') || value.includes('\0') || value === '..') {
    throw new Error(`Unsafe ${label}`)
  }
  return value
}

/** the resolved child must live inside root (defence against odd module names) */
function assertInside(root: string, child: string): string {
  const base = resolve(root)
  const target = resolve(child)
  if (target !== base && !target.startsWith(base + sep)) throw new Error('Add-on is outside its version folder')
  return target
}

interface Located {
  path: string
  isDirectory: boolean
}

async function existingKind(path: string): Promise<'dir' | 'file' | null> {
  try {
    const info = await stat(path)
    return info.isDirectory() ? 'dir' : info.isFile() ? 'file' : null
  } catch {
    return null
  }
}

async function locateExtensionSource(
  build: InstalledBuild,
  minor: string,
  addon: AddonInfo
): Promise<Located> {
  const repoModule = safeComponent(addon.repoModule ?? '', 'repo')
  const pkgId = safeComponent(addon.pkgId ?? '', 'package id')
  const dirs = resolveUserDirs(build.executable, minor)
  const prefs = await parseUserpref(dirs.userprefPath)
  const repo = prefs.extensionRepos.find((candidate) => candidate.module === repoModule)
  if (!repo || repo.flag & REPO_FLAG_DISABLED) throw new Error('The add-on’s repository is not available')
  let root: string
  if (repo.flag & REPO_FLAG_USE_CUSTOM_DIRECTORY) {
    if (!repo.customDirectory) throw new Error('The add-on’s repository has no directory')
    root = join(repo.customDirectory, pkgId)
  } else {
    const isSystem = repo.source === REPO_SOURCE_SYSTEM && !(repo.flag & REPO_FLAG_USE_REMOTE_URL)
    const base = isSystem ? join(versionDir(build.executable, minor), 'extensions') : dirs.extensionsDir
    root = assertInside(join(base, repoModule), join(base, repoModule, pkgId))
  }
  if ((await existingKind(root)) !== 'dir') throw new Error('The extension’s files are missing from disk')
  return { path: root, isDirectory: true }
}

async function locateUserSource(
  build: InstalledBuild,
  minor: string,
  module: string
): Promise<Located> {
  const dirs = resolveUserDirs(build.executable, minor)
  const roots = [join(dirs.scriptsDir, 'addons')]
  // custom Script Directories configured in preferences
  try {
    const prefs = await parseUserpref(dirs.userprefPath)
    for (const scriptDir of prefs.scriptDirectories) if (scriptDir) roots.push(join(scriptDir, 'addons'))
  } catch {
    // no readable prefs — the standard location still covers the common case
  }
  for (const root of roots) {
    const folder = assertInside(root, join(root, module))
    if ((await existingKind(folder)) === 'dir') return { path: folder, isDirectory: true }
    const file = assertInside(root, join(root, `${module}.py`))
    if ((await existingKind(file)) === 'file') return { path: file, isDirectory: false }
  }
  throw new Error('The add-on’s files could not be found on disk')
}

// A dropped built-in add-on lives inside the install's bundled script dirs. Only reachable
// for add-ons on the REMOVED_BUNDLED allowlist (gated by the caller), so we are packing a
// user's own old copy to carry it forward — never a still-shipping bundled add-on.
async function locateBundledSource(
  build: InstalledBuild,
  minor: string,
  module: string
): Promise<Located> {
  const installSide = versionDir(build.executable, minor)
  const roots = [join(installSide, 'scripts', 'addons'), join(installSide, 'scripts', 'addons_core')]
  for (const root of roots) {
    const folder = assertInside(root, join(root, module))
    if ((await existingKind(folder)) === 'dir') return { path: folder, isDirectory: true }
    const file = assertInside(root, join(root, `${module}.py`))
    if ((await existingKind(file)) === 'file') return { path: file, isDirectory: false }
  }
  throw new Error('The built-in add-on’s files could not be found in this version')
}

async function collectDir(dir: string, prefix: string, out: ZipInput[], budget: { bytes: number }): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const name = entry.name
    if (name === '__pycache__' || name === '.git' || name.startsWith('.')) continue
    const full = join(dir, name)
    const arc = `${prefix}/${name}`
    if (entry.isDirectory()) {
      await collectDir(full, arc, out, budget)
    } else if (entry.isFile()) {
      const data = await readFile(full)
      budget.bytes += data.length
      if (budget.bytes > MAX_BACKUP_BYTES) throw new Error('This add-on is too large to back up')
      out.push({ arcName: arc, data })
    }
  }
}

// Returns the stored (or already-stored — deterministic zips make the auto-backup and a
// later carry produce identical bytes, and that must not fail the install) library entry.
export async function backupInstalledAddon(
  build: InstalledBuild,
  minor: string,
  addon: AddonInfo
): Promise<{ entry: LibraryAddon; existed: boolean }> {
  if (addon.origin === 'core') throw new Error('This is now built into Blender core — there are no add-on files to back up')
  // still-shipping built-ins should be reinstalled from Blender/blender.org, not carried as a
  // stale copy — only the dropped ones (no replacement anywhere) may be saved forward
  if (addon.origin === 'bundled' && !(addon.module in REMOVED_BUNDLED)) {
    throw new Error('Built-in add-ons come with Blender — no need to back them up')
  }
  const module = safeComponent(addon.module, 'module')

  const located =
    addon.origin === 'extension'
      ? await locateExtensionSource(build, minor, addon)
      : addon.origin === 'bundled'
        ? await locateBundledSource(build, minor, module)
        : await locateUserSource(build, minor, module)

  // a single-file .py add-on is already a valid library source
  if (!located.isDirectory) return addToLibraryOrExisting(located.path)

  const folderName = safeComponent(basename(located.path), 'name')
  const files: ZipInput[] = []
  await collectDir(located.path, folderName, files, { bytes: 0 })
  if (files.length === 0) throw new Error('The add-on folder is empty')

  const downloadsRoot = await getDownloadsDir()
  await mkdir(downloadsRoot, { recursive: true })
  // the temp file's basename becomes the stored library file name — keep it clean
  const tempDir = await mkdtemp(join(downloadsRoot, '.backup-'))
  const tempZip = join(tempDir, `${folderName}.zip`)
  await writeFile(tempZip, buildZip(files))
  try {
    return await addToLibraryOrExisting(tempZip)
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {})
  }
}
