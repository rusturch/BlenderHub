export type SettingsSection =
  | 'general'
  | 'appearance'
  | 'notifications'
  | 'projects'
  | 'installs'
  | 'addons'
  | 'cloud'
  | 'storage'
  | 'updates'

/** sidebar order of the settings window */
export const SETTINGS_SECTIONS: { id: SettingsSection; labelKey: string }[] = [
  { id: 'general', labelKey: 'settings.sectionGeneral' },
  { id: 'appearance', labelKey: 'settings.sectionAppearance' },
  { id: 'notifications', labelKey: 'settings.sectionNotifications' },
  { id: 'projects', labelKey: 'settings.sectionProjects' },
  { id: 'installs', labelKey: 'settings.sectionInstalls' },
  { id: 'addons', labelKey: 'settings.sectionAddons' },
  { id: 'cloud', labelKey: 'settings.sectionCloud' },
  { id: 'storage', labelKey: 'settings.sectionStorage' },
  { id: 'updates', labelKey: 'settings.sectionUpdates' }
]

/** ui-state key remembering the section the window was last left on */
export const SETTINGS_SECTION_KEY = 'settings.section'

// Deep links from elsewhere in the app name a card ("open Settings at the Superhive
// account"); this is the section each of those cards lives in.
const HIGHLIGHT_SECTION: Record<string, SettingsSection> = {
  updates: 'updates',
  notifications: 'notifications',
  theme: 'appearance',
  superhive: 'addons',
  'cloud-sync': 'cloud'
}

export function sectionForHighlight(highlight: string | null | undefined): SettingsSection | null {
  return (highlight && HIGHLIGHT_SECTION[highlight]) || null
}

export function isSettingsSection(value: string | null): value is SettingsSection {
  return SETTINGS_SECTIONS.some((section) => section.id === value)
}
