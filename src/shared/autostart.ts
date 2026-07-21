// Autostart preferences, shared between main (login-item writes, hidden-start
// detection) and the Settings page. Values: 'on' | 'off'; an absent key means
// on — the launcher registers itself by default.

export const AUTOSTART_KEY = 'launcher.autostart'
export const AUTOSTART_HIDDEN_KEY = 'launcher.autostartHidden'

/** command-line flag the Windows login item carries so an autostarted launch can wait in the tray */
export const HIDDEN_LAUNCH_FLAG = '--hidden'

export function autostartEnabled(raw: string | null | undefined): boolean {
  return raw !== 'off'
}

export function autostartHiddenEnabled(raw: string | null | undefined): boolean {
  return raw !== 'off'
}
