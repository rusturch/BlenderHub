import { mkdir, readFile, rename, writeFile } from 'fs/promises'
import { join } from 'path'
import { getDataRoot } from '../paths'
import type { HubNotification, NotificationCategory, NotificationDraft } from '../../shared/types'

// The bell's persistent state, separate from config.json: active notifications plus
// the ids the user dismissed. Dismissed ids are remembered so a periodic re-detection
// cannot resurrect an entry while the condition it describes still holds; the moment
// the condition goes away the id is pruned and an identical future finding pings again.

interface NotificationsFile {
  active: HubNotification[]
  dismissedIds: string[]
}

const ACTIVE_CAP = 50
const DISMISSED_CAP = 200

const statePath = (): string => join(getDataRoot(), 'notifications.json')

const isString = (value: unknown): value is string => typeof value === 'string'

// Category-aware shape check: a record the renderer cannot handle (an unknown
// category from a newer launcher sharing the portable data folder, or a torn
// payload) must never reach the bell — the categories self-heal via reconcile.
function payloadOk(category: string, payload: Record<string, unknown>): boolean {
  switch (category) {
    case 'launcher-update':
      return isString(payload.version)
    case 'blender-update':
      return (
        isString(payload.installedVersion) &&
        isString(payload.installedCycle) &&
        isString(payload.targetVersion) &&
        isString(payload.targetCycle)
      )
    case 'addon-update':
      return (
        isString(payload.name) &&
        isString(payload.pkgId) &&
        isString(payload.installedVersion) &&
        isString(payload.catalogVersion) &&
        isString(payload.host)
      )
    case 'operation':
      return (
        (payload.result === 'done' || payload.result === 'error') &&
        isString(payload.version) &&
        isString(payload.releaseCycle)
      )
    case 'sync-changes':
      return (
        Array.isArray(payload.minors) &&
        payload.minors.every(isString) &&
        typeof payload.conflicts === 'number' &&
        typeof payload.changed === 'number'
      )
    case 'superhive-auth':
      return true
    default:
      return false
  }
}

function isNotificationLike(value: unknown): value is HubNotification {
  const record = value as { id?: unknown; category?: unknown; createdAt?: unknown; payload?: unknown }
  return Boolean(
    record &&
      typeof record.id === 'string' &&
      typeof record.category === 'string' &&
      typeof record.createdAt === 'number' &&
      record.payload &&
      typeof record.payload === 'object' &&
      payloadOk(record.category, record.payload as Record<string, unknown>)
  )
}

async function readNotificationsRaw(): Promise<{ raw: Record<string, unknown>; file: NotificationsFile }> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(statePath(), 'utf8'))
  } catch {
    return { raw: {}, file: { active: [], dismissedIds: [] } } // missing or corrupt file never breaks the bell
  }
  const raw = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  return {
    raw,
    file: {
      active: Array.isArray(raw.active)
        ? raw.active.filter(isNotificationLike).map((item) => ({ ...item, read: Boolean(item.read) }))
        : [],
      dismissedIds: Array.isArray(raw.dismissedIds)
        ? raw.dismissedIds.filter((id): id is string => typeof id === 'string')
        : []
    }
  }
}

async function readNotificationsFile(): Promise<NotificationsFile> {
  return (await readNotificationsRaw()).file
}

// serialized read-modify-write, atomic on disk (same idiom as config.ts): unknown
// top-level fields written by a NEWER app version survive via the spread; a patch
// returning the same object reference skips the write entirely
let writeQueue: Promise<unknown> = Promise.resolve()

function updateNotifications(
  patch: (file: NotificationsFile) => NotificationsFile
): Promise<NotificationsFile> {
  const task = writeQueue.then(async () => {
    const { raw, file: current } = await readNotificationsRaw()
    const next = patch(current)
    if (next === current) return current
    await mkdir(getDataRoot(), { recursive: true })
    const target = statePath()
    await writeFile(
      `${target}.tmp`,
      JSON.stringify({ ...raw, active: next.active, dismissedIds: next.dismissedIds }, null, 2)
    )
    await rename(`${target}.tmp`, target)
    return next
  })
  writeQueue = task.catch(() => {})
  return task
}

const byNewest = (a: HubNotification, b: HubNotification): number => b.createdAt - a.createdAt

export async function listActive(): Promise<HubNotification[]> {
  return (await readNotificationsFile()).active.sort(byNewest)
}

/**
 * Replace a state-derived category with what a detector currently sees. Existing ids
 * keep their createdAt/read, new ids arrive unread, ids no longer reported disappear —
 * and their dismissal memory goes with them. Returns the fresh list, or null on no-op.
 */
export async function reconcileCategory(
  category: NotificationCategory,
  current: NotificationDraft[]
): Promise<HubNotification[] | null> {
  let changed = false
  const next = await updateNotifications((file) => {
    const currentIds = new Set(current.map((item) => item.id))
    const existing = new Map(
      file.active.filter((item) => item.category === category).map((item) => [item.id, item])
    )
    const dismissed = new Set(file.dismissedIds)
    const categoryItems: HubNotification[] = []
    for (const item of current) {
      if (dismissed.has(item.id)) continue
      categoryItems.push(existing.get(item.id) ?? { ...item, createdAt: Date.now(), read: false })
    }
    const prunedDismissed = file.dismissedIds.filter(
      (id) => !id.startsWith(`${category}:`) || currentIds.has(id)
    )
    changed =
      categoryItems.length !== existing.size ||
      categoryItems.some((item) => !existing.has(item.id)) ||
      prunedDismissed.length !== file.dismissedIds.length
    if (!changed) return file
    const active = [
      ...file.active.filter((item) => item.category !== category),
      ...categoryItems
    ]
      .sort(byNewest)
      .slice(0, ACTIVE_CAP)
    return { active, dismissedIds: prunedDismissed }
  })
  return changed ? next.active.sort(byNewest) : null
}

/** one-shot event (a finished install) — appended as is, never re-derived */
export async function pushEvent(notification: HubNotification): Promise<HubNotification[]> {
  const next = await updateNotifications((file) => ({
    active: [notification, ...file.active].slice(0, ACTIVE_CAP),
    dismissedIds: file.dismissedIds
  }))
  return next.active.sort(byNewest)
}

export async function markAllRead(): Promise<HubNotification[] | null> {
  let changed = false
  const next = await updateNotifications((file) => {
    if (!file.active.some((item) => !item.read)) return file
    changed = true
    return {
      active: file.active.map((item) => (item.read ? item : { ...item, read: true })),
      dismissedIds: file.dismissedIds
    }
  })
  return changed ? next.active.sort(byNewest) : null
}

export async function dismissNotification(id: string): Promise<HubNotification[] | null> {
  let changed = false
  const next = await updateNotifications((file) => {
    const target = file.active.find((item) => item.id === id)
    if (!target) return file
    changed = true
    return {
      active: file.active.filter((item) => item.id !== id),
      // events never re-derive, so only state-derived ids need dismissal memory
      dismissedIds:
        target.category === 'operation'
          ? file.dismissedIds
          : [...file.dismissedIds, id].slice(-DISMISSED_CAP)
    }
  })
  return changed ? next.active.sort(byNewest) : null
}

export async function dismissAllNotifications(): Promise<HubNotification[] | null> {
  let changed = false
  const next = await updateNotifications((file) => {
    if (file.active.length === 0) return file
    changed = true
    const remembered = file.active
      .filter((item) => item.category !== 'operation')
      .map((item) => item.id)
    return {
      active: [],
      dismissedIds: [...file.dismissedIds, ...remembered].slice(-DISMISSED_CAP)
    }
  })
  return changed ? next.active : null
}
