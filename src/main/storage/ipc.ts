import { ipcMain } from 'electron'
import { computeStorageUsage } from './usage'

export function registerStorageIpc(): void {
  // read-only: no args from the renderer, all paths resolved in main
  ipcMain.handle('storage:usage', () => computeStorageUsage())
}
