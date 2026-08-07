import { fetchAllBuilds } from './builds-api'
import type { RemoteBuild } from '../../shared/types'

// The remote catalog cache, shared by the Installs IPC surface and the background
// notification checks. Also the security anchor: builds:install resolves ids against
// this list, so download URLs never cross IPC.

let remoteCache: { fetchedAt: number; builds: RemoteBuild[] } | null = null
const REMOTE_CACHE_TTL_MS = 10 * 60 * 1000

export async function refreshRemoteBuilds(): Promise<RemoteBuild[]> {
  const builds = await fetchAllBuilds()
  remoteCache = { fetchedAt: Date.now(), builds }
  return builds
}

export async function getRemoteBuilds(refresh = false): Promise<RemoteBuild[]> {
  const cached = remoteCache
  if (!cached || refresh || Date.now() - cached.fetchedAt > REMOTE_CACHE_TTL_MS) {
    return refreshRemoteBuilds()
  }
  return cached.builds
}

export function findCachedRemoteBuild(buildId: string): RemoteBuild | undefined {
  return remoteCache?.builds.find((candidate) => candidate.id === buildId)
}
