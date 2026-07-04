/**
 * AI-chain state (Phase 3R — self-healing chains, amendment v2).
 *
 * decideChainState is the ONE pure brain the watchdog (acts) and the GETs
 * (render) both consult — cron and UI can never disagree (review cond. F5).
 * `now` is injected (time-travel test pattern, like decideReminder).
 *
 * States:
 *  - running          → a chunk is pending/processing; ProgressCard shows.
 *  - retry_scheduled  → no live job, candidates remain, ladder not exhausted;
 *                       the watchdog will re-enqueue at nextRetryAt. UI shows
 *                       "continues automatically" — NEVER a manual button.
 *  - exhausted        → ladder spent; watchdog stops; staff ALERTED proactively
 *                       (throttled email + failed-job surfacing). Antonio's
 *                       rule: escalation, not discovery.
 *  - idle             → nothing to do (no candidates, or AI never ran here).
 */

export const AI_CHAIN_CHUNK_CAP = 40
/** Continuations/watchdog inserts claim AFTER client-facing ingest (5). */
export const AI_CHAIN_JOB_PRIORITY = 8
/** Auto-retry ladder after a no-progress/failed chunk (review F4: resets on
 *  any progress; bounds CONSECUTIVE no-progress chains — worst case on a
 *  permanently broken key ≈ 5 chains × ~6 failed calls over ~24h). */
export const AI_CHAIN_BACKOFF_MS: readonly number[] = [
  15 * 60_000, 60 * 60_000, 3 * 3600_000, 6 * 3600_000, 12 * 3600_000,
]

export interface ChainStateInput {
  /** pending + processing AI jobs for the scope (the GET's aiPending). */
  liveJobs: number
  /** Rows the runner's candidate predicate still matches. */
  candidatesRemaining: number
  /** Most recent TERMINAL (completed/failed) AI job for the scope, if any. */
  lastTerminal: { completed_at: string | null; auto_retry: number } | null
  killSwitchOn: boolean
  now: number
}

export type ChainState =
  | { state: "running" }
  | { state: "retry_scheduled"; nextRetryAt: number; autoRetry: number }
  | { state: "exhausted" }
  | { state: "idle" }

export function decideChainState(i: ChainStateInput): ChainState {
  if (i.liveJobs > 0) return { state: "running" }
  if (i.candidatesRemaining <= 0 || !i.lastTerminal || i.killSwitchOn) return { state: "idle" }
  const autoRetry = i.lastTerminal.auto_retry
  if (autoRetry >= AI_CHAIN_BACKOFF_MS.length) return { state: "exhausted" }
  const base = i.lastTerminal.completed_at ? Date.parse(i.lastTerminal.completed_at) : i.now
  return { state: "retry_scheduled", nextRetryAt: base + AI_CHAIN_BACKOFF_MS[autoRetry], autoRetry }
}

/** Chunk outcome → chain action (pure; the handler applies it). */
export function decideChunkFollowup(r: {
  stoppedOnDeadline: boolean
  batchesSent: number
  batchesFailed: number
  progressed: boolean // labeled + applied > 0
  chunkIndex: number
}): "continue" | "done" | "halt_no_progress" | "halt_cap" {
  if (r.chunkIndex >= AI_CHAIN_CHUNK_CAP) return "halt_cap"
  // LATE CLAIM ≠ failure (prod incident, first live chain 2026-07-04): a chunk
  // claimed near the end of a busy runner window (AI runs at priority 8,
  // deliberately last) hits the deadline guard before its FIRST batch. It
  // attempted nothing — pass the baton, don't trip the breaker. Costs no API
  // call and no chunk_index (the handler doesn't increment on zero batches),
  // so it cannot feed a loop: a chunk that actually RUNS batches and persists
  // nothing still halts below.
  if (r.stoppedOnDeadline && r.batchesSent === 0) return "continue"
  // Zero-progress circuit breaker (cond. 3): kill-switch/no-key chunks return
  // zero batches without a deadline stop; dead-API chunks fail every batch.
  // These END the chain — the watchdog ladder owns retries with backoff.
  if (!r.progressed) return "halt_no_progress"
  if (r.stoppedOnDeadline) return "continue"
  return "done"
}
