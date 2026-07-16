import type { RemoteBuild } from '../../../shared/types'

// External pages are opened via window.open: inside Electron the main process
// hands https links to the system browser (setWindowOpenHandler), in the
// browser preview it is a normal new tab.
export function buildNotesUrl(build: RemoteBuild): string | null {
  if (build.source === 'patch') {
    const match = build.branch.match(/PR(\d+)/i)
    return match ? `https://projects.blender.org/blender/blender/pulls/${match[1]}` : null
  }
  const [major, minor] = build.version.split('.')
  if (!major || minor === undefined) return null
  // one consistent target for every non-PR build; pages exist for 2.83+
  return `https://developer.blender.org/docs/release_notes/${major}.${minor}/`
}
