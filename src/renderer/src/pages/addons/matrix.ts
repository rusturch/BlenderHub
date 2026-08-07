import {
  numericVersion,
  removedBundledInfo,
  type AddonGroupRow,
  type AddonSource
} from '../../../../shared/addon-identity'

export { numericVersion }
import { compareVersionsDesc } from '../../../../shared/blender-builds'
import type { AddonInfo, ExtensionCatalogItem, LibraryAddon } from '../../../../shared/types'
import type { InstallSource, MatrixRow, MatrixUnit } from './types'

// NUL can never appear in a module/group id (folder names with spaces can!), so it is
// the one safe separator; kept as an escape — a raw NUL byte in source makes grep treat
// the file as binary
// NUL separator: module/groupId can carry spaces (legacy add-ons named with spaces), so a
// space would split them apart — a control char never appears in either half.
export const PENDING_SEP = '\x00'
export const pendingKey = (minor: string, module: string): string => `${minor}${PENDING_SEP}${module}`
export const installKey = (minor: string, groupId: string): string => `${minor}${PENDING_SEP}${groupId}`

// mirror of main's module validation — modules that fail it cannot be sent to apply. A module
// is a Blender module OR a folder/file name (legacy single-file add-ons carry spaces here), so
// we reject only path-dangerous / malformed forms, not identifier-illegal characters.
export const moduleOk = (module: string): boolean =>
  module.length >= 1 &&
  module.length <= 200 &&
  !module.includes('/') &&
  !module.includes('\\') &&
  !module.includes('..') &&
  !/[\x00-\x1f]/.test(module)

// the source to install a specific VERSION unit into `minor` — the newest version may use the row's
// version-correct repo build; any version can use its stored file or a carried installed copy.
export function unitSourceFor(row: MatrixRow, unit: MatrixUnit, minor: string, isNewest: boolean): InstallSource | null {
  const candidates: InstallSource[] = []
  if (isNewest && (row.installVia?.kind === 'superhive' || row.installVia?.kind === 'blender_org')) {
    candidates.push(row.installVia)
  }
  if (unit.libEntry) candidates.push(librarySource(unit.libEntry))
  for (const [srcMinor, addon] of unit.removable) {
    if (srcMinor === minor) continue
    candidates.push({
      kind: 'backup',
      id: `${addon.module}@${srcMinor}`,
      module: addon.module,
      sourceMinor: srcMinor,
      minBlender: null,
      maxBlender: null,
      isExtension: addon.origin === 'extension'
    })
  }
  const valid = candidates.filter((candidate) => !installBlocker(candidate, minor))
  if (valid.length === 0) return null
  valid.sort(
    (a, b) =>
      SOURCE_RANK[a.kind] - SOURCE_RANK[b.kind] ||
      Number(supportUnclear(a, minor)) - Number(supportUnclear(b, minor))
  )
  return valid[0]
}

const collapseName = (value: string): string => value.trim().replace(/\s+/g, ' ').toLowerCase()

/** cell checkboxes install source for one stored library file */
export function librarySource(entry: LibraryAddon): InstallSource {
  return {
    kind: 'library',
    id: entry.id,
    minBlender: entry.minBlender,
    maxBlender: entry.maxBlender ?? null,
    isExtension: entry.format === 'extension',
    version: entry.version
  }
}

/** two install sources point at the same thing (for the mutually-exclusive per-column pick) */
export function sameSource(a: InstallSource | undefined, b: InstallSource): boolean {
  return Boolean(a) && a!.kind === b.kind && a!.id === b.id
}

/** why this add-on cannot be installed into that minor, or null when it can */
export function installBlocker(src: InstallSource, minor: string): string | null {
  if (src.isExtension && compareVersionsDesc(minor, '4.2') > 0) return 'Extensions require Blender 4.2+'
  // A catalog listing is queried for ONE Blender version (the newest installed one), and it
  // answers with the newest release compatible with it — so those bounds describe that release,
  // not the package. Older Blenders are served an older release of the same package, which is
  // exactly what main re-queries per target version on Apply; gating other columns by the bounds
  // we happen to hold would hide installs that the repo does offer.
  if (src.kind === 'blender_org' || src.kind === 'superhive') return null
  if (src.minBlender) {
    const minMinor = src.minBlender.split('.').slice(0, 2).join('.')
    if (compareVersionsDesc(minor, minMinor) > 0) return `Requires Blender ${src.minBlender}+`
  }
  if (src.maxBlender && compareVersionsDesc(minor, src.maxBlender) <= 0) {
    return `Too new — supports below ${src.maxBlender}`
  }
  return null
}

/**
 * The install is allowed, but nothing DECLARES the add-on works there: legacy bl_info has no
 * upper bound, so a 2.80-era add-on installs into 5.x silently. Flag installs that cross a
 * MAJOR Blender boundary above the declared minimum (or the version the copy comes from).
 * blender.org/Superhive never qualify — their listings are queried per exact Blender version,
 * so the server only ever offers a build it considers compatible.
 */
export function supportUnclear(src: InstallSource, minor: string): boolean {
  if (src.kind === 'blender_org' || src.kind === 'superhive') return false
  if (src.maxBlender) return false // an upper bound is declared — installBlocker already gates it
  const baseline = src.minBlender ?? (src.kind === 'backup' ? (src.sourceMinor ?? null) : null)
  if (!baseline) return true // the add-on declares nothing at all
  return Number(minor.split('.')[0] ?? 0) > Number(baseline.split('.')[0] ?? 0)
}

// lower = preferred: a version-correct repo build beats a stored copy beats a re-pack
const SOURCE_RANK: Record<InstallSource['kind'], number> = { superhive: 0, blender_org: 1, library: 2, backup: 3 }

// pick the BEST install source for one Blender version among everything the row can offer — its
// primary source (Superhive/blender.org/backup) AND every stored Library file. This is what lets
// a single row install a version-correct extension into 4.2+ AND a legacy copy into 3.6, instead
// of one source dead-ending below 4.2.
export function installSourceFor(row: MatrixRow, minor: string): InstallSource | null {
  const candidates: InstallSource[] = []
  if (row.installVia) candidates.push(row.installVia)
  for (const file of row.libraryFiles ?? []) candidates.push(librarySource(file))
  // last resort: carry an installed copy from another version (repack on Apply) — lets a legacy
  // copy reach where the primary (e.g. Superhive extension) can't, even with nothing stored yet
  for (const [srcMinor, addon] of row.perMinor) {
    if (srcMinor === minor || addon.missing) continue
    if (addon.origin !== 'user' && addon.origin !== 'extension') continue
    candidates.push({
      kind: 'backup',
      id: `${addon.module}@${srcMinor}`,
      module: addon.module,
      sourceMinor: srcMinor,
      minBlender: null,
      maxBlender: null,
      isExtension: addon.origin === 'extension'
    })
  }
  const valid = candidates.filter((candidate) => !installBlocker(candidate, minor))
  if (valid.length === 0) return null
  valid.sort(
    (a, b) =>
      SOURCE_RANK[a.kind] - SOURCE_RANK[b.kind] ||
      Number(supportUnclear(a, minor)) - Number(supportUnclear(b, minor))
  )
  return valid[0]
}

function virtualRow(
  canonicalId: string,
  name: string,
  sources: Set<AddonSource>,
  installVia: InstallSource,
  /** catalog rows are not installed, so nothing was scanned — pass the repo page when known */
  website: string | null = null
): MatrixRow {
  return {
    groupId: canonicalId,
    canonicalId,
    name,
    category: '',
    description: null,
    website,
    origins: new Set(),
    manual: true,
    sources,
    matchTier: 'exact',
    perMinor: new Map(),
    enabledAnywhere: false,
    members: [],
    installVia
  }
}

// Fold rows that are the SAME self-installed product but split across identities — a legacy
// module in old Blender vs. an extension in new, and/or a Superhive purchase from the catalog —
// into one row. The match is by exact display name (a guess → flagged with ~), and only when the
// rows occupy DISJOINT Blender versions: an overlap means two different things live in one
// version, so those are never merged. Built-in / blender.org rows are left untouched — their
// identity is trustworthy and must not be name-merged.
function consolidateByName(rows: MatrixRow[]): MatrixRow[] {
  const mergeable = (r: MatrixRow): boolean =>
    r.sources.size > 0 && [...r.sources].every((s) => s === 'user' || s === 'superhive')
  const groups = new Map<string, MatrixRow[]>()
  for (const row of rows) {
    if (!mergeable(row)) continue
    const key = collapseName(row.name)
    if (key) groups.set(key, [...(groups.get(key) ?? []), row])
  }

  const absorbed = new Set<MatrixRow>()
  for (const group of groups.values()) {
    if (group.length < 2) continue
    // nothing installed to anchor to (e.g. two same-named catalog-only rows) — leave them apart
    if (group.every((row) => row.perMinor.size === 0)) continue
    // bail on the whole group if any two rows share a Blender version (genuine ambiguity)
    const seen = new Set<string>()
    let disjoint = true
    for (const row of group) {
      for (const minor of row.perMinor.keys()) {
        if (seen.has(minor)) disjoint = false
        seen.add(minor)
      }
    }
    if (!disjoint) continue

    // anchor = the installed row with the most cells → keeps a stable, real canonical id
    const anchor = [...group].sort((a, b) => b.perMinor.size - a.perMinor.size)[0]
    for (const row of group) {
      if (row === anchor) continue
      for (const [minor, addon] of row.perMinor) anchor.perMinor.set(minor, addon)
      for (const origin of row.origins) anchor.origins.add(origin)
      for (const source of row.sources) anchor.sources.add(source)
      anchor.members = [...anchor.members, ...row.members]
      anchor.enabledAnywhere = anchor.enabledAnywhere || row.enabledAnywhere
      if (row.libraryFiles) anchor.libraryFiles = [...(anchor.libraryFiles ?? []), ...row.libraryFiles]
      // a Superhive source is the canonical install source for empty cells; else fill if unset
      if (row.installVia?.kind === 'superhive') anchor.installVia = row.installVia
      else if (!anchor.installVia) anchor.installVia = row.installVia
      if (!anchor.description && row.description) anchor.description = row.description
      absorbed.add(row)
    }
  }
  return rows.filter((row) => !absorbed.has(row))
}

// Merge the scanned add-ons with the Superhive catalog, the public extensions.blender.org
// catalog and the launcher's library into one row list. Installed add-ons come from the
// scan; items available but not installed anywhere become virtual rows; either way, a row
// that has an install source shows install checkboxes in the versions where it is absent.
export function buildMatrix(
  scanned: AddonGroupRow[],
  superhiveCatalog: ExtensionCatalogItem[],
  blenderOrgCatalog: ExtensionCatalogItem[],
  library: LibraryAddon[],
  superhivePkgIds: ReadonlySet<string>
): MatrixRow[] {
  const rows: MatrixRow[] = scanned.map((row) => ({ ...row }))
  const byPkgId = new Map<string, MatrixRow>()
  const byModule = new Map<string, MatrixRow>()
  for (const row of rows) {
    if (row.canonicalId.startsWith('ext:')) byPkgId.set(row.canonicalId.slice(4).split('@')[0], row)
    if (row.canonicalId.startsWith('mod:')) byModule.set(row.canonicalId.slice(4), row)
    for (const member of row.members) byModule.set(member.module, row)
  }

  for (const item of superhiveCatalog) {
    const src: InstallSource = {
      kind: 'superhive',
      id: item.pkgId,
      minBlender: item.minBlender,
      maxBlender: item.maxBlender,
      isExtension: true,
      version: item.version
    }
    const existing = byPkgId.get(item.pkgId)
    if (existing) {
      existing.installVia = src
      existing.sources.add('superhive')
      // the store page describes the add-on the user actually got from there; the
      // manifest's own `website` may point anywhere (a personal site, a git repo)
      if (item.website) existing.website = item.website
    } else {
      const row = virtualRow(`ext:${item.pkgId}`, item.name, new Set(['superhive']), src, item.website)
      rows.push(row)
      byPkgId.set(item.pkgId, row)
    }
  }

  // public blender.org listing — lower priority than a Superhive purchase of the same
  // pkgId (SOURCE_RANK), so it never overrides an installVia the loop above just set
  for (const item of blenderOrgCatalog) {
    const src: InstallSource = {
      kind: 'blender_org',
      id: item.pkgId,
      minBlender: item.minBlender,
      maxBlender: item.maxBlender,
      isExtension: true,
      version: item.version
    }
    const existing = byPkgId.get(item.pkgId)
    if (existing) {
      if (existing.installVia?.kind !== 'superhive') existing.installVia = src
      existing.sources.add('blender_org')
      if (item.website && existing.installVia?.kind !== 'superhive') existing.website = item.website
    } else {
      const row = virtualRow(`ext:${item.pkgId}`, item.name, new Set(['blender_org']), src, item.website)
      rows.push(row)
      byPkgId.set(item.pkgId, row)
    }
  }

  for (const entry of library) {
    const isExt = entry.format === 'extension'
    const src = librarySource(entry)
    const existing = isExt ? byPkgId.get(entry.moduleId) : byModule.get(entry.moduleId)
    if (existing) {
      existing.libraryFiles = [...(existing.libraryFiles ?? []), entry]
      if (!existing.installVia) existing.installVia = src // a Superhive source, if any, wins
    } else {
      const isPurchase = superhivePkgIds.has(entry.moduleId)
      const canonical = isExt ? `ext:${entry.moduleId}` : `mod:${entry.moduleId}`
      const row = virtualRow(canonical, entry.name, new Set([isPurchase ? 'superhive' : 'user']), src)
      row.libraryFiles = [entry]
      rows.push(row)
      // index it so a second library file with the same module folds in, not duplicates
      if (isExt) byPkgId.set(entry.moduleId, row)
      else byModule.set(entry.moduleId, row)
    }
  }

  // several stored versions of one add-on: newest first — the newest one drives the
  // collapsed row's checkboxes, the others are reachable from the expanded version list
  for (const row of rows) {
    const files = row.libraryFiles
    if (!files || files.length < 2) continue
    files.sort((a, b) => {
      const va = numericVersion(a.version)
      const vb = numericVersion(b.version)
      if (va && vb) return compareVersionsDesc(va, vb)
      if (Boolean(va) !== Boolean(vb)) return va ? -1 : 1 // versioned entries above unversioned
      return b.addedAt.localeCompare(a.addedAt)
    })
    if (row.installVia?.kind === 'library') row.installVia = librarySource(files[0])
  }

  // give scanned rows a per-version install source where none came from library/superhive:
  //  - blender.org add-ons: install the version-correct release (same engine as the ⤓ button)
  //  - dropped built-ins: carry the user's old bundled copy forward (implicit save + install)
  //  - the user's own add-ons (legacy or local extensions): same carry — ticking an empty
  //    cell backs the installed copy up into the library on Apply, then installs it
  for (const row of rows) {
    if (row.installVia) continue
    const removed = removedBundledInfo(row.canonicalId)
    if (removed) {
      let sourceMinor: string | null = null
      for (const [minor, addon] of row.perMinor) {
        if (addon.origin !== 'bundled') continue
        if (!sourceMinor || compareVersionsDesc(minor, sourceMinor) < 0) sourceMinor = minor
      }
      if (sourceMinor) {
        const module = row.canonicalId.slice('mod:'.length)
        row.installVia = {
          kind: 'backup',
          id: `${module}@${sourceMinor}`,
          module,
          sourceMinor,
          minBlender: null,
          maxBlender: null,
          isExtension: false,
          unsupported: true
        }
      }
    } else if (row.sources.has('blender_org')) {
      // keyed by the extension package id, like every other blender.org source above — a
      // quarantined custom-repo id (ext:<pkg>@<repo>) is not an official package, so it gets none
      const pkgId = row.canonicalId.startsWith('ext:') ? row.canonicalId.slice('ext:'.length) : null
      if (pkgId && !pkgId.includes('@')) {
        row.installVia = {
          kind: 'blender_org',
          id: pkgId,
          minBlender: null,
          maxBlender: null,
          isExtension: true
        }
      }
    } else {
      // default source = the cell carrying the newest add-on version; when versions are
      // missing or equal, the newest Blender wins (the "…" menu still allows an explicit pick)
      let best: { minor: string; addon: AddonInfo } | null = null
      for (const [minor, addon] of row.perMinor) {
        if (addon.missing) continue
        if (addon.origin !== 'user' && addon.origin !== 'extension') continue
        if (!best) {
          best = { minor, addon }
          continue
        }
        const nv = numericVersion(addon.version)
        const bv = numericVersion(best.addon.version)
        const byAddonVersion = nv && bv ? compareVersionsDesc(nv, bv) : 0
        if (byAddonVersion < 0 || (byAddonVersion === 0 && compareVersionsDesc(minor, best.minor) < 0)) {
          best = { minor, addon }
        }
      }
      if (best) {
        row.installVia = {
          kind: 'backup',
          id: `${best.addon.module}@${best.minor}`,
          module: best.addon.module,
          sourceMinor: best.minor,
          minBlender: null,
          maxBlender: null,
          isExtension: best.addon.origin === 'extension'
        }
      }
    }
  }

  // last: fold same-name self-installed rows (legacy↔extension, and Superhive purchases) into one
  return consolidateByName(rows).sort(
    (a, b) => Number(b.enabledAnywhere) - Number(a.enabledAnywhere) || a.name.localeCompare(b.name)
  )
}
