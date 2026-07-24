import { execFile } from 'child_process'
import { readdir, stat } from 'fs/promises'
import { isAbsolute, join, relative, resolve } from 'path'
import { promisify } from 'util'
import { updateConfig, readConfig } from '../config'
import type { LocatedInstall } from '../config'
import type { InstalledBuild } from '../../shared/types'

const execFileAsync = promisify(execFile)

function executableCandidates(): string[] {
  if (process.platform === 'win32') return ['blender.exe']
  if (process.platform === 'darwin') return [join('Blender.app', 'Contents', 'MacOS', 'Blender')]
  return ['blender']
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function executableIn(dir: string): Promise<string | null> {
  for (const candidate of executableCandidates()) {
    if (await exists(join(dir, candidate))) return candidate
  }
  // macOS: a renamed bundle like "Blender 4.2.app" holds the binary directly
  if (process.platform === 'darwin' && dir.toLowerCase().endsWith('.app')) {
    const candidate = join('Contents', 'MacOS', 'Blender')
    if (await exists(join(dir, candidate))) return candidate
  }
  return null
}

const MAX_SCAN_DEPTH = 3
const MAX_SCANNED_DIRS = 2000

interface BlenderRoot {
  root: string
  executableRelative: string
}

// find every directory holding a Blender executable, a few levels deep, so the
// user can pick a folder that contains several installations at once
export async function findBlenderRoots(dir: string): Promise<BlenderRoot[]> {
  const found: BlenderRoot[] = []
  let visited = 0
  const walk = async (current: string, depthLeft: number): Promise<void> => {
    if (visited++ >= MAX_SCANNED_DIRS) return
    const executableRelative = await executableIn(current)
    if (executableRelative) {
      // a build root never nests other builds — no need to descend further
      found.push({ root: current, executableRelative })
      return
    }
    if (depthLeft === 0) return
    let entries
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      await walk(join(current, entry.name), depthLeft - 1)
    }
  }
  await walk(resolve(dir), MAX_SCAN_DEPTH)
  return found
}

// `blender --version` prints e.g. "Blender 5.3.0 Alpha" followed by
// "build hash: …" / "build branch: …" lines (branch is absent in older builds)
export async function detectBuild(executable: string): Promise<{
  version: string
  releaseCycle: string
  branch?: string
  commit?: string
}> {
  const { stdout } = await execFileAsync(executable, ['--version'], {
    timeout: 20000,
    windowsHide: true
  })
  const versionMatch = stdout.match(/Blender\s+(\d+\.\d+\.\d+)[ \t]*([A-Za-z][A-Za-z ]*)?/)
  if (!versionMatch) throw new Error('This does not look like a Blender installation')
  const cycleRaw = (versionMatch[2] ?? '').trim().toLowerCase()
  const releaseCycle = cycleRaw === '' ? 'stable' : cycleRaw.includes('candidate') ? 'candidate' : cycleRaw
  return {
    version: versionMatch[1],
    releaseCycle,
    branch: stdout.match(/build branch:\s*(\S+)/)?.[1],
    commit: stdout.match(/build hash:\s*([0-9a-fA-F]+)/)?.[1]
  }
}

export interface DetectedBlender {
  executableRelative: string
  version: string
  releaseCycle: string
  branch?: string
  commit?: string
}

// detect a Blender build living directly in `dir` (no descent into subfolders) —
// used to adopt builds copied into the installs folder by hand
export async function detectBlenderAt(dir: string): Promise<DetectedBlender | null> {
  const executableRelative = await executableIn(dir)
  if (!executableRelative) return null
  const detected = await detectBuild(join(dir, executableRelative))
  return { executableRelative, ...detected }
}

// modest parallelism: `blender --version` is cheap but still a process launch
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length)
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++
      results[index] = await fn(items[index])
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
  return results
}

function toInstalledBuild(entry: LocatedInstall): InstalledBuild {
  return {
    id: `located:${entry.path}`,
    managed: false,
    version: entry.version,
    releaseCycle: entry.releaseCycle,
    branch: entry.branch,
    commit: entry.commit,
    installedAt: entry.addedAt,
    path: entry.path,
    executable: join(entry.path, entry.executableRelative)
  }
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

// register every Blender found under pickedDir; builds inside the launcher's own
// installs folder are skipped — those get adopted automatically on the next listing
export async function locateInstalls(pickedDir: string, managedInstallsDir: string): Promise<InstalledBuild[]> {
  const roots = await findBlenderRoots(pickedDir)
  if (roots.length === 0) throw new Error('No Blender executable found in this folder')
  const managedRoot = resolve(managedInstallsDir)
  const outside = roots.filter((hit) => !isInside(managedRoot, hit.root))
  if (outside.length === 0) return []

  const addedAt = new Date().toISOString()
  const detections = (
    await mapLimit(outside, 4, async (hit): Promise<LocatedInstall | null> => {
      try {
        const detected = await detectBuild(join(hit.root, hit.executableRelative))
        return { path: hit.root, executableRelative: hit.executableRelative, ...detected, addedAt }
      } catch {
        // an executable named like Blender that does not answer --version
        return null
      }
    })
  ).filter((entry): entry is LocatedInstall => entry !== null)
  if (detections.length === 0) {
    throw new Error(`Found ${outside.length} Blender-like folder(s), but none of them responded as Blender`)
  }

  const newPaths = new Set(detections.map((entry) => entry.path))
  await updateConfig((config) => ({
    ...config,
    locatedInstalls: [...detections, ...config.locatedInstalls.filter((known) => !newPaths.has(known.path))]
  }))
  return detections.map(toInstalledBuild)
}

export async function listLocated(): Promise<InstalledBuild[]> {
  const config = await readConfig()
  const result: InstalledBuild[] = []
  for (const entry of config.locatedInstalls) {
    if (await exists(join(entry.path, entry.executableRelative))) {
      result.push(toInstalledBuild(entry))
    }
  }
  return result
}

export async function removeLocated(path: string): Promise<void> {
  await updateConfig((config) => ({
    ...config,
    locatedInstalls: config.locatedInstalls.filter((entry) => entry.path !== path)
  }))
}
