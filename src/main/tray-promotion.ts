import { execFile } from 'child_process'
import { existsSync } from 'fs'
import { mkdir, readFile, rm } from 'fs/promises'
import { basename, join } from 'path'
import { promisify } from 'util'
import { app } from 'electron'
import { getRuntimeRoot } from './paths'
import { readUiState, setUiValueFromMain } from './ui-state'

// Windows keys the "show on taskbar vs hide in overflow" choice for a tray icon
// to the exe path of the process that registered it. The portable build runs
// from a fresh temp dir every launch, so that choice is orphaned each time and
// the icon lands back in the overflow. There is no official API for this, but
// Windows 11 stores the choice in HKCU\Control Panel\NotifyIconSettings
// (IsPromoted is exactly what the Settings toggle writes, applied live by
// Explorer) — so carry the previous session's choice over to the new entry and
// drop the orphaned ones. Failure is benign: the icon just stays where Windows
// put it. On Windows 10 the key does not exist and the whole pass no-ops.
//
// The registry is read via `reg export` to a UTF-16 file, NOT `reg query`:
// piped reg.exe output comes in the console OEM codepage (CP866 on ru-RU), so
// non-ASCII profile paths would be mojibake under Node's utf8 decode and the
// exe-path match would never succeed. The export also snapshots every value in
// one call — no per-key reads that could fail halfway through a decision.

const NOTIFY_KEY = 'HKCU\\Control Panel\\NotifyIconSettings'
// the last decision, remembered in ui-state.json: the registry entries of past
// sessions get deleted every pass, so this is the fallback memory when several
// orphans accumulated (pre-feature history, crashed sessions)
const STORE_KEY = 'tray.iconPromoted' // '1' | '0'
// Explorer creates the entry when the icon first appears — give it a moment
const RETRY_DELAYS_MS = [1500, 5000, 15000]
const EXEC_TIMEOUT_MS = 15_000

const execFileAsync = promisify(execFile)
const regOpts = { windowsHide: true, timeout: EXEC_TIMEOUT_MS }

export interface NotifyIconEntry {
  key: string
  path: string
  /** absent when the value is missing — the icon was never toggled either way */
  promoted?: boolean
}

/** Parse a `reg export` snapshot of NotifyIconSettings (UTF-16 text, BOM stripped). */
export function parseRegExport(text: string): NotifyIconEntry[] {
  const entries: NotifyIconEntry[] = []
  let key: string | null = null
  let path: string | null = null
  let promoted: boolean | undefined
  const flush = (): void => {
    if (key && path) entries.push({ key, path, ...(promoted === undefined ? {} : { promoted }) })
  }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/^﻿/, '')
    const section = /^\[(HKEY_[^\]]+)\]\s*$/.exec(line)
    if (section) {
      flush()
      key = section[1]
      path = null
      promoted = undefined
      continue
    }
    const exe = /^"ExecutablePath"="((?:[^"\\]|\\.)*)"\s*$/i.exec(line)
    if (exe) {
      path = exe[1].replace(/\\(.)/g, '$1')
      continue
    }
    const dword = /^"IsPromoted"=dword:([0-9a-fA-F]{1,8})\s*$/i.exec(line)
    if (dword) promoted = parseInt(dword[1], 16) === 1
  }
  flush()
  return entries
}

export interface PromotionPlan {
  currentKey: string
  alreadyPromoted: boolean
  promote: boolean
  /** value to remember in ui-state after this pass */
  remember: '1' | '0'
  /** orphaned entries of past launches, safe to delete */
  deadKeys: string[]
}

/**
 * Decide what to do with the registry snapshot. Returns null when this launch's
 * own entry is not there yet (Explorer lags the icon creation) — retry later.
 *
 * Choice precedence: exactly one orphan with an explicit IsPromoted is the last
 * session's final state — authoritative. Several explicit orphans (pre-feature
 * pile-up, crashed sessions) are unordered — the remembered ui-state value wins,
 * with any-promoted as the one-time fallback before the store existed. Nothing
 * anywhere means the very first launch: default to visible, a launcher that
 * lives in the tray is useless buried in the overflow.
 */
export function planPromotion(
  entries: NotifyIconEntry[],
  exePath: string,
  stored: string | undefined,
  exeExists: (path: string) => boolean
): PromotionPlan | null {
  const exeLower = exePath.toLowerCase()
  const exeName = basename(exePath).toLowerCase()
  const current = entries.find((entry) => entry.path.toLowerCase() === exeLower)
  if (!current) return null
  // orphans of our own past launches: same exe name, different path, and the exe
  // is gone from disk — a live sibling install (win-unpacked build, a second copy
  // of the folder) still exists and keeps its own entry and choice
  const dead = entries.filter(
    (entry) =>
      entry.path.toLowerCase() !== exeLower &&
      basename(entry.path).toLowerCase() === exeName &&
      !exeExists(entry.path)
  )
  const explicit = dead.filter((entry) => entry.promoted !== undefined)
  let promote: boolean
  if (explicit.length === 1) {
    promote = explicit[0].promoted === true
  } else if (stored === '1' || stored === '0') {
    promote = stored === '1'
  } else if (explicit.length > 0) {
    promote = explicit.some((entry) => entry.promoted)
  } else {
    promote = dead.length === 0
  }
  return {
    currentKey: current.key,
    alreadyPromoted: current.promoted === true,
    promote,
    remember: promote ? '1' : '0',
    deadKeys: dead.map((entry) => entry.key)
  }
}

async function readNotifyIconSettings(): Promise<NotifyIconEntry[]> {
  const dir = getRuntimeRoot()
  await mkdir(dir, { recursive: true })
  const file = join(dir, `notify-icons-${process.pid}.reg`)
  try {
    await execFileAsync('reg', ['export', NOTIFY_KEY, file, '/y'], regOpts)
    return parseRegExport((await readFile(file)).toString('utf16le'))
  } finally {
    await rm(file, { force: true }).catch(() => {})
  }
}

async function reconcileOnce(): Promise<boolean> {
  const [entries, state] = await Promise.all([readNotifyIconSettings(), readUiState()])
  const plan = planPromotion(entries, process.execPath, state[STORE_KEY], existsSync)
  if (!plan) return false
  if (plan.promote && !plan.alreadyPromoted) {
    // a failure here propagates: the orphans stay, keeping the choice recoverable
    await execFileAsync(
      'reg',
      ['add', plan.currentKey, '/v', 'IsPromoted', '/t', 'REG_DWORD', '/d', '1', '/f'],
      regOpts
    )
  }
  // never write 0: an untouched entry is already hidden, and the user may have
  // promoted the icon by hand while this pass was still waiting
  try {
    await setUiValueFromMain(STORE_KEY, plan.remember)
  } catch {
    return true // no memory written — keep the orphans as the record instead
  }
  for (const deadKey of plan.deadKeys) {
    await execFileAsync('reg', ['delete', deadKey, '/f'], regOpts).catch(() => {})
  }
  return true
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

let started = false

/** Fire-and-forget: carry the tray icon's visibility over to this launch's registry entry. */
export function reconcileTrayIconPromotion(): void {
  if (started) return
  started = true
  // dev runs share the plain electron.exe path with every other Electron app
  if (process.platform !== 'win32' || !app.isPackaged) return
  void (async () => {
    for (const delay of RETRY_DELAYS_MS) {
      await sleep(delay)
      try {
        if (await reconcileOnce()) return
      } catch {
        return // registry surface unavailable — leave the icon where Windows put it
      }
    }
  })()
}
