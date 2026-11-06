import { describe, it, expect } from "vitest"
import { reviewDemoState, reviewDemoLive, reviewDemoFlag, NO_REVIEW_DEMO, REVIEW_DEMO_KEY, REVIEW_DEMO_FROM_KEY, REVIEW_DEMO_TEAM_KEY, REVIEW_DEMO_MAX_DAYS } from "@/lib/auth/review-demo"

const NOW = 1_800_000_000_000
const DAY = 86_400_000
const at = (days: number) => new Date(NOW + days * DAY).toISOString()
/** a practice login's app_metadata: the window starts `from` days from now (default: yesterday) and ends `until` days from now */
const meta = (until: unknown, from: unknown = at(-1)) => ({ role: "marketing", [REVIEW_DEMO_KEY]: until, [REVIEW_DEMO_FROM_KEY]: from })

describe("review-demo: one reading of the flag for the gate and the guard", () => {
  it("none: no flag at all (absent, null, empty, blank)", () => {
    for (const m of [undefined, null, {}, { role: "marketing" }, meta(undefined), meta(null), meta(""), meta("   ")]) expect(reviewDemoState(m, NOW), JSON.stringify(m)).toBe("none")
  })
  it("live: now is inside a window that was written short enough", () => {
    expect(reviewDemoState(meta(at(1)), NOW)).toBe("live")
    expect(reviewDemoState(meta(at(60)), NOW)).toBe("live")
    expect(reviewDemoState(meta(at(REVIEW_DEMO_MAX_DAYS - 1)), NOW)).toBe("live") // from = yesterday, so the window is exactly MAX days
  })
  it("the window length counts from `from`, not from today: a window written too long is never live, now or later", () => {
    expect(reviewDemoState(meta(at(REVIEW_DEMO_MAX_DAYS + 5)), NOW)).toBe("lapsed")
    // the case two reviewers raised: written as a far-future deadline it stays dead, and does not switch itself on as the date approaches
    const farUntil = at(365)
    expect(reviewDemoState(meta(farUntil), NOW)).toBe("lapsed")
    expect(reviewDemoState(meta(farUntil), NOW + 300 * DAY)).toBe("lapsed")
    expect(reviewDemoState(meta(farUntil), NOW + 364 * DAY)).toBe("lapsed")
  })
  it("not started yet, or no start date at all, is not live", () => {
    expect(reviewDemoState(meta(at(30), at(2)), NOW)).toBe("lapsed")
    expect(reviewDemoState({ [REVIEW_DEMO_KEY]: at(30) }, NOW)).toBe("lapsed")
    expect(reviewDemoState(meta(at(30), "yesterday"), NOW)).toBe("lapsed")
  })
  it("lapsed: a flag that is there but not live is dead (past, now, not a date, any other kind of value)", () => {
    for (const v of [at(-1), at(0), "soon", "NaN", true, false, 0, 1, {}, []]) {
      expect(reviewDemoState(meta(v), NOW), String(v)).toBe("lapsed")
    }
  })
  it("reviewDemoLive: the boundaries", () => {
    expect(reviewDemoLive(at(10), at(0), NOW)).toBe(true) // starts exactly now
    expect(reviewDemoLive(at(10), at(0) , NOW - 1)).toBe(false) // one millisecond before the start
    expect(reviewDemoLive(at(0), at(-10), NOW)).toBe(false) // ends exactly now
    expect(reviewDemoLive(at(90), at(0), NOW)).toBe(true) // exactly the ceiling
    expect(reviewDemoLive(new Date(NOW + 90 * DAY + 1).toISOString(), at(0), NOW)).toBe(false)
  })
  it("only app_metadata is read: nothing else is a flag", () => {
    expect(reviewDemoState({ role: "marketing" }, NOW)).toBe("none")
  })
  it("the team the flag is tied to is read from app_metadata, only when it is a non-empty string", () => {
    expect(reviewDemoFlag({ ...meta(at(5)), [REVIEW_DEMO_TEAM_KEY]: "t1" }, NOW)).toEqual({ state: "live", team: "t1" })
    for (const t of [undefined, null, "", 5, true, {}]) expect(reviewDemoFlag({ ...meta(at(5)), [REVIEW_DEMO_TEAM_KEY]: t }, NOW).team, String(t)).toBeNull()
  })
  it("NO_REVIEW_DEMO is the ordinary login", () => {
    expect(NO_REVIEW_DEMO).toEqual({ state: "none", team: null })
    expect(reviewDemoFlag({ role: "marketing" }, NOW)).toEqual(NO_REVIEW_DEMO)
  })
})
