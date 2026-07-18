import { PREFERRED_EXTENSION } from './blender-builds'
import type { RemoteBuild } from './types'

// Oldest release series worth listing (first modern LTS)
const MIN_MAJOR = 2
const MIN_MINOR = 83

interface ListedFile {
  name: string
  mtime: number
  size: number
}

/** Folder names like "Blender3.6" from the release root directory listing. */
export function parseReleaseFolders(html: string): string[] {
  const folders: string[] = []
  for (const match of html.matchAll(/<a href="(Blender(\d+)\.(\d+))\/">/g)) {
    const major = Number(match[2])
    const minor = Number(match[3])
    if (major > MIN_MAJOR || (major === MIN_MAJOR && minor >= MIN_MINOR)) folders.push(match[1])
  }
  return folders
}

function parseListedFiles(html: string): ListedFile[] {
  const files: ListedFile[] = []
  for (const match of html.matchAll(
    /<a href="([^"?/]+)">[^<]*<\/a>\s+(\d{2}-\w{3}-\d{4} \d{2}:\d{2})\s+(\d+)/g
  )) {
    const parsedDate = Date.parse(match[2].replace(/-/g, ' '))
    files.push({
      name: match[1],
      mtime: Number.isFinite(parsedDate) ? Math.floor(parsedDate / 1000) : 0,
      size: Number(match[3])
    })
  }
  return files
}

// Covers naming across the years: blender-2.83.9-windows64.zip,
// blender-2.93.18-linux-x64.tar.xz, blender-3.6.9-windows-x64.zip,
// blender-4.1.1-macos-arm64.dmg
const FILE_PATTERN = /^blender-(\d+\.\d+\.\d+)-(windows|linux|macos)[-.]?(x64|arm64|64)?\.(zip|tar\.xz|dmg)$/i

export function parseArchiveFolderBuilds(
  folderName: string,
  folderUrl: string,
  html: string,
  platform: string,
  architectures: string[]
): RemoteBuild[] {
  const wantedExtension = PREFERRED_EXTENSION[platform]
  const builds: RemoteBuild[] = []
  for (const file of parseListedFiles(html)) {
    const match = FILE_PATTERN.exec(file.name)
    if (!match) continue
    const [, version, rawPlatform, rawArch, rawExtension] = match
    const filePlatform = rawPlatform.toLowerCase() === 'macos' ? 'darwin' : rawPlatform.toLowerCase()
    const fileArch = rawArch?.toLowerCase() === 'arm64' ? 'arm64' : 'amd64'
    const extension = rawExtension.toLowerCase() === 'tar.xz' ? 'xz' : rawExtension.toLowerCase()
    if (filePlatform !== platform || extension !== wantedExtension) continue
    if (!architectures.includes(fileArch) && !(fileArch === 'amd64' && architectures.includes('x86_64'))) continue
    builds.push({
      id: file.name,
      source: 'archive',
      version,
      branch: 'v' + folderName.replace('Blender', '').replace('.', ''),
      commit: '',
      releaseCycle: 'stable',
      fileName: file.name,
      fileSize: file.size,
      fileMtime: file.mtime,
      url: folderUrl + file.name,
      sha256: null,
      checksumUrl: `${folderUrl}blender-${version}.sha256`
    })
  }
  return builds
}

export function minorOf(version: string): string {
  return version.split('.').slice(0, 2).join('.')
}
