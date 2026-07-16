import { execFile } from 'child_process'
import { cpus } from 'os'
import { mkdir, writeFile } from 'fs/promises'
import { join } from 'path'
import { getRuntimeRoot } from '../paths'

// Shared plumbing for headless Blender runs. Our python scripts frame their JSON
// output with these markers so it survives whatever else Blender prints to stdout.
export const MARK_START = '<<<BHUB_ADDONS>>>'
export const MARK_END = '<<<BHUB_END>>>'

/** write a helper file (python script / json payload) into the per-machine runtime dir */
export async function writeDataFile(name: string, content: string): Promise<string> {
  const root = getRuntimeRoot()
  await mkdir(root, { recursive: true })
  const filePath = join(root, name)
  await writeFile(filePath, content)
  return filePath
}

// Our python scripts are compile-time constants, so each needs writing only once per app
// run. Memoizing also makes concurrent runs safe: parallel tasks would otherwise re-truncate
// the same file while another Blender is reading it.
const scriptCache = new Map<string, Promise<string>>()
export function ensureScript(name: string, content: string): Promise<string> {
  let cached = scriptCache.get(name)
  if (!cached) {
    cached = writeDataFile(name, content)
    scriptCache.set(name, cached)
  }
  return cached
}

// How many headless Blenders may run at once. Each Blender version keeps its own config
// dir (its own userpref.blend), so runs for DIFFERENT versions never race each other —
// callers must still keep same-version work sequential. Startup is CPU/disk heavy
// (~0.5-1 GB RAM each), so cap well below the core count.
export const BLENDER_POOL = Math.max(1, Math.min(4, cpus().length - 1))

/** run `task` over `items` with at most `limit` in flight; results keep the input order */
export async function mapPool<T, R>(
  items: T[],
  limit: number,
  task: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (true) {
      const index = next++
      if (index >= items.length) return
      results[index] = await task(items[index], index)
    }
  })
  await Promise.all(workers)
  return results
}

interface RunOptions {
  env?: Record<string, string>
  timeoutMs?: number
  /** message used when Blender fails without a framed error on stderr */
  failMessage?: string
}

export function runBlenderScript(
  executable: string,
  args: string[],
  options: RunOptions = {}
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      executable,
      args,
      {
        timeout: options.timeoutMs ?? 60_000,
        windowsHide: true,
        maxBuffer: 32 * 1024 * 1024,
        env: options.env ? { ...process.env, ...options.env } : process.env
      },
      (error, stdout, stderr) => {
        if (error) {
          const framed = /<<<BHUB_ERROR>>>([\s\S]*?)<<<BHUB_END>>>/.exec(stderr)?.[1]?.trim()
          const stderrLine = stderr
            .split('\n')
            .map((line) => line.trim())
            .find((line) => line.length > 0)
          reject(new Error(framed || options.failMessage || stderrLine || error.message))
          return
        }
        resolve(stdout)
      }
    )
  })
}

/** pull the JSON payload our python framed between the markers */
export function extractMarked(stdout: string): string {
  const start = stdout.indexOf(MARK_START)
  const end = stdout.indexOf(MARK_END, start)
  if (start === -1 || end === -1) throw new Error('Unexpected output from Blender')
  return stdout.slice(start + MARK_START.length, end)
}
