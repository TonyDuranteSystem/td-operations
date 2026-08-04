/**
 * Transient upstream failures, and what a staff member should be told about them.
 *
 * WHY THIS EXISTS (td-bug 2026-08-03, Luca). The worker loop threw on ANY non-ok
 * response from the model API and the route handed that message straight to the
 * panel, so staff saw, verbatim and twice in a row:
 *
 *   ⚠️ Claude API error 529: {"type":"error","error":{"type":"overloaded_error",...
 *
 * Two separate failures in one. First, there was no retry ANYWHERE in the worker
 * — a momentary overload discarded the whole turn, including every tool call the
 * loop had already completed. Second, the raw text made a transient provider
 * hiccup indistinguishable from a broken attachment: Luca had just uploaded a
 * spreadsheet, so he reasonably read it as "the file is the problem" and spent
 * days converting formats that were never at fault.
 *
 * Pure and dependency-free so the retry policy is unit-testable without a network.
 */

/** Statuses worth trying again: the request was fine, the far side wasn't. */
export function isTransientStatus(status: number): boolean {
  // 429 rate limit · 500/502/503/504 upstream/gateway · 529 provider overloaded.
  return status === 429 || status === 500 || status === 502 || status === 503 || status === 504 || status === 529
}

/** Most retries per model call. Bounded by the loop's wall-clock budget too. */
export const MAX_TRANSIENT_RETRIES = 3

/**
 * How long to wait before retry `attempt` (1-based).
 *
 * Deterministic on purpose — a random jitter would make the policy untestable
 * for the sake of thundering-herd protection we do not need at this volume.
 * Honours `Retry-After` when the provider sends one (seconds, or an HTTP date),
 * clamped so a hostile or absurd value cannot park a request past its deadline.
 */
export function retryDelayMs(attempt: number, retryAfterHeader?: string | null): number {
  const backoff = Math.min(1000 * 2 ** Math.max(0, attempt - 1), 8000) // 1s, 2s, 4s, capped 8s
  if (!retryAfterHeader) return backoff
  const seconds = Number(retryAfterHeader)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 10_000)
  const asDate = Date.parse(retryAfterHeader)
  if (Number.isFinite(asDate)) {
    const wait = asDate - Date.now()
    if (wait > 0) return Math.min(wait, 10_000)
    return 0
  }
  return backoff
}

/** Would another attempt still fit inside the turn's remaining time? */
export function canRetryWithin(elapsedMs: number, budgetMs: number, delayMs: number): boolean {
  // Leave room for the retried call itself to do something useful, not just start.
  const MIN_USEFUL_CALL_MS = 15_000
  return elapsedMs + delayMs + MIN_USEFUL_CALL_MS < budgetMs
}

/**
 * A sentence a staff member can act on, instead of a raw provider payload.
 *
 * The rule that matters: NEVER let a transient failure read as a problem with
 * the file the person just uploaded. That mistaken attribution is the actual
 * damage this function exists to prevent — it cost Luca several days.
 */
export function explainWorkerFailure(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err ?? "")

  // Our own abort (the per-call timeout shrinking against the wall clock).
  if (/abort/i.test(msg)) {
    return "That took too long and I had to stop before finishing. Nothing was changed. Ask me again — and if the question covers a lot of ground, splitting it in two usually gets through."
  }

  const status = Number(msg.match(/\b(4\d\d|5\d\d)\b/)?.[1] ?? NaN)

  if (status === 529 || /overloaded/i.test(msg)) {
    return "The AI service was momentarily overloaded and didn't answer, even after I retried. This is on their side, not yours — nothing is wrong with anything you sent. Please try again in a minute."
  }
  if (status === 429 || /rate.?limit/i.test(msg)) {
    return "We've hit the AI service's rate limit for the moment, even after I retried. Nothing is wrong with anything you sent. Please try again shortly."
  }
  if (status === 401 || status === 403) {
    return "I couldn't authenticate with the AI service, so this needs a look at our configuration rather than anything you did. Please flag it."
  }
  if (/prompt is too long|request too large|request_too_large|exceeds? the maximum/i.test(msg)) {
    return "This turn was too large for the AI service to accept — usually a very long file or a long conversation. Try starting a fresh conversation, or asking about one file at a time."
  }
  if (Number.isFinite(status) && status >= 500) {
    return "The AI service had a problem on its side and didn't answer, even after I retried. Nothing is wrong with anything you sent. Please try again in a minute."
  }

  return "Something went wrong and I couldn't finish this. Nothing was changed. Please try again, and flag it if it keeps happening."
}
