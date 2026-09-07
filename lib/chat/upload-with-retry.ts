/**
 * Shared network-retry wrapper for direct-to-Storage chat attachment uploads
 * (team chat today; portal chat is meant to adopt the same primitive rather
 * than re-implementing it — see docs/systems/team-workspace.md).
 *
 * Root cause of the bug this closes (2026-09-01, dev job 62a64f2b child):
 * the original retry (commit ed51c8f7) reacted only to a THROWN fetch error,
 * with no per-attempt deadline. A stalled connection (as opposed to one that
 * errors immediately) never throws — it just hangs — so the retry never
 * fired and the caller's `uploading` state was stuck true forever, which
 * disables Send entirely. Wrapping every attempt in its own AbortController
 * timeout converts a hang into a thrown error the retry loop can act on, so
 * total wall-clock time is actually bounded as intended.
 */

export interface RetryOptions {
  /** Total attempts, including the first. */
  attempts?: number
  /** Hard per-attempt deadline — a stalled (non-erroring) request is aborted
   *  after this long so it counts as a retryable failure instead of a hang. */
  attemptTimeoutMs?: number
  /** Backoff base — attempt N waits min(baseDelayMs * N, maxDelayMs) before
   *  the next try. */
  baseDelayMs?: number
  maxDelayMs?: number
}

const DEFAULT_OPTIONS: Required<RetryOptions> = {
  attempts: 4,
  attemptTimeoutMs: 6000,
  baseDelayMs: 1000,
  maxDelayMs: 4000,
}

/**
 * A network-level fetch failure (thrown TypeError — connection dropped, DNS
 * blip, momentary offline — or our own timeout abort) is usually gone a
 * second later. Retries ONLY that case — a completed response with a bad
 * status (413, a JSON error body, etc.) is a real answer from the server and
 * is NOT retried here; the caller still handles those exactly as before.
 *
 * Worst-case wall-clock with the defaults: 4 attempts * up to 6s each
 * (24s) + backoff of 1s+2s+3s between them (6s) = up to ~30s before the
 * caller sees a final thrown error — most real blips resolve far sooner
 * since a fetch that fails outright (rather than stalling) throws almost
 * immediately.
 */
export async function fetchWithNetworkRetry(
  input: string,
  init: RequestInit,
  options: RetryOptions = {},
): Promise<Response> {
  const { attempts, attemptTimeoutMs, baseDelayMs, maxDelayMs } = {
    ...DEFAULT_OPTIONS,
    ...options,
  }

  for (let attempt = 1; attempt <= attempts; attempt++) {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), attemptTimeoutMs)
    try {
      const res = await fetch(input, { ...init, signal: controller.signal })
      clearTimeout(timeoutId)
      return res
    } catch (err) {
      clearTimeout(timeoutId)
      if (attempt === attempts) throw err
      const delay = Math.min(baseDelayMs * attempt, maxDelayMs)
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
  }
  // Unreachable — the loop above always returns or throws on its last attempt.
  throw new Error('Upload failed. Please check your connection and try again.')
}
