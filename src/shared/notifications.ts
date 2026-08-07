import type { NotificationCategory } from './types'

// Notification-category toggles, shared between main (background detectors) and the
// Settings page. Values: 'on' | 'off'; an absent key falls back to the category default.

export type ToggleableNotificationCategory = Exclude<NotificationCategory, 'launcher-update'>

export const NOTIFY_CATEGORY_KEYS: Record<ToggleableNotificationCategory, string> = {
  'blender-update': 'notify.blenderUpdates',
  'addon-update': 'notify.addonUpdates',
  operation: 'notify.operations',
  'sync-changes': 'notify.syncChanges',
  'superhive-auth': 'notify.superhiveAuth'
}

/** categories that stay quiet until explicitly enabled */
const DEFAULT_OFF: ReadonlySet<ToggleableNotificationCategory> = new Set(['superhive-auth'])

/**
 * Rolling (daily/experimental) builds get a new commit almost every day, and every
 * commit is an "update" — pinging about them is a separate opt-in on top of the
 * blender-update category so the default never turns into daily noise.
 */
export const NOTIFY_BLENDER_ROLLING_KEY = 'notify.blenderRollingUpdates'

export function notifyCategoryEnabledValue(
  category: ToggleableNotificationCategory,
  raw: string | null | undefined
): boolean {
  return DEFAULT_OFF.has(category) ? raw === 'on' : raw !== 'off'
}

export function notifyRollingEnabledValue(raw: string | null | undefined): boolean {
  return raw === 'on'
}
