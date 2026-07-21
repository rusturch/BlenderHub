import { app } from 'electron'
import { onUiStateSet, readUiState } from './ui-state'
import {
  AUTOSTART_HIDDEN_KEY,
  AUTOSTART_KEY,
  HIDDEN_LAUNCH_FLAG,
  autostartEnabled,
  autostartHiddenEnabled
} from '../shared/autostart'

// Registers the launcher as an OS login item (Windows Run registry entry, macOS
// login item). Both preferences live in ui-state.json — the renderer writes them
// from Settings via the existing ui:set-state channel, same pattern as tray.ts.

/** also the registry value name of the Windows login item (used by index.ts too) */
export const APP_USER_MODEL_ID = 'com.rusturch.blender-hub'

// The portable stub re-extracts the real exe into a fresh temp dir on every run,
// so process.execPath must never reach the registry — electron-builder hands the
// on-disk stub path over in this env var instead.
function launcherExePath(): string {
  return process.env['PORTABLE_EXECUTABLE_FILE'] ?? process.execPath
}

function applyWin32(enabled: boolean, hidden: boolean, force: boolean): void {
  const path = launcherExePath()
  const args = hidden ? [HIDDEN_LAUNCH_FLAG] : []
  const current = app.getLoginItemSettings({ path, args })
  // our Run entry regardless of which args (or old exe path) it was written
  // with — openAtLogin alone matches the exact current command line only
  const existing = current.launchItems.find(
    (item) => item.name === APP_USER_MODEL_ID || item.path.toLowerCase() === path.toLowerCase()
  )
  if (enabled) {
    // the exact entry is already in place — don't touch the approval state
    if (!force && current.openAtLogin) return
    app.setLoginItemSettings({
      openAtLogin: true,
      path,
      args,
      name: APP_USER_MODEL_ID,
      // A silent repair (moved exe, stale args) must not re-arm an entry the
      // user disabled in Task Manager: Electron's `enabled` defaults to true,
      // which deletes the StartupApproved marker. Only an explicit Settings
      // toggle gets to do that.
      enabled: force ? true : (existing?.enabled ?? true)
    })
  } else {
    // keyed on the entry's existence, not openAtLogin: a stale entry carrying
    // different args reports openAtLogin=false and would otherwise never be removed
    if (!force && !existing) return
    app.setLoginItemSettings({ openAtLogin: false, path, args, name: APP_USER_MODEL_ID })
  }
}

function applyDarwin(enabled: boolean, hidden: boolean, force: boolean): void {
  if (!force) {
    const current = app.getLoginItemSettings()
    if (current.openAtLogin === enabled) return
    // macOS 13+: an item toggled off in System Settings reads requires-approval
    // and re-registering just fails on every launch — treat it as the user's call
    if (enabled && current.status === 'requires-approval') return
  }
  // openAsHidden only reaches macOS 12 and older; 13+ relies on the
  // wasOpenedAtLogin check in shouldStartHidden()
  app.setLoginItemSettings({ openAtLogin: enabled, openAsHidden: hidden })
}

function applyLoginItem(enabled: boolean, hidden: boolean, force: boolean): void {
  // a dev run would register node_modules' bare electron.exe
  if (!app.isPackaged) return
  if (process.platform === 'win32') applyWin32(enabled, hidden, force)
  else if (process.platform === 'darwin') applyDarwin(enabled, hidden, force)
  // no login-item API on Linux — the checkboxes persist but do nothing there
}

/** Whether this launch should wait in the tray instead of showing the window. */
export function shouldStartHidden(state: Record<string, string>): boolean {
  // The launch flag / OS signal is advisory only: a stale login item (registry
  // out of step with a cloud-synced data folder) must not hide the window
  // against what the visible settings say.
  if (!autostartEnabled(state[AUTOSTART_KEY])) return false
  if (!autostartHiddenEnabled(state[AUTOSTART_HIDDEN_KEY])) return false
  // Windows: the flag travels through the login item's registered args
  if (process.argv.includes(HIDDEN_LAUNCH_FLAG)) return true
  if (process.platform !== 'darwin') return false
  // macOS login items carry no args — ask the OS how this launch happened
  const login = app.getLoginItemSettings()
  return login.wasOpenedAtLogin || login.wasOpenedAsHidden
}

export function setupAutostart(): void {
  const apply = (force: boolean): void => {
    void readUiState().then((state) =>
      applyLoginItem(
        autostartEnabled(state[AUTOSTART_KEY]),
        autostartHiddenEnabled(state[AUTOSTART_HIDDEN_KEY]),
        force
      )
    )
  }
  // reconcile on every start: the portable exe may have moved since the last run
  apply(false)
  onUiStateSet((key) => {
    // a Settings toggle is an explicit choice — write unconditionally so it also
    // revives an entry the user had disabled in the OS startup manager
    if (key === AUTOSTART_KEY || key === AUTOSTART_HIDDEN_KEY) apply(true)
  })
}
