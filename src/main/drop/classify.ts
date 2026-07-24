import { stat } from 'fs/promises'
import { basename, extname } from 'path'
import { listZipEntries } from '../addons/zip-util'
import { findBlenderRoots } from '../blender/locate'
import type { DroppedItem, DroppedItemKind } from '../../shared/types'

// Classification is deliberately cheap: fs stats, one zip central-directory read,
// a bounded directory walk. Nothing here launches Blender or extracts archives —
// that happens only after the user confirms the drop in the dialog.

/** a Blender build archive holds the executable a couple of levels deep at most
 * (blender-4.5.3-windows-x64/blender.exe); an add-on zip never contains one */
function zipHoldsBlender(names: string[]): boolean {
  return names.some((raw) => {
    const name = raw.replace(/\\/g, '/').toLowerCase()
    const segments = name.split('/')
    const leaf = segments[segments.length - 1]
    if (leaf === 'blender.exe') return true
    if (name.endsWith('blender.app/contents/macos/blender')) return true
    // a bare unix binary named "blender" near the root (linux builds ship as tar.xz,
    // but a repacked zip should still be recognized)
    return leaf === 'blender' && segments.length <= 3
  })
}

export async function classifyDroppedPath(path: string): Promise<DroppedItem> {
  const name = basename(path) || path
  const item = (kind: DroppedItemKind, detail: string | null = null): DroppedItem => ({
    path,
    name,
    kind,
    detail
  })
  let info
  try {
    info = await stat(path)
  } catch {
    return item('unknown', 'File is not accessible')
  }
  if (info.isDirectory()) {
    // a folder with Blender executable(s) inside is an installation to register;
    // any other folder is offered as a project folder
    const roots = await findBlenderRoots(path).catch(() => [])
    return item(roots.length > 0 ? 'build-folder' : 'project-folder')
  }
  const ext = extname(path).toLowerCase()
  if (ext === '.blend') return item('project')
  if (ext === '.py') return item('addon')
  // extname sees only the last segment (".xz"), so tarballs match on the full name
  if (/\.(tar\.xz|tar\.gz)$/i.test(name)) return item('build-archive')
  if (ext === '.dmg') {
    if (process.platform === 'darwin') return item('build-archive')
    return item('unknown', 'A .dmg disk image can only be installed on macOS')
  }
  if (ext === '.zip') {
    let holdsBlender = false
    try {
      holdsBlender = zipHoldsBlender(
        (await listZipEntries(path)).filter((entry) => !entry.name.endsWith('/')).map((entry) => entry.name)
      )
    } catch {
      // unreadable zip — treat it as an add-on and let the library parser report why
    }
    return item(holdsBlender ? 'build-archive' : 'addon')
  }
  return item('unknown')
}
