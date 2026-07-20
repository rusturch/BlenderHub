import { getLauncherApi } from './preview-fallback'
import type { LauncherPlatform } from '../../../shared/types'

// Which OS the launcher is running on. Resolved synchronously (preload sets it
// before the page loads, the browser preview guesses from the user agent), so
// layout that depends on it can be decided during the first render.

export function hostPlatform(): LauncherPlatform {
  return getLauncherApi().api.platform
}

export function isMac(): boolean {
  return hostPlatform() === 'darwin'
}
