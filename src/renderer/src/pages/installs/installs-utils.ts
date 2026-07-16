import { buildNotesUrl } from '../../lib/blender-links'
import { STABLE_CYCLES } from '../../../../shared/blender-builds'
import type { BuildsApi, InstalledBuild } from '../../../../shared/types'
import type { DisplayRow } from './types'

// Same-build identity among INSTALLED copies that the remote catalog no longer lists
// (an old archive patch, an unusual Located version): stable/lts/candidate/rc are one
// per version; rolling cycles additionally need branch+commit — mirrors isSameBuild.
export function installedIdentityKey(build: {
  version: string
  releaseCycle: string
  branch?: string
  commit?: string
}): string {
  if (STABLE_CYCLES.has(build.releaseCycle)) return `${build.version}|${build.releaseCycle}`
  return `${build.version}|${build.releaseCycle}|${build.branch ?? ''}|${build.commit ?? ''}`
}
export interface LocateOutcome {
  /** freshly registered builds, duplicates already dropped */
  added: InstalledBuild[]
  /** located copies unlisted right back: their identity already exists at another path */
  skippedDuplicates: InstalledBuild[]
}

/**
 * builds.locate() plus the duplicate guard: a version already installed elsewhere must
 * not be added a second time. Locate registers everything it finds, so any freshly-added
 * copy whose identity already exists at a different path is unlisted again (files
 * untouched). Returns null when the folder dialog was cancelled. Used by the Installs
 * page and the Sync version-header menu — the guard must stay identical in both.
 */
export async function locateWithDedup(
  buildsApi: BuildsApi,
  before: InstalledBuild[]
): Promise<LocateOutcome | null> {
  const added = await buildsApi.locate()
  if (!added) return null
  const existingByIdentity = new Map<string, InstalledBuild>()
  for (const build of before) {
    const key = installedIdentityKey(build)
    if (!existingByIdentity.has(key)) existingByIdentity.set(key, build)
  }
  const skippedDuplicates = added.filter((build) => {
    const existing = existingByIdentity.get(installedIdentityKey(build))
    return existing !== undefined && existing.path !== build.path
  })
  for (const dupe of skippedDuplicates) {
    await buildsApi.uninstall(dupe.id).catch(() => undefined)
  }
  const skipped = new Set(skippedDuplicates)
  return { added: added.filter((build) => !skipped.has(build)), skippedDuplicates }
}

// installed-only ("orphan") rows have no RemoteBuild to hand buildNotesUrl, but the
// docs page only ever keys off major.minor — build the same link from the row itself
// (a PR link is impossible here: we no longer know if an orphan came from 'patch')
export function notesUrlForRow(row: DisplayRow): string | null {
  if (row.remoteBuild) return buildNotesUrl(row.remoteBuild)
  const [major, minor] = row.version.split('.')
  if (!major || minor === undefined) return null
  return `https://developer.blender.org/docs/release_notes/${major}.${minor}/`
}

// best-known release date for the row, in ms — the catalog build's file date when we
// have one, else its superseding update's, else (an orphan the catalog no longer
// lists) when the launcher itself installed the copy, as the closest approximation
export function releaseDateOfRow(row: DisplayRow): number {
  if (row.remoteBuild && row.remoteBuild.fileMtime > 0) return row.remoteBuild.fileMtime * 1000
  if (row.update && row.update.fileMtime > 0) return row.update.fileMtime * 1000
  if (row.copy) return new Date(row.copy.installedAt).getTime()
  return 0
}
