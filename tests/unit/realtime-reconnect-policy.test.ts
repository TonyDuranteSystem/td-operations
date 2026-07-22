import { describe, it, expect } from 'vitest'
import { nextRetryDelayMs, shouldResync, RESYNC_MIN_INTERVAL_MS } from '@/lib/hooks/use-realtime-channel'

// The React wiring is verified in the browser (this repo's vitest is node-only,
// with no testing-library). These are the two DECISIONS the hook makes, pinned.
describe('nextRetryDelayMs — reconnect backoff', () => {
  it('starts at 1s and doubles', () => {
    expect(nextRetryDelayMs(0)).toBe(1_000)
    expect(nextRetryDelayMs(1)).toBe(2_000)
    expect(nextRetryDelayMs(2)).toBe(4_000)
    expect(nextRetryDelayMs(3)).toBe(8_000)
  })

  it('caps at 30s so a long outage never backs off into never-retrying', () => {
    expect(nextRetryDelayMs(10)).toBe(30_000)
    expect(nextRetryDelayMs(100)).toBe(30_000)
  })

  it('survives an absurd attempt count without returning Infinity or NaN', () => {
    // 2 ** 5000 is Infinity; a timer scheduled with Infinity never fires, which
    // would silently and permanently stop reconnecting.
    const d = nextRetryDelayMs(5_000)
    expect(Number.isFinite(d)).toBe(true)
    expect(d).toBe(30_000)
  })

  it('treats a negative attempt as the base delay', () => {
    expect(nextRetryDelayMs(-1)).toBe(1_000)
  })
})

describe('shouldResync — throttle gate', () => {
  it('allows the first resync', () => {
    expect(shouldResync(0, 1_000_000)).toBe(true)
  })

  it('blocks a second resync inside the window (rapid tab-flipping)', () => {
    const now = 1_000_000
    expect(shouldResync(now, now + 100)).toBe(false)
    expect(shouldResync(now, now + RESYNC_MIN_INTERVAL_MS - 1)).toBe(false)
  })

  it('allows exactly at the boundary', () => {
    const now = 1_000_000
    expect(shouldResync(now, now + RESYNC_MIN_INTERVAL_MS)).toBe(true)
  })

  it('ALWAYS allows a genuine wake after minutes or days asleep', () => {
    const now = 1_000_000
    expect(shouldResync(now, now + 60 * 60 * 1000)).toBe(true)
    expect(shouldResync(now, now + 14 * 24 * 60 * 60 * 1000)).toBe(true)
  })
})
