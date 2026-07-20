import { compareVersionsDesc, isReleasedCycle, mapBuilderEntries } from '../../shared/blender-builds'
import type { BuilderApiEntry } from '../../shared/blender-builds'
import type { RemoteBuild } from '../../shared/types'
import { fetchArchiveBuilds } from './archive-api'
import { getCurrentTarget } from './target'
import { httpGet } from '../http'

const BUILDER_API_BASE = 'https://builder.blender.org/download/'

// Application Security Requirement: builds are downloaded only from official
// Blender Foundation hosts over https, and every archive is verified against
// the sha256 checksum published alongside it before extraction.
const TRUSTED_HOSTS = new Set(['builder.blender.org', 'cdn.builder.blender.org', 'download.blender.org'])

export function assertTrustedSource(url: string): void {
  const parsed = new URL(url)
  if (parsed.protocol !== 'https:' || !TRUSTED_HOSTS.has(parsed.hostname)) {
    throw new Error(`Untrusted download source: ${parsed.hostname}`)
  }
}

type BuilderCategory = 'daily' | 'experimental' | 'patch'

async function fetchBuilderCategory(category: BuilderCategory): Promise<RemoteBuild[]> {
  const response = await httpGet(`${BUILDER_API_BASE}${category}/?format=json&v=2`, 'builder.blender.org', {
    headers: { accept: 'application/json' }
  })
  if (!response.ok) throw new Error(`builder.blender.org responded with HTTP ${response.status}`)
  const entries = (await response.json()) as BuilderApiEntry[]
  const { platform, architectures } = getCurrentTarget()
  const source = category === 'daily' ? 'daily' : category === 'patch' ? 'patch' : 'experimental'
  return mapBuilderEntries(entries, platform, architectures, source)
}

export async function fetchAllBuilds(): Promise<RemoteBuild[]> {
  const [dailyResult, experimentalResult, patchResult, archiveResult] = await Promise.allSettled([
    fetchBuilderCategory('daily'),
    fetchBuilderCategory('experimental'),
    fetchBuilderCategory('patch'),
    fetchArchiveBuilds()
  ])
  if (dailyResult.status === 'rejected' && archiveResult.status === 'rejected') {
    throw dailyResult.reason
  }
  const daily = dailyResult.status === 'fulfilled' ? dailyResult.value : []
  const experimental = experimentalResult.status === 'fulfilled' ? experimentalResult.value : []
  const patch = patchResult.status === 'fulfilled' ? patchResult.value : []
  const archive = archiveResult.status === 'fulfilled' ? archiveResult.value : []

  // a daily stable/lts entry is the same release the archive lists — drop only
  // that exact version's archive row (the daily one wins: it carries inline
  // sha256); every other patch stays and feeds the "Other versions" drawer
  const dailyReleasedVersions = new Set(
    daily.filter((build) => isReleasedCycle(build.releaseCycle)).map((build) => build.version)
  )
  const archiveOnly = archive.filter((build) => !dailyReleasedVersions.has(build.version))

  const merged = [...daily, ...experimental, ...patch, ...archiveOnly].sort(
    (a, b) => compareVersionsDesc(a.version, b.version) || b.fileMtime - a.fileMtime
  )
  console.log(
    `[builds] merged list: ${merged.length} (daily ${daily.length}, experimental ${experimental.length}, patch ${patch.length}, archive ${archiveOnly.length})`
  )
  return merged
}
