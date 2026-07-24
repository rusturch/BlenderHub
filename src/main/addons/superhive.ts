import { safeStorage } from 'electron'
import { readConfig, updateConfig } from '../config'
import { listInstalled } from '../blender/installs'
import { representativesByMinor } from './scan'
import { clearListingCache, downloadFromRepo, fetchRepoListing } from './extensions-api'
import { minorOf } from '../../shared/blender-archive'
import { compareVersionsDesc } from '../../shared/blender-builds'
import type { ExtensionCatalogItem, InstalledBuild, SuperhiveStatus } from '../../shared/types'

// Superhive is a token-gated Blender extension repository. Its listing follows the
// standard /api/v1/extensions/ format and authenticates with an Authorization: Bearer
// header (confirmed against Blender's own cli/blender_ext.py). Downloads come from the
// same host and are sha256-verified. Only this host (and its subdomains) is allowlisted.
export const SUPERHIVE_HOST = 'superhivemarket.com'
const SUPERHIVE_ALLOWED_HOSTS = [SUPERHIVE_HOST]
const EXTENSIONS_SINCE = '4.2'

// Superhive connects to Blender as a remote extension repository authenticated by
// a per-user API token. We store that token encrypted with the OS keychain via
// safeStorage — never plaintext — and NEVER hand it back to the renderer; only a
// connected/available status crosses the IPC boundary. The raw token is read only
// inside the main process for the (future) Superhive listing/install calls.

const MAX_TOKEN_LENGTH = 8192

export async function getSuperhiveStatus(): Promise<SuperhiveStatus> {
  const available = safeStorage.isEncryptionAvailable()
  // probe-decrypt instead of "ciphertext exists": safeStorage is machine-bound,
  // so a token carried over in a portable data folder is present but unreadable —
  // report that honestly as "not connected" so the user re-enters it here
  const token = available ? await getSuperhiveToken() : null
  return { connected: token !== null, available }
}

export async function setSuperhiveToken(rawToken: unknown): Promise<SuperhiveStatus> {
  const token = typeof rawToken === 'string' ? rawToken.trim() : ''
  if (!token) throw new Error('Enter your Superhive API token')
  if (token.length > MAX_TOKEN_LENGTH) throw new Error('That does not look like a valid API token')
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('Secure storage is unavailable on this system, so the token cannot be saved safely')
  }
  const encrypted = safeStorage.encryptString(token).toString('base64')
  await updateConfig((config) => ({ ...config, superhiveTokenEnc: encrypted }))
  clearListingCache(SUPERHIVE_HOST) // a new token means a different catalog
  return getSuperhiveStatus()
}

export async function clearSuperhiveToken(): Promise<SuperhiveStatus> {
  await updateConfig((config) => ({ ...config, superhiveTokenEnc: undefined }))
  clearListingCache(SUPERHIVE_HOST)
  return getSuperhiveStatus()
}

/** decrypt the stored token — main-process only, for Superhive repo calls */
export async function getSuperhiveToken(): Promise<string | null> {
  const stored = (await readConfig()).superhiveTokenEnc
  if (!stored || !safeStorage.isEncryptionAvailable()) return null
  try {
    return safeStorage.decryptString(Buffer.from(stored, 'base64'))
  } catch {
    return null
  }
}

// --- catalog listing & install --------------------------------------------

const atLeast = (version: string, base: string): boolean => compareVersionsDesc(version, base) <= 0

const fullVersionOf = (build: InstalledBuild): string =>
  /^\d+\.\d+\.\d+/.exec(build.version)?.[0] ?? `${minorOf(build.version)}.0`

/** newest installed Blender 4.2+ — used to query the catalog of purchased extensions */
async function catalogQueryBuild(): Promise<InstalledBuild | null> {
  const compatible = representativesByMinor(await listInstalled())
    .filter((build) => atLeast(minorOf(build.version), EXTENSIONS_SINCE))
    .sort((a, b) => compareVersionsDesc(a.version, b.version))
  return compatible[0] ?? null
}

async function requireToken(): Promise<string> {
  const token = await getSuperhiveToken()
  if (!token) throw new Error('Connect your Superhive account in Settings first')
  return token
}

export async function listSuperhiveCatalog(): Promise<ExtensionCatalogItem[]> {
  const token = await requireToken()
  const build = await catalogQueryBuild()
  if (!build) throw new Error('Install Blender 4.2+ to browse your Superhive extensions')
  const byId = await fetchRepoListing(SUPERHIVE_HOST, fullVersionOf(build), { token, label: 'Superhive' })
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

export interface SuperhiveArchive {
  path: string
  name: string
  version: string | null
}

/**
 * Resolve + download the purchased build of `pkgId` compatible with this Blender.
 * Listing is queried per exact version; bounds are re-filtered like Blender does
 * (min inclusive, max EXCLUSIVE). The caller installs the file and deletes it.
 */
export async function downloadSuperhiveArchive(
  build: InstalledBuild,
  pkgId: string
): Promise<{ archive?: SuperhiveArchive; skip?: string }> {
  const token = await requireToken()
  const minor = minorOf(build.version)
  const release = (
    await fetchRepoListing(SUPERHIVE_HOST, fullVersionOf(build), { token, label: 'Superhive' })
  ).get(pkgId)
  if (!release) return { skip: `Not available for Blender ${minor} on Superhive` }
  if (release.blenderVersionMin && !atLeast(minor, minorOf(release.blenderVersionMin))) {
    return { skip: `Requires Blender ${release.blenderVersionMin}+` }
  }
  if (release.blenderVersionMax && compareVersionsDesc(minor, release.blenderVersionMax) <= 0) {
    return { skip: `Supports Blender below ${release.blenderVersionMax}` }
  }
  const path = await downloadFromRepo(release, SUPERHIVE_ALLOWED_HOSTS, token)
  return { archive: { path, name: release.name, version: release.version } }
}
