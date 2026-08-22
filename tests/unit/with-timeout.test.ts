/**
 * Unit tests for lib/push/with-timeout.ts.
 *
 * Built for the "Enable notifications" hang (dev job 61f62c08): pushManager
 * .subscribe() can stall forever with no reject path, leaving the button
 * spinning and the user with zero feedback. withTimeout() is the guard —
 * these tests pin the three behaviors that guard depends on: a fast promise
 * still wins normally, a slow one times out with a clear error, and a late
 * resolution/rejection after timeout is reported via onLateSettle rather than
 * silently swallowed (the caller uses that to avoid leaving an orphaned
 * subscription the server was never told about).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest"
import { withTimeout } from "@/lib/push/with-timeout"

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe("withTimeout", () => {
  it("resolves with the original value when it settles before the deadline", async () => {
    const p = withTimeout(Promise.resolve("ok"), 1000)
    await expect(p).resolves.toBe("ok")
  })

  it("rejects with the original reason when it fails before the deadline", async () => {
    const p = withTimeout(Promise.reject(new Error("boom")), 1000)
    await expect(p).rejects.toThrow("boom")
  })

  it("rejects with a timeout error once the deadline passes, before the promise settles", async () => {
    let releaseInner: (() => void) | undefined
    const inner = new Promise<string>((resolve) => {
      releaseInner = () => resolve("late")
    })

    const guarded = withTimeout(inner, 1000)
    const assertion = expect(guarded).rejects.toThrow("timeout")

    await vi.advanceTimersByTimeAsync(1000)
    await assertion

    // Clean up the still-pending inner promise so it doesn't leak into the
    // next test as an unhandled rejection/dangling timer.
    releaseInner?.()
  })

  it("reports a late fulfillment via onLateSettle instead of silently dropping it", async () => {
    let releaseInner: ((value: string) => void) | undefined
    const inner = new Promise<string>((resolve) => {
      releaseInner = resolve
    })
    const onLateSettle = vi.fn()

    const guarded = withTimeout(inner, 1000, onLateSettle)
    const assertion = expect(guarded).rejects.toThrow("timeout")
    await vi.advanceTimersByTimeAsync(1000)
    await assertion

    expect(onLateSettle).not.toHaveBeenCalled()
    releaseInner?.("arrived-late")
    await vi.waitFor(() => {
      expect(onLateSettle).toHaveBeenCalledWith({ status: "fulfilled", value: "arrived-late" })
    })
  })

  it("reports a late rejection via onLateSettle instead of an unhandled rejection", async () => {
    let releaseInner: ((reason: unknown) => void) | undefined
    const inner = new Promise<string>((_resolve, reject) => {
      releaseInner = reject
    })
    const onLateSettle = vi.fn()

    const guarded = withTimeout(inner, 1000, onLateSettle)
    const assertion = expect(guarded).rejects.toThrow("timeout")
    await vi.advanceTimersByTimeAsync(1000)
    await assertion

    const lateError = new Error("late failure")
    releaseInner?.(lateError)
    await vi.waitFor(() => {
      expect(onLateSettle).toHaveBeenCalledWith({ status: "rejected", reason: lateError })
    })
  })

  it("never fires the timeout once the promise has already resolved", async () => {
    const p = withTimeout(Promise.resolve("fast"), 1000)
    await expect(p).resolves.toBe("fast")
    // Advancing time after resolution must not throw or reject anything —
    // the internal timer should already be cleared.
    await vi.advanceTimersByTimeAsync(5000)
  })
})
