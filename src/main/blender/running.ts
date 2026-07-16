import { execFile } from 'child_process'
import { promisify } from 'util'
import { resolve } from 'path'
import { minorOf } from '../../shared/blender-archive'
import type { RunningBlender } from '../../shared/types'
import { listInstalled } from './installs'

// A running Blender holds its preferences in memory and re-saves them on any prefs
// change (auto-save is Blender's default) — a headless prefs write from the launcher
// would be silently overwritten, resurrecting e.g. uninstalled add-ons as ghost
// entries. Before such writes the pages ask which affected versions are running.
//
// Detection is best-effort: any enumeration failure reports "nothing running" so a
// broken `ps`/PowerShell never blocks the launcher — that merely restores the old
// unguarded behavior. A process counts when its executable path matches a registered
// install OR (Windows) when the exe's ProductVersion resource names an affected minor
// — installs the launcher does not know about share the same per-minor Blender config
// and are just as capable of clobbering it. Headless runs (--background) are skipped:
// they exit on their own and a window-close request cannot reach them anyway.

const execFileAsync = promisify(execFile)

const EXEC_TIMEOUT_MS = 15_000

// -EncodedCommand, not -Command: a script passed as a plain argument goes through the
// Windows command-line parser, which strips the inner double quotes PowerShell needs
// (verified live: [DllImport("user32.dll")] arrived as DllImport(user32.dll))
async function runPowerShell(script: string): Promise<string> {
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
    { timeout: EXEC_TIMEOUT_MS, windowsHide: true }
  )
  return stdout
}

interface ProcEntry {
  pid: number
  /** full executable path — null when the OS would not tell */
  path: string | null
  /** full command line (win) or `ps` command column (posix) */
  cmd: string | null
  /** exe ProductVersion resource — Blender stamps its minor there ("5.1"); win only */
  version: string | null
}

async function listProcessesWin(): Promise<ProcEntry[]> {
  const stdout = await runPowerShell(
    `$procs = Get-CimInstance Win32_Process -Filter "Name='blender.exe'" | Select-Object ProcessId,ExecutablePath,CommandLine
$out = foreach ($p in $procs) {
  $ver = $null
  if ($p.ExecutablePath) { try { $ver = (Get-Item -LiteralPath $p.ExecutablePath).VersionInfo.ProductVersion } catch {} }
  [pscustomobject]@{ pid = $p.ProcessId; path = $p.ExecutablePath; cmd = $p.CommandLine; version = $ver }
}
ConvertTo-Json -InputObject @($out) -Compress`
  )
  const text = stdout.trim()
  if (!text) return []
  const parsed = JSON.parse(text) as { pid?: unknown; path?: unknown; cmd?: unknown; version?: unknown }[]
  const entries: ProcEntry[] = []
  for (const item of Array.isArray(parsed) ? parsed : [parsed]) {
    if (typeof item?.pid !== 'number') continue
    entries.push({
      pid: item.pid,
      path: typeof item.path === 'string' && item.path ? item.path : null,
      cmd: typeof item.cmd === 'string' ? item.cmd : null,
      version: typeof item.version === 'string' ? item.version : null
    })
  }
  return entries
}

async function listProcessesPosix(): Promise<ProcEntry[]> {
  const { stdout } = await execFileAsync('ps', ['-axo', 'pid=,command='], { timeout: EXEC_TIMEOUT_MS })
  const entries: ProcEntry[] = []
  for (const line of stdout.split('\n')) {
    const match = /^\s*(\d+)\s+(.+)$/.exec(line)
    if (match) entries.push({ pid: Number(match[1]), path: null, cmd: match[2], version: null })
  }
  return entries
}

// Blender's headless flags: `-b` / `--background` as their own token, not inside a path
const HEADLESS_RE = /(\s|^)(--background|-b)(\s|$)/

/** pid lists per running minor — registered-path match first, exe version as fallback */
async function runningByMinor(minors: string[]): Promise<Map<string, number[]>> {
  let processes: ProcEntry[] = []
  try {
    processes = process.platform === 'win32' ? await listProcessesWin() : await listProcessesPosix()
  } catch {
    return new Map()
  }
  if (processes.length === 0) return new Map()

  const wanted = new Set(minors)
  const isWin = process.platform === 'win32'
  const normalize = (path: string): string => (isWin ? resolve(path).toLowerCase() : resolve(path))
  const byExe = new Map<string, string>() // normalized exe path -> minor
  for (const build of await listInstalled()) {
    const minor = minorOf(build.version)
    if (wanted.has(minor)) byExe.set(normalize(build.executable), minor)
  }

  const result = new Map<string, number[]>()
  const add = (minor: string, pid: number): void => {
    const pids = result.get(minor)
    if (pids) pids.push(pid)
    else result.set(minor, [pid])
  }
  for (const proc of processes) {
    if (proc.cmd && HEADLESS_RE.test(proc.cmd)) continue
    if (isWin) {
      const pathMinor = proc.path ? byExe.get(normalize(proc.path)) : undefined
      if (pathMinor) {
        add(pathMinor, proc.pid)
        continue
      }
      // unregistered install — trust the exe's version resource for the minor
      const resourceMinor = proc.version ? /^\d+\.\d+/.exec(proc.version)?.[0] : undefined
      if (resourceMinor && wanted.has(resourceMinor)) add(resourceMinor, proc.pid)
    } else {
      // posix `ps` gives the command line — match its prefix against known executables
      const command = proc.cmd ?? ''
      const hit = [...byExe.entries()].find(([exe]) => command.startsWith(exe))
      if (hit) add(hit[1], proc.pid)
    }
  }
  return result
}

export async function listRunningBlenders(minors: string[]): Promise<RunningBlender[]> {
  return [...(await runningByMinor(minors)).entries()].map(([minor, pids]) => ({
    minor,
    count: pids.length
  }))
}

/**
 * Bring a Blender window to the front BEFORE the close request, so the
 * unsaved-changes prompt the close triggers appears in the user's face instead of
 * blinking in the taskbar. Best-effort: pids come from our own enumeration (never
 * from the renderer), a failure changes nothing about the close request itself.
 */
async function bringToFront(pids: number[]): Promise<void> {
  if (process.platform === 'win32') {
    // A plain SetForegroundWindow only succeeds while the launcher IS the foreground
    // process (first window of a close chain). For the next windows the foreground is
    // already a Blender, Windows revokes the right and only flashes the taskbar — so
    // on failure the script borrows the input state of the current foreground thread
    // (AttachThreadInput) and raises the window through it. Classic, ugly, works.
    const script = `
Add-Type -Namespace BH -Name Win32 -MemberDefinition @'
[DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
[DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr hWnd, int nCmdShow);
[DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hWnd);
[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
[DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);
[DllImport("user32.dll")] public static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);
[DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
[DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
'@
foreach ($id in @(${pids.join(',')})) {
  $p = Get-Process -Id $id -ErrorAction SilentlyContinue
  if (-not $p -or $p.MainWindowHandle -eq [IntPtr]::Zero) { continue }
  $h = $p.MainWindowHandle
  if ([BH.Win32]::IsIconic($h)) { [BH.Win32]::ShowWindowAsync($h, 9) | Out-Null }
  if (-not [BH.Win32]::SetForegroundWindow($h)) {
    $fg = [BH.Win32]::GetForegroundWindow()
    if ($fg -ne [IntPtr]::Zero) {
      $fgPid = [uint32]0
      $fgThread = [BH.Win32]::GetWindowThreadProcessId($fg, [ref]$fgPid)
      $cur = [BH.Win32]::GetCurrentThreadId()
      if ([BH.Win32]::AttachThreadInput($cur, $fgThread, $true)) {
        [BH.Win32]::BringWindowToTop($h) | Out-Null
        [BH.Win32]::SetForegroundWindow($h) | Out-Null
        [BH.Win32]::AttachThreadInput($cur, $fgThread, $false) | Out-Null
      }
    }
  }
  Start-Sleep -Milliseconds 150
}
`
    await runPowerShell(script).catch(() => {})
  } else if (process.platform === 'darwin') {
    for (const pid of pids) {
      await execFileAsync(
        'osascript',
        ['-e', `tell application "System Events" to set frontmost of (first process whose unix id is ${pid}) to true`],
        { timeout: EXEC_TIMEOUT_MS }
      ).catch(() => {})
    }
  }
  // linux: no portable way without wmctrl/xdotool — the close request still works
}

/**
 * Politely ask every running Blender of these minors to close. First ALL windows are
 * raised into one stack (bottom→top; sequential fronting works past Windows'
 * foreground lock via the AttachThreadInput fallback in bringToFront), then each gets
 * the close request — the top window last, so its prompt ends up focused. The user
 * deals with the top window; closing it reveals the next one right beneath, already
 * showing its own prompt, and Windows hands the focus down the stack by itself.
 * On Windows taskkill WITHOUT /F posts WM_CLOSE — Blender shows its own
 * unsaved-changes prompt, so no work can be lost silently. Elsewhere SIGTERM triggers
 * Blender's orderly shutdown (it writes the quit.blend recovery file). Never
 * force-kills.
 */
export async function requestCloseBlenders(minors: string[]): Promise<void> {
  const running = await runningByMinor(minors)
  // deterministic priority: lowest minor first, then lowest pid — that one ends on top
  const priority = [...running.entries()]
    .sort((a, b) => a[0].localeCompare(b[0], undefined, { numeric: true }))
    .flatMap(([, pids]) => [...pids].sort((a, b) => a - b))
  if (priority.length === 0) return
  // raise bottom-of-stack first; the last window fronted (= first priority) stays on top
  const bottomUp = [...priority].reverse()
  await bringToFront(bottomUp)
  if (process.platform === 'win32') {
    for (const pid of bottomUp) {
      // exits non-zero when the window refuses to close (unsaved prompt shown) — that is fine
      await execFileAsync('taskkill', ['/PID', String(pid)], {
        timeout: EXEC_TIMEOUT_MS,
        windowsHide: true
      }).catch(() => {})
    }
  } else {
    for (const pid of bottomUp) {
      try {
        process.kill(pid, 'SIGTERM')
      } catch {
        // already exited
      }
    }
  }
}
