import type { InstalledBuild, RemoteBuild } from './types'

export interface BuilderApiEntry {
  url: string
  app: string
  version: string
  branch: string
  hash: string
  platform: string
  architecture: string
  file_name: string
  file_size: number
  file_mtime: number
  file_extension: string
  release_cycle: string
  checksum: string | null
}

export const PREFERRED_EXTENSION: Record<string, string> = {
  windows: 'zip',
  darwin: 'dmg',
  linux: 'xz'
}

export const STABLE_CYCLES = new Set(['stable', 'lts', 'candidate', 'rc'])

// 'lts' is a stable release with a longer support window and 'rc' is a synonym of
// 'candidate' (the buildbot has used both) — one class each wherever cycles are
// compared for identity or supersede direction.
export const cycleClass = (cycle: string): string =>
  cycle === 'lts' ? 'stable' : cycle === 'rc' ? 'candidate' : cycle

/** Released to users (stable/lts), as opposed to a candidate/rc preview of the next patch. */
export const isReleasedCycle = (cycle: string): boolean => cycleClass(cycle) === 'stable'

// Daily/experimental/patch cycles get replaced by a new commit on the same branch
// constantly — builder.blender.org only ever lists the latest one. "Rolling" builds
// are auto-updated in place; stable/lts/candidate/rc are one-per-version (isSameBuild
// dedups them by version+cycle alone) and only retire on a higher patch of their minor.
export const isRollingCycle = (cycle: string): boolean => !STABLE_CYCLES.has(cycle)

// Recognizes a manually located install as "the same build" as a catalog entry.
// Stable/LTS/candidate/RC releases are one-per-version, so version + cycle is
// enough. Daily/experimental/patch builds move constantly under the same
// version number, so those additionally require an exact branch + commit match.
export function isSameBuild(installed: InstalledBuild, remote: RemoteBuild): boolean {
  if (installed.version !== remote.version) return false
  if (cycleClass(installed.releaseCycle) !== cycleClass(remote.releaseCycle)) return false
  if (STABLE_CYCLES.has(remote.releaseCycle)) return true
  return (
    Boolean(installed.branch) &&
    installed.branch === remote.branch &&
    Boolean(installed.commit) &&
    installed.commit === remote.commit
  )
}

// A catalog build that supersedes an installed copy of the same line, i.e. the
// pair the UI shows as one row with an Update button. Rolling builds: same branch —
// the catalog only ever lists a branch's newest commit, so a differing commit means
// a newer one. Stable cycles: a higher version within the same minor (patch release),
// or the released build of the exact version an installed candidate previewed.
// Direction matters: a candidate/rc never supersedes a released copy — it keeps its
// own Install row so stable users are never nudged onto a pre-release.
// PR/experimental-branch builds are their own lines and never update anything.
export function isUpdateFor(remote: RemoteBuild, installed: InstalledBuild): boolean {
  if (remote.source === 'patch' || remote.source === 'experimental') return false
  if (installed.remoteId === remote.id || isSameBuild(installed, remote)) return false
  if (!isReleasedCycle(remote.releaseCycle) && isReleasedCycle(installed.releaseCycle)) return false
  if (installed.branch && installed.commit && remote.branch && remote.commit) {
    return installed.branch === remote.branch
  }
  const minor = (version: string): string => version.split('.').slice(0, 2).join('.')
  if (!STABLE_CYCLES.has(remote.releaseCycle) || !STABLE_CYCLES.has(installed.releaseCycle)) return false
  if (minor(remote.version) !== minor(installed.version)) return false
  const cmp = compareVersionsDesc(remote.version, installed.version)
  return cmp < 0 || (cmp === 0 && isReleasedCycle(remote.releaseCycle) && !isReleasedCycle(installed.releaseCycle))
}

// The "native install" for a project file: among installed builds matching the
// file's Blender version (major.minor), a released copy wins over a side-by-side
// candidate/rc, newest first — an RC installed for testing must never silently
// capture project launches. Expects builds sorted newest-first; callers keep
// their own fallback for when nothing matches.
export function pickNativeInstall<T extends { version: string; releaseCycle: string }>(
  builds: T[],
  fileVersion: string | null | undefined
): T | null {
  if (!fileVersion) return null
  const matches = builds.filter(
    (build) => build.version === fileVersion || build.version.startsWith(`${fileVersion}.`)
  )
  return matches.find((build) => isReleasedCycle(build.releaseCycle)) ?? matches[0] ?? null
}

export function compareVersionsDesc(a: string, b: string): number {
  const partsA = a.split('.').map(Number)
  const partsB = b.split('.').map(Number)
  for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
    const diff = (partsB[i] ?? 0) - (partsA[i] ?? 0)
    if (diff !== 0) return diff
  }
  return 0
}

export function mapBuilderEntries(
  entries: BuilderApiEntry[],
  platform: string,
  architectures: string[],
  source: RemoteBuild['source'] = 'daily'
): RemoteBuild[] {
  const extension = PREFERRED_EXTENSION[platform]
  const matching = entries.filter(
    (entry) =>
      entry.platform === platform &&
      architectures.includes(entry.architecture) &&
      entry.file_extension === extension
  )

  const newestPerVariant = new Map<string, BuilderApiEntry>()
  for (const entry of matching) {
    const key = `${entry.version}|${entry.release_cycle}|${entry.branch}`
    const known = newestPerVariant.get(key)
    if (!known || entry.file_mtime > known.file_mtime) newestPerVariant.set(key, entry)
  }

  return [...newestPerVariant.values()]
    .sort((a, b) => compareVersionsDesc(a.version, b.version) || b.file_mtime - a.file_mtime)
    .map((entry) => ({
      id: entry.file_name,
      source,
      version: entry.version,
      branch: entry.branch,
      commit: entry.hash,
      releaseCycle: entry.release_cycle,
      fileName: entry.file_name,
      fileSize: entry.file_size,
      fileMtime: entry.file_mtime,
      url: entry.url,
      sha256: entry.checksum ? entry.checksum.toLowerCase() : null
    }))
}
