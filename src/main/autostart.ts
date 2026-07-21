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

// The portable stub re-extracts the real exe into a fresh temp dir on every run,
// so process.execPath must never reach the registry — electron-builder hands the
// on-disk stub path over in this env var instead.
function launcherExePath(): string {
  return process.env['PORTABLE_EXECUTABLE_FILE'] ?? process.execPath
}

function applyLoginItem(enabled: boolean, hidden: boolean, force: boolean): void {
  // a dev run would register node_modules' bare electron.exe
  if (!app.isPackaged) return
  if (process.platform === 'win32') {
    const path = launcherExePath()
    const args = hidden ? [HIDDEN_LAUNCH_FLAG] : []
    // The silent startup pass only repairs drift (moved exe, stale args): skipping
    // the write when the entry already matches keeps a "disabled in Task Manager"
    // choice intact — setLoginItemSettings would flip its approval key back on.
    if (!force && app.getLoginItemSettings({ path, args }).openAtLogin === enabled) return
    app.setLoginItemSettings({ openAtLogin: enabled, path, args })
  } else if (process.platform === 'darwin') {
    if (!force && app.getLoginItemSettings().openAtLogin === enabled) return
    // openAsHidden only reaches macOS 12 and older; 13+ relies on the
    // wasOpenedAtLogin check in shouldStartHidden()
    app.setLoginItemSettings({ openAtLogin: enabled, openAsHidden: hidden })
  }
  // no login-item API on Linux — the checkboxes persist but do nothing there
}

/** Whether this launch should wait in the tray instead of showing the window. */
export function shouldStartHidden(state: Record<string, string>): boolean {
  // Windows: the flag travels through the login item's registered args
  if (process.argv.includes(HIDDEN_LAUNCH_FLAG)) return true
  if (process.platform !== 'darwin' || !autostartHiddenEnabled(state[AUTOSTART_HIDDEN_KEY])) {
    return false
  }
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
