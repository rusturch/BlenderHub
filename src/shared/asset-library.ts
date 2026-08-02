// Launcher asset library preferences, shared between main (reconcile at startup,
// ui-state subscription) and the Settings page. Values: 'on' | 'off'; an absent
// key means off — registering a library in every Blender's preferences is opt-in.

export const ASSET_LIBRARY_KEY = 'launcher.assetLibrary'

/** the entry name shown inside Blender's own UI next to "User Library" — brand, never localized */
export const ASSET_LIBRARY_NAME = 'Blender Hub'

export function assetLibraryEnabled(raw: string | null | undefined): boolean {
  return raw === 'on'
}
