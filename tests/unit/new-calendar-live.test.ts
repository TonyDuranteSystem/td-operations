import { describe, it, expect } from "vitest"
import { LIVE_DEBOUNCE_MS, LIVE_MAX_WAIT_MS, LIVE_POLL_MS, isJobsEvent, refreshDelay } from "@/lib/new-calendar/live"
import { isWindowLinkClick } from "@/lib/windows/open-intent"

/** The Calendar updates by itself (dev job 40235e3c): the pure timing rules and the click rule of the workspace window link. */

describe("isJobsEvent", () => {
  it("is true only for the job-change event, whatever else arrives", () => {
    expect(isJobsEvent({ kind: "jobs", payload: null })).toBe(true)
    expect(isJobsEvent({ kind: "jobs" })).toBe(true)
    for (const v of [null, undefined, "jobs", 3, [], {}, { kind: "tasks" }, { kind: "JOBS" }, { kind: ["jobs"] }]) expect(isJobsEvent(v), JSON.stringify(v)).toBe(false)
  })
})

describe("refreshDelay: a burst of changes becomes ONE refresh", () => {
  it("the first signal waits the debounce time", () => {
    expect(refreshDelay(1_000, null)).toBe(LIVE_DEBOUNCE_MS)
  })

  it("a later signal restarts the debounce, but never past the burst's max wait", () => {
    expect(refreshDelay(1_500, 1_000)).toBe(LIVE_DEBOUNCE_MS)
    // 3.5 s into a burst: only 0.5 s of the 4 s budget is left
    expect(refreshDelay(4_500, 1_000)).toBe(LIVE_MAX_WAIT_MS - 3_500)
  })

  it("at or past the max wait it refreshes at once; a clock that went backwards never gives a negative or huge wait", () => {
    expect(refreshDelay(1_000 + LIVE_MAX_WAIT_MS, 1_000)).toBe(0)
    expect(refreshDelay(1_000 + LIVE_MAX_WAIT_MS + 5_000, 1_000)).toBe(0)
    expect(refreshDelay(500, 1_000)).toBe(LIVE_DEBOUNCE_MS)
  })

  it("the numbers are sane: about a second to react, a bounded wait, a minute for the safety poll", () => {
    expect(LIVE_DEBOUNCE_MS).toBeLessThanOrEqual(1_000)
    expect(LIVE_MAX_WAIT_MS).toBeGreaterThan(LIVE_DEBOUNCE_MS)
    expect(LIVE_POLL_MS).toBeGreaterThanOrEqual(30_000)
  })
})

describe("isWindowLinkClick (the workspace window link)", () => {
  it("a plain left click and Option/Alt + click open the window", () => {
    expect(isWindowLinkClick({ button: 0 })).toBe(true)
    expect(isWindowLinkClick({})).toBe(true)
    expect(isWindowLinkClick({ button: 0, altKey: true })).toBe(true)
  })

  it("Cmd/Ctrl-click (new tab), Shift-click (new browser window) and middle/right clicks stay the browser's own", () => {
    expect(isWindowLinkClick({ button: 0, metaKey: true })).toBe(false)
    expect(isWindowLinkClick({ button: 0, ctrlKey: true })).toBe(false)
    expect(isWindowLinkClick({ button: 0, shiftKey: true })).toBe(false)
    expect(isWindowLinkClick({ button: 1 })).toBe(false)
    expect(isWindowLinkClick({ button: 2 })).toBe(false)
  })
})
