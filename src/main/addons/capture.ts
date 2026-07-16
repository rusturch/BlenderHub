import { backupInstalledAddon } from './backup'
import { listLibrary } from './library'
import { listInstalled } from '../blender/installs'
import { representativesByMinor } from './scan'
import { minorOf } from '../../shared/blender-archive'
import type { CaptureInstalledResult, VersionAddons } from '../../shared/types'

// Copy installed add-ons into the Library so they survive wiping Blender and can be reinstalled
// into other versions / carried to other devices. This is the file-transfer foundation for sync.
// We store everything NOT built into Blender EXCEPT blender.org extensions — those are public and
// trivially re-downloadable, so keeping their files would only waste space. Everything else (legacy
// user add-ons, side-loaded extensions, Superhive purchases in user_default) can be hard or
// impossible to get back, so we keep a copy. Dedup is by (identity, add-on version) up front, and
// by sha256 inside addToLibrary as a second guard, so re-running is cheap and never duplicates.
const shouldCapture = (addon: { origin: string; repoModule?: string | null; missing?: boolean }): boolean => {
  if (addon.missing) return false
  if (addon.origin === 'user') return true
  if (addon.origin === 'extension') return addon.repoModule !== 'blender_org'
  return false // bundled / core ship with Blender
}

export async function captureInstalledToLibrary(
  cache: VersionAddons[] | null
): Promise<CaptureInstalledResult> {
  if (!cache) throw new Error('Scan the versions first')
  const existing = await listLibrary()
  const have = new Set(existing.map((entry) => `${entry.moduleId}@@${entry.version ?? ''}`))
  const builds = new Map(
    representativesByMinor(await listInstalled()).map((build) => [minorOf(build.version), build])
  )

  const failed: CaptureInstalledResult['failed'] = []
  let added = 0
  let skipped = 0
  const done = new Set<string>() // identity@@version already handled this run

  for (const version of cache) {
    const build = builds.get(version.minor)
    if (!build) continue
    for (const addon of version.addons) {
      if (!shouldCapture(addon)) continue
      // the library stores an extension under its pkgId (manifest id), legacy under its module
      const idKey = addon.origin === 'extension' ? addon.pkgId ?? addon.module : addon.module
      const key = `${idKey}@@${addon.version ?? ''}`
      if (done.has(key)) continue
      done.add(key)
      if (have.has(key)) {
        skipped++
        continue
      }
      try {
        // an identical file already stored (sha256 match) is a skip, not a failure
        const { existed } = await backupInstalledAddon(build, version.minor, addon)
        if (existed) skipped++
        else added++
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        failed.push({ module: addon.module, minor: version.minor, error: message })
      }
    }
  }
  return { added, skipped, failed }
}
