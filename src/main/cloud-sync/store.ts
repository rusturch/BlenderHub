import { mkdir, readFile, rename, writeFile } from 'fs/promises'
import { join } from 'path'
import { sanitizeLibraryEntries } from '../../shared/cloud-sync'
import type { LibraryAddon } from '../../shared/types'
import { getDataRoot } from '../paths'
import { machineTag } from './machine'

// Per-machine sync bookkeeping: what generation/hash of each item this machine
// last agreed with the cloud on, plus the last full ui-state payload it pulled
// (kept for carry-through so a key added by a newer client isn't dropped when an
// older client rewrites the item). Per-machine filename for the same reason as
// the token file — data/ may be Dropbox-synced and a shared state file would lie
// to the other machine about what it had already uploaded.

export interface ItemSyncRecord {
  lastSyncedGeneration: number
  lastSyncedSha256: string
}

export interface CloudSyncState {
  /** keyed by itemId */
  items: Record<string, ItemSyncRecord>
  /** last full ui-state payload pulled from cloud, for push carry-through */
  lastPulledUiState?: Record<string, string>
  /** library entry ids of THIS machine already reflected in the cloud — the merge base */
  libraryPrevLocal?: string[]
  /** last cloud library index this machine saw (avoids refetching an unchanged item) */
  lastPulledLibrary?: LibraryAddon[]
  /** cloud data epoch this machine last reconciled against */
  dataEpoch: string
  /** whether the first-link resolution has run for the current connection */
  linked: boolean
}

const EMPTY: CloudSyncState = { items: {}, dataEpoch: '', linked: false }

const statePath = (): string => join(getDataRoot(), `cloud-sync-state.${machineTag()}.json`)

export async function readSyncState(): Promise<CloudSyncState> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(statePath(), 'utf8'))
  } catch {
    return { ...EMPTY }
  }
  if (!parsed || typeof parsed !== 'object') return { ...EMPTY }
  const raw = parsed as Record<string, unknown>
  const items: Record<string, ItemSyncRecord> = {}
  if (raw.items && typeof raw.items === 'object') {
    for (const [key, value] of Object.entries(raw.items as Record<string, unknown>)) {
      const record = value as Record<string, unknown>
      if (typeof record?.lastSyncedGeneration === 'number' && typeof record?.lastSyncedSha256 === 'string') {
        items[key] = {
          lastSyncedGeneration: record.lastSyncedGeneration,
          lastSyncedSha256: record.lastSyncedSha256
        }
      }
    }
  }
  const lastPulled =
    raw.lastPulledUiState && typeof raw.lastPulledUiState === 'object'
      ? (raw.lastPulledUiState as Record<string, string>)
      : undefined
  const libraryPrevLocal = Array.isArray(raw.libraryPrevLocal)
    ? (raw.libraryPrevLocal as unknown[]).filter((key): key is string => typeof key === 'string').slice(0, 600)
    : undefined
  const lastPulledLibrary = raw.lastPulledLibrary !== undefined ? sanitizeLibraryEntries(raw.lastPulledLibrary) : undefined
  return {
    items,
    lastPulledUiState: lastPulled,
    libraryPrevLocal,
    lastPulledLibrary,
    dataEpoch: typeof raw.dataEpoch === 'string' ? raw.dataEpoch : '',
    linked: raw.linked === true
  }
}

let writeQueue: Promise<unknown> = Promise.resolve()
let rawFields: Record<string, unknown> = {}

export function updateSyncState(patch: (state: CloudSyncState) => CloudSyncState): Promise<CloudSyncState> {
  const run = writeQueue.then(async () => {
    const current = await readSyncState()
    // preserve unknown top-level fields written by a newer version
    try {
      rawFields = JSON.parse(await readFile(statePath(), 'utf8'))
    } catch {
      rawFields = {}
    }
    const next = patch(current)
    await mkdir(getDataRoot(), { recursive: true })
    const target = statePath()
    await writeFile(
      `${target}.tmp`,
      JSON.stringify(
        {
          ...rawFields,
          items: next.items,
          lastPulledUiState: next.lastPulledUiState,
          libraryPrevLocal: next.libraryPrevLocal,
          lastPulledLibrary: next.lastPulledLibrary,
          // retired fields from the 0.6.0 installed-builds sync: force-dropped
          // so stale merge bases can't linger in the per-machine state file
          installsPrevLocal: undefined,
          lastPulledInstalls: undefined,
          dataEpoch: next.dataEpoch,
          linked: next.linked
        },
        null,
        2
      )
    )
    await rename(`${target}.tmp`, target)
    return next
  })
  writeQueue = run.catch(() => {})
  return run
}

/** wipe local bookkeeping on disconnect or a server dataEpoch change. */
export async function resetSyncState(): Promise<void> {
  await updateSyncState(() => ({ ...EMPTY }))
}
