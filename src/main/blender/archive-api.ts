import { parseArchiveFolderBuilds, parseReleaseFolders } from '../../shared/blender-archive'
import type { RemoteBuild } from '../../shared/types'
import { getCurrentTarget } from './target'
import { httpGet } from '../http'

const RELEASE_ROOT = 'https://download.blender.org/release/'

export async function fetchArchiveBuilds(): Promise<RemoteBuild[]> {
  const rootResponse = await httpGet(RELEASE_ROOT, 'download.blender.org')
  if (!rootResponse.ok) throw new Error(`download.blender.org responded with HTTP ${rootResponse.status}`)
  const folders = parseReleaseFolders(await rootResponse.text())
  const { platform, architectures } = getCurrentTarget()

  const perFolder = await Promise.all(
    folders.map(async (folder) => {
      try {
        const folderUrl = `${RELEASE_ROOT}${folder}/`
        const response = await httpGet(folderUrl, 'download.blender.org')
        if (!response.ok) return []
        return parseArchiveFolderBuilds(folder, folderUrl, await response.text(), platform, architectures)
      } catch {
        return []
      }
    })
  )

  // every patch stays: the newest of a minor is the visible series row, the rest
  // feed the "Other versions" drawer (the renderer decides, not the fetch)
  return perFolder.flat()
}
