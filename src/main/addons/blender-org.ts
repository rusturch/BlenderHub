import { listInstalled } from '../blender/installs'
import { representativesByMinor } from './scan'
import { BLENDER_ORG_HOST, fetchRepoListing } from './extensions-api'
import { minorOf } from '../../shared/blender-archive'
import { compareVersionsDesc } from '../../shared/blender-builds'
import type { ExtensionCatalogItem, InstalledBuild } from '../../shared/types'

// extensions.blender.org is public — no token needed, unlike Superhive. The listing is
// still per-Blender-version, so we query it against the newest installed 4.2+ (the
// extensions system's minimum) the same way listSuperhiveCatalog does.
const EXTENSIONS_SINCE = '4.2'

const atLeast = (version: string, base: string): boolean => compareVersionsDesc(version, base) <= 0

const fullVersionOf = (build: InstalledBuild): string =>
  /^\d+\.\d+\.\d+/.exec(build.version)?.[0] ?? `${minorOf(build.version)}.0`

async function catalogQueryBuild(): Promise<InstalledBuild | null> {
  const compatible = representativesByMinor(await listInstalled())
    .filter((build) => atLeast(minorOf(build.version), EXTENSIONS_SINCE))
    .sort((a, b) => compareVersionsDesc(a.version, b.version))
  return compatible[0] ?? null
}

export async function listBlenderOrgCatalog(): Promise<ExtensionCatalogItem[]> {
  const build = await catalogQueryBuild()
  if (!build) throw new Error('Install Blender 4.2+ to browse extensions.blender.org')
  const byId = await fetchRepoListing(BLENDER_ORG_HOST, fullVersionOf(build), { label: 'extensions.blender.org' })
  return [...byId.values()]
    .map((release) => ({
      pkgId: release.pkgId,
      name: release.name,
      version: release.version,
      minBlender: release.blenderVersionMin,
      maxBlender: release.blenderVersionMax
    }))
    .sort((a, b) => a.name.localeCompare(b.name))
}
