// Windows keeps a deleted folder intact under $RECYCLE.BIN\<user SID>\$R…, so a
// trashed Blender still answers --version and a trashed .blend still parses. Every
// recursive scan must stay out: these names carry no dot prefix, so the usual
// hidden-directory check misses them.
const SKIPPED_DIR_NAMES = new Set(['$recycle.bin', 'system volume information'])

/** true for dot-directories and for OS folders a recursive scan must never enter */
export function isSkippedScanDir(name: string): boolean {
  return name.startsWith('.') || SKIPPED_DIR_NAMES.has(name.toLowerCase())
}

/**
 * true when any segment of a path is one of those OS folders. Dot-directories are
 * deliberately not rejected here — a scan skips them, but an explicitly registered
 * path may legitimately live under one (e.g. ~/.local/blender).
 */
export function isUnderSkippedScanDir(path: string): boolean {
  return path.split(/[\\/]/).some((segment) => SKIPPED_DIR_NAMES.has(segment.toLowerCase()))
}
