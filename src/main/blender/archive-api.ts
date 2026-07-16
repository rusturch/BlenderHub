import { latestPatchPerMinor, parseArchiveFolderBuilds, parseReleaseFolders } from '../../shared/blender-archive'
import type { RemoteBuild } from '../../shared/types'
import { getCurrentTarget } from './target'

const RELEASE_ROOT = 'https://download.blender.org/release/'

export async function fetchArchiveBuilds(): Promise<RemoteBuild[]> {
  const rootResponse = await fetch(RELEASE_ROOT)
  if (!rootResponse.ok) throw new Error(`download.blender.org responded with HTTP ${rootResponse.status}`)
  const folders = parseReleaseFolders(await rootResponse.text())
  const { platform, architectures } = getCurrentTarget()

  const perFolder = await Promise.all(
    folders.map(async (folder) => {
      try {
        const folderUrl = `${RELEASE_ROOT}${folder}/`
        const response = await fetch(folderUrl)
        if (!response.ok) return []
        return parseArchiveFolderBuilds(folder, folderUrl, await response.text(), platform, architectures)
      } catch {
        return []
      }
    })
  )

  return latestPatchPerMinor(perFolder.flat())
}
