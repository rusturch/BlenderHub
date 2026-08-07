// One launcher-wide lock for heavy operations that launch headless Blender and/or
// rewrite per-version user config (add-on applies, settings sync). Two such operations
// at once could interleave a preferences save with a file copy, so they exclude each
// other — inside one operation, work still parallelizes across Blender minors (each
// minor owns its own config dir).
let busyLabel: string | null = null

/** peek for background jobs that must never contend for the lock with user actions */
export function opLockBusy(): boolean {
  return busyLabel !== null
}

export async function withExclusiveOp<T>(label: string, task: () => Promise<T>): Promise<T> {
  if (busyLabel) {
    throw new Error(`Another ${busyLabel} operation is already running — wait for it to finish`)
  }
  busyLabel = label
  try {
    return await task()
  } finally {
    busyLabel = null
  }
}
