import { compareVersionsDesc, mapBuilderEntries } from '../../shared/blender-builds'
import type { BuilderApiEntry } from '../../shared/blender-builds'
import { minorOf } from '../../shared/blender-archive'
import type { RemoteBuild } from '../../shared/types'
import { fetchArchiveBuilds } from './archive-api'
import { getCurrentTarget } from './target'

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
  const response = await fetch(`${BUILDER_API_BASE}${category}/?format=json&v=2`, {
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

  // the daily feed already carries the freshest build of the active series —
  // archive entries for those minors would only duplicate them one patch behind
  const dailyMinors = new Set(daily.map((build) => minorOf(build.version)))
  const archiveOnly = archive.filter((build) => !dailyMinors.has(minorOf(build.version)))

  const merged = [...daily, ...experimental, ...patch, ...archiveOnly].sort(
    (a, b) => compareVersionsDesc(a.version, b.version) || b.fileMtime - a.fileMtime
  )
  console.log(
    `[builds] merged list: ${merged.length} (daily ${daily.length}, experimental ${experimental.length}, patch ${patch.length}, archive ${archiveOnly.length})`
  )
  return merged
}
