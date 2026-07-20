// Node's fetch answers every transport failure with a bare "fetch failed" and keeps the
// real reason in `cause` — which does not survive the trip over IPC, so the UI ends up
// showing "TypeError: fetch failed" and nothing else. These helpers unwrap that reason and
// put a deadline on requests that would otherwise hang until the socket gives up.

const REQUEST_TIMEOUT_MS = 20_000

function networkReason(error: unknown): string | null {
  const cause = error instanceof Error ? (error.cause as { code?: unknown; message?: unknown } | undefined) : undefined
  if (typeof cause?.code === 'string' && cause.code) return cause.code
  if (typeof cause?.message === 'string' && cause.message) return cause.message
  return null
}

/** GET with a deadline; transport failures name the host and the underlying reason */
export async function httpGet(url: string, label: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) })
  } catch (error) {
    // a timeout arrives as an AbortError, not as a cause-carrying fetch failure
    if (error instanceof Error && error.name === 'TimeoutError') {
      throw new Error(`${label} did not respond within ${REQUEST_TIMEOUT_MS / 1000}s`)
    }
    const reason = networkReason(error)
    throw new Error(reason ? `${label} is unreachable (${reason})` : `${label} is unreachable`)
  }
}
