/**
 * Holding a message briefly so a mistyped Enter can be caught.
 *
 * Antonio, 2026-07-19: "sometimes maybe I can make a mistake by clicking Return too
 * early, and I want to stop and maybe reformulate the question."
 *
 * The property that matters: cancelling during the hold means the message is NEVER
 * sent — not "probably not sent". That is why the hold exists client-side, before
 * anything reaches the server: aborting a request that is already running would leave
 * the server free to finish, and if the message was "send it" the client would already
 * have been emailed. A stop that cannot stop is the exact class of lie this codebase
 * has spent the day removing.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { HoldController, HOLD_MS } from '@/components/chat/hold-controller'

/** Build a controller with a spy send, mirroring how the hook wires it. */
function make<T>(holdMs?: number) {
  const send = vi.fn()
  const c = new HoldController<T>({ send }, holdMs)
  return { c, send }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('HoldController', () => {
  it('does not send while the hold is running', () => {
    const { c, send } = make<string>()
    c.arm('hello')
    expect(c.armed).toBe(true)
    vi.advanceTimersByTime(HOLD_MS - 100)
    expect(send).not.toHaveBeenCalled()
  })

  it('sends once the hold expires', () => {
    const { c, send } = make<string>()
    c.arm('hello')
    vi.advanceTimersByTime(HOLD_MS)
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith('hello')
    expect(c.armed).toBe(false)
  })

  it('THE POINT: cancelling means it is never sent, even after the time passes', () => {
    const { c, send } = make<string>()
    c.arm('half-typed question')
    vi.advanceTimersByTime(1000)
    c.cancel()
    expect(c.armed).toBe(false)
    // Run well past the original deadline — a stale timer must not resurrect it.
    vi.advanceTimersByTime(HOLD_MS * 3)
    expect(send).not.toHaveBeenCalled()
  })

  it('a second arm fires immediately — the "I am sure" path costs no wait', () => {
    const { c, send } = make<string>()
    c.arm('first')
    expect(send).not.toHaveBeenCalled()
    c.arm('second')
    expect(send).toHaveBeenCalledTimes(1)
    // The newest text wins — the staff member may have kept typing before confirming.
    expect(send).toHaveBeenCalledWith('second')
  })

  it('counts down and never shows 0 while the message is still catchable', () => {
    const { c } = make<string>()
    c.arm('x')
    expect(c.secondsLeft).toBe(HOLD_MS / 1000)
    vi.advanceTimersByTime(HOLD_MS - 200)
    // Showing "0s" would read as gone while it is still stoppable.
    expect(c.secondsLeft).toBeGreaterThanOrEqual(1)
  })

  it('can be armed again after a cancel — one mistake does not disable sending', () => {
    const { c, send } = make<string>()
    c.arm('oops')
    c.cancel()
    c.arm('the real question')
    vi.advanceTimersByTime(HOLD_MS)
    expect(send).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledWith('the real question')
  })

  it('sends nothing after dispose — a closed panel must not fire a held message', () => {
    const { c, send } = make<string>()
    c.arm('held')
    c.dispose()
    vi.advanceTimersByTime(HOLD_MS * 2)
    expect(send).not.toHaveBeenCalled()
  })

  it('honours a custom hold length', () => {
    const { c, send } = make<string>(1000)
    c.arm('quick')
    vi.advanceTimersByTime(999)
    expect(send).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(send).toHaveBeenCalledTimes(1)
  })
})
