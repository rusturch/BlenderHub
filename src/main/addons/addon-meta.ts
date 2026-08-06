// Regex extraction of add-on metadata from python bl_info dicts and
// blender_manifest.toml files. Best-effort by design: python is not executed,
// so exotic formatting degrades to nulls — identity never depends on these
// fields, they only improve labels and matching hints.

export const tomlString = (text: string, key: string): string | null => {
  const match = new RegExp(`^\\s*${key}\\s*=\\s*["']([^"']+)["']`, 'm').exec(text)
  return match ? match[1] : null
}

export const blInfoString = (text: string, key: string): string | null => {
  const match = new RegExp(`["']${key}["']\\s*:\\s*["']([^"']*)["']`).exec(text)
  return match ? match[1] : null
}

export const blInfoTuple = (text: string, key: string): string | null => {
  const match = new RegExp(`["']${key}["']\\s*:\\s*\\(([^)]*)\\)`).exec(text)
  if (!match) return null
  const parts = match[1]
    .split(',')
    .map((part) => part.trim())
    .filter((part) => /^\d+$/.test(part))
  return parts.length > 0 ? parts.join('.') : null
}

export interface BlInfoMeta {
  name: string | null
  version: string | null
  category: string | null
  author: string | null
  minBlender: string | null
  description: string | null
  /** where to read more: bl_info's doc_url, falling back to the older wiki_url / tracker_url */
  website: string | null
}

/** only http(s) — bl_info/manifest values are author-supplied and end up in window.open */
const webUrl = (value: string | null): string | null =>
  value && /^https?:\/\//i.test(value) ? value : null

export function parseBlInfo(text: string): BlInfoMeta {
  return {
    name: blInfoString(text, 'name'),
    version: blInfoTuple(text, 'version'),
    category: blInfoString(text, 'category'),
    author: blInfoString(text, 'author'),
    minBlender: blInfoTuple(text, 'blender'),
    description: blInfoString(text, 'description'),
    website:
      webUrl(blInfoString(text, 'doc_url')) ??
      webUrl(blInfoString(text, 'wiki_url')) ??
      webUrl(blInfoString(text, 'tracker_url'))
  }
}

export interface ManifestMeta {
  id: string | null
  name: string | null
  version: string | null
  maintainer: string | null
  minBlender: string | null
  /** blender_version_max is EXCLUSIVE — the add-on supports versions strictly below it */
  maxBlender: string | null
  /** the manifest's one-line 'tagline' — Blender's own UI shows it where bl_info has 'description' */
  description: string | null
  /** the extension's own homepage, as declared by `website` in the manifest */
  website: string | null
}

export function parseManifest(text: string): ManifestMeta {
  return {
    id: tomlString(text, 'id'),
    name: tomlString(text, 'name'),
    version: tomlString(text, 'version'),
    maintainer: tomlString(text, 'maintainer'),
    minBlender: tomlString(text, 'blender_version_min'),
    maxBlender: tomlString(text, 'blender_version_max'),
    description: tomlString(text, 'tagline'),
    website: webUrl(tomlString(text, 'website'))
  }
}
