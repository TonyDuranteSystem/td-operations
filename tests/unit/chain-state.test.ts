/**
 * Chain state machine (Phase 3R amendment v2) — the ONE pure brain the
 * watchdog (acts) and the GETs (render) both consult. Time-travel pattern:
 * `now` injected, no clock mocking.
 */
import { describe, it, expect } from 'vitest'
import {
  decideChainState,
  decideChunkFollowup,
  AI_CHAIN_BACKOFF_MS,
  AI_CHAIN_CHUNK_CAP,
} from '@/lib/jobs/chain-state'

const NOW = Date.parse('2026-07-04T12:00:00Z')
const terminal = (minsAgo: number, auto_retry: number) => ({
  completed_at: new Date(NOW - minsAgo * 60_000).toISOString(),
  auto_retry,
})

describe('decideChunkFollowup — the relay decision', () => {
  it('deadline-stop WITH progress → continue (baton pass)', () => {
    expect(decideChunkFollowup({ stoppedOnDeadline: true, batchesSent: 6, batchesFailed: 0, progressed: true, chunkIndex: 3 })).toBe('continue')
  })
  it('finished with progress → done', () => {
    expect(decideChunkFollowup({ stoppedOnDeadline: false, batchesSent: 4, batchesFailed: 0, progressed: true, chunkIndex: 3 })).toBe('done')
  })
  it('zero progress ends the chain — kill-switch (0 batches), dead API (all failed), and a deadline-stop that DID attempt batches', () => {
    expect(decideChunkFollowup({ stoppedOnDeadline: false, batchesSent: 0, batchesFailed: 0, progressed: false, chunkIndex: 0 })).toBe('halt_no_progress')
    expect(decideChunkFollowup({ stoppedOnDeadline: false, batchesSent: 6, batchesFailed: 6, progressed: false, chunkIndex: 2 })).toBe('halt_no_progress')
    expect(decideChunkFollowup({ stoppedOnDeadline: true, batchesSent: 3, batchesFailed: 3, progressed: false, chunkIndex: 1 })).toBe('halt_no_progress')
  })

  // Prod incident 2026-07-05: re-Generate on a fully-hinted workspace found
  // NOTHING to send — that is a FINISHED chain, never a no-progress failure
  // (the old logic failed the job and burned the watchdog ladder on it).
  it('no candidates → done, not halt', () => {
    expect(decideChunkFollowup({ stoppedOnDeadline: false, batchesSent: 0, batchesFailed: 0, progressed: false, chunkIndex: 0, noCandidates: true })).toBe('done')
    expect(decideChunkFollowup({ stoppedOnDeadline: false, batchesSent: 0, batchesFailed: 0, progressed: false, chunkIndex: 5, noCandidates: true })).toBe('done')
  })

  // Prod incident, first live chain (2026-07-04): chunk claimed 203s into a
  // busy cron window → deadline guard refused the first batch → old logic
  // read "no progress" and tripped the breaker. No time is not no progress.
  it('LATE CLAIM: deadline-stop with ZERO batches attempted passes the baton, never halts', () => {
    expect(decideChunkFollowup({ stoppedOnDeadline: true, batchesSent: 0, batchesFailed: 0, progressed: false, chunkIndex: 5 })).toBe('continue')
  })
  it('chunk cap halts even a progressing chain (cost bound, rendered distinctly)', () => {
    expect(decideChunkFollowup({ stoppedOnDeadline: true, batchesSent: 6, batchesFailed: 0, progressed: true, chunkIndex: AI_CHAIN_CHUNK_CAP })).toBe('halt_cap')
  })
})

describe('decideChainState — watchdog and UI can never disagree', () => {
  it('a live job → running (ProgressCard, no watchdog action)', () => {
    expect(decideChainState({ liveJobs: 1, candidatesRemaining: 500, lastTerminal: terminal(1, 0), killSwitchOn: false, now: NOW }))
      .toEqual({ state: 'running' })
  })

  it('work remains + no live job + ladder unspent → retry_scheduled at completed_at + backoff', () => {
    const s = decideChainState({ liveJobs: 0, candidatesRemaining: 500, lastTerminal: terminal(5, 0), killSwitchOn: false, now: NOW })
    expect(s.state).toBe('retry_scheduled')
    if (s.state === 'retry_scheduled') {
      expect(s.nextRetryAt).toBe(NOW - 5 * 60_000 + AI_CHAIN_BACKOFF_MS[0])
      expect(s.autoRetry).toBe(0)
    }
  })

  it('each ladder step waits longer; step N uses backoff[N]', () => {
    const s = decideChainState({ liveJobs: 0, candidatesRemaining: 100, lastTerminal: terminal(0, 3), killSwitchOn: false, now: NOW })
    expect(s.state).toBe('retry_scheduled')
    if (s.state === 'retry_scheduled') expect(s.nextRetryAt).toBe(NOW + AI_CHAIN_BACKOFF_MS[3])
  })

  it('ladder spent → exhausted (staff alerted proactively — never a manual Resume)', () => {
    expect(decideChainState({ liveJobs: 0, candidatesRemaining: 100, lastTerminal: terminal(60, AI_CHAIN_BACKOFF_MS.length), killSwitchOn: false, now: NOW }))
      .toEqual({ state: 'exhausted' })
  })

  it('no candidates left → idle, regardless of history', () => {
    expect(decideChainState({ liveJobs: 0, candidatesRemaining: 0, lastTerminal: terminal(1, 4), killSwitchOn: false, now: NOW }))
      .toEqual({ state: 'idle' })
  })

  it('no AI history for the scope → idle (the watchdog never starts chains on its own)', () => {
    expect(decideChainState({ liveJobs: 0, candidatesRemaining: 900, lastTerminal: null, killSwitchOn: false, now: NOW }))
      .toEqual({ state: 'idle' })
  })

  it('kill switch suppresses the watchdog entirely', () => {
    expect(decideChainState({ liveJobs: 0, candidatesRemaining: 900, lastTerminal: terminal(5, 0), killSwitchOn: true, now: NOW }))
      .toEqual({ state: 'idle' })
  })
})
