import { ipcMain } from 'electron'
import { requireString } from '../ipc-util'
import {
  notificationsDismiss,
  notificationsDismissAll,
  notificationsList,
  notificationsMarkAllRead
} from './service'

// Application Security Requirement: the renderer sends only notification ids, and a
// dismissal of an unknown id is a silent no-op — nothing here touches paths or URLs.

export function registerNotificationsIpc(): void {
  ipcMain.handle('notifications:list', () => notificationsList())

  ipcMain.handle('notifications:mark-all-read', () => notificationsMarkAllRead())

  ipcMain.handle('notifications:dismiss', (_event, rawId: unknown) => {
    const id = requireString(rawId, 'notification id')
    if (id.length > 300) throw new Error('Invalid notification id')
    return notificationsDismiss(id)
  })

  ipcMain.handle('notifications:dismiss-all', () => notificationsDismissAll())
}
