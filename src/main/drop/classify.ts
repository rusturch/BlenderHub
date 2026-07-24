import { stat } from 'fs/promises'
import { basename, extname } from 'path'
import { BLENDER_ORG_HOST } from '../addons/extensions-api'
import { SUPERHIVE_HOST } from '../addons/superhive'
import { listZipEntries } from '../addons/zip-util'
import { findBlenderRoots } from '../blender/locate'
import type { DroppedItem, DroppedItemKind } from '../../shared/types'

// Classification is deliberately cheap: fs stats, one zip central-directory read,
// a bounded directory walk. Nothing here launches Blender or extracts archives —
// that happens only after the user confirms the drop in the dialog.

// Extension links may only come from the repos the launcher already trusts for
// add-on downloads — the same hosts (and their subdomains) as the catalog installs.
export const EXTENSION_LINK_HOSTS = [BLENDER_ORG_HOST, SUPERHIVE_HOST]

export function isTrustedExtensionHost(hostname: string): boolean {
  const host = hostname.toLowerCase()
  return EXTENSION_LINK_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`))
}

/** display name for a dropped link — the archive file name when the URL has one */
export function extensionLinkFileName(url: URL): string {
  let leaf = url.pathname.split('/').pop() ?? ''
  try {
    leaf = decodeURIComponent(leaf)
  } catch {
    // malformed escapes — keep the raw segment
  }
  // same character policy as project names; the name becomes a file inside a temp dir
  const safe = leaf.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').trim()
  if (!safe) return 'extension.zip'
  return /\.zip$/i.test(safe) ? safe : `${safe}.zip`
}

// The "Drag and Drop into Blender" buttons on repo sites put a plain-text download
// URL into the drag (verified live on extensions.blender.org: text/plain with
// https://extensions.blender.org/download/sha256:<hex>/<file>.zip?...) — the same
// payload Blender itself accepts.
function classifyDroppedUrl(raw: string): DroppedItem {
  const item = (kind: DroppedItemKind, name: string, detail: string | null = null): DroppedItem => ({
    path: raw,
    name,
    kind,
    detail
  })
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return item('unknown', raw, 'Not a valid link')
  }
  const name = extensionLinkFileName(url)
  if (url.protocol !== 'https:' || !isTrustedExtensionHost(url.hostname)) {
    return item('unknown', url.hostname, `Only extension links from ${EXTENSION_LINK_HOSTS.join(' or ')} are supported`)
  }
  // a page link (the add-on's web page) is not an archive — ask for the drag button
  if (!/\.zip$/i.test(url.pathname) && !url.pathname.includes('/download/')) {
    return item('unknown', url.hostname + url.pathname, 'Drag the site’s "Drag and Drop" button, not a page link')
  }
  return item('addon-url', name)
}

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
  // dragging a link (or the repo sites' install buttons) delivers a URL, not a file
  if (/^https?:\/\//i.test(path)) return classifyDroppedUrl(path)
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
