import { compareVersionsDesc } from './blender-builds'
import { GITHUB_REPO } from './app-config'

/**
 * Matches electron-builder.yml win.artifactName. Version-less on purpose: the
 * self-updater downloads this asset by fixed name, so a versioned one would go
 * stale after the first update. History: releases up to v0.1.1 shipped
 * blender-hub-<version>-portable.exe, 0.1.2–0.3.x a single-file portable
 * BlenderHub.exe; the folder build ships as BlenderHub.zip.
 */
export function updateZipName(): string {
  return 'BlenderHub.zip'
}

export function releasesLatestUrl(): string {
  return `https://github.com/${GITHUB_REPO}/releases/latest`
}

export function releasePageUrl(tag?: string): string {
  return tag ? `https://github.com/${GITHUB_REPO}/releases/tag/${tag}` : releasesLatestUrl()
}

export function updateAssetUrl(tag: string, fileName: string): string {
  return `https://github.com/${GITHUB_REPO}/releases/download/${tag}/${fileName}`
}

const TAG_RE = /^v?(\d+(?:\.\d+){1,3})$/

/**
 * GET <repo>/releases/latest answers with a redirect to .../releases/tag/<tag> —
 * the cheapest version probe there is (the HTML redirect is not subject to the
 * 60-requests/hour anonymous API limit). Returns null when the location is not
 * a tag page (repo private or no releases published yet).
 */
export function versionFromLatestRedirect(location: string): { tag: string; version: string } | null {
  const marker = '/releases/tag/'
  const index = location.indexOf(marker)
  if (index === -1) return null
  const tag = decodeURIComponent(location.slice(index + marker.length).split(/[/?#]/)[0])
  const match = TAG_RE.exec(tag)
  return match ? { tag, version: match[1] } : null
}

export function isNewerVersion(current: string, candidate: string): boolean {
  return compareVersionsDesc(current, candidate) > 0
}
