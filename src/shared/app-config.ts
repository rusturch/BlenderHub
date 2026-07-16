// ─────────────────────────────────────────────────────────────────────────────
//  PROJECT IDENTITY — fill these in for your own repository and community.
//
//  Single source of truth for the TypeScript side of the app: the in-app updater,
//  the release-page links and the sidebar "Join Discord" button all read from
//  here, so changing a value here updates the whole app at once.
//
//  These files are NOT TypeScript and cannot read this module — after you change
//  GITHUB_REPO, update them BY HAND to match:
//    • package.json          → "repository.url", "homepage", "bugs.url", "author"
//    • electron-builder.yml  → "appId", "maintainer"
// ─────────────────────────────────────────────────────────────────────────────

/**
 * GitHub repository as "owner/name". The updater checks
 *   github.com/<owner>/<name>/releases/latest
 * and downloads release assets from there; "Open releases page" links here too.
 * The repository must be public — the updater fetches release assets anonymously.
 * When forking, set this to your own "owner/name".
 */
export const GITHUB_REPO = 'rusturch/BlenderHub'

/** Discord invite opened by the sidebar "Join Discord" button. */
export const DISCORD_INVITE_URL = 'https://discord.gg/HTz878hsB4'

/**
 * Optional support / donation link (Boosty, Patreon, Ko-fi, …). Leave empty to
 * keep the sidebar "Support Us" button disabled ("coming soon"); fill it in and
 * the button becomes active and opens this URL.
 */
export const SUPPORT_URL: string = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=RDdQw4w9WgXcQ&start_radio=1'
