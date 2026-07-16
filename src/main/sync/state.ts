import { mkdir, readFile, rename, writeFile } from 'fs/promises'
import { join } from 'path'
import { getDataRoot } from '../paths'
import type { SyncComponentId, SyncLinks } from '../../shared/types'
import type { PrefsProfile } from '../addons/userpref-parser'
import type { FileStamp } from './components'

// Persistent sync state, separate from config.json: the links (which cells follow the
// source) and the baselines (fingerprints of both sides taken at the last successful
// sync — drift detection compares against them). Self-contained file, atomic writes.

export interface BaselineEntry {
  /** fingerprint of the source component at the last sync */
  source: string
  /** fingerprint of the target component right after the last sync (post-fixup) */
  target: string
  syncedAt: string
  /** dir components: file manifests for "what exactly changed" summaries (null when too big) */
  sourceFiles: FileStamp[] | null
  targetFiles: FileStamp[] | null
  /** preferences cells: parsed profiles for exact "what changed" summaries */
  sourcePrefs?: PrefsProfile
  targetPrefs?: PrefsProfile
  /** bookmarks cells: entries of the [Bookmarks] section for exact diffs */
  sourceLines?: string[]
  targetLines?: string[]
}

export interface SyncState {
  links: SyncLinks
  /**
   * Sync points PER SOURCE (outer key = source minor): switching the source keeps
   * every source's history, so switching back restores the in-sync states.
   */
  baselines: Record<string, Record<string, BaselineEntry>>
}

export const baselineKey = (minor: string, component: SyncComponentId): string => `${minor}:${component}`

const statePath = (): string => join(getDataRoot(), 'sync-state.json')

const emptyState = (): SyncState => ({ links: { sourceMinor: null, cells: {} }, baselines: {} })

export async function readSyncState(): Promise<SyncState> {
  try {
    const parsed = JSON.parse(await readFile(statePath(), 'utf8')) as Partial<SyncState>
    const links = parsed.links
    const sourceMinor = typeof links?.sourceMinor === 'string' ? links.sourceMinor : null
    const rawBaselines =
      parsed.baselines && typeof parsed.baselines === 'object'
        ? (parsed.baselines as Record<string, unknown>)
        : {}
    // v1 stored one flat cell→entry map (entries have a string `source` hash);
    // v2 nests those maps per source minor — migrate v1 under the current source
    const values = Object.values(rawBaselines)
    const isFlat = values.length > 0 && typeof (values[0] as { source?: unknown })?.source === 'string'
    const baselines = isFlat
      ? sourceMinor
        ? { [sourceMinor]: rawBaselines as Record<string, BaselineEntry> }
        : {}
      : (rawBaselines as Record<string, Record<string, BaselineEntry>>)
    return {
      links: {
        sourceMinor,
        cells:
          links?.cells && typeof links.cells === 'object'
            ? (links.cells as Record<string, SyncComponentId[]>)
            : {}
      },
      baselines
    }
  } catch {
    return emptyState() // missing or corrupt state never breaks the page
  }
}

// serialized read-modify-write, atomic on disk (same idiom as config.ts)
let writeQueue: Promise<unknown> = Promise.resolve()

export function updateSyncState(patch: (state: SyncState) => SyncState): Promise<SyncState> {
  const task = writeQueue.then(async () => {
    const next = patch(await readSyncState())
    await mkdir(getDataRoot(), { recursive: true })
    const target = statePath()
    await writeFile(`${target}.tmp`, JSON.stringify(next, null, 2))
    await rename(`${target}.tmp`, target)
    return next
  })
  writeQueue = task.catch(() => {})
  return task
}
