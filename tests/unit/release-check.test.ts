/**
 * "New release available — refresh" — the pure rules (dev job dc629a3d).
 * The promises: never a false alarm (unknown build, unreadable answer, a single odd reading, a rollout in progress), always an alarm
 * when a different release is really live, and the alarm clears when the live release is this page's own again.
 */
import { describe, it, expect } from "vitest"
import {
  INITIAL_RELEASE_STATE,
  RELEASE_CONFIRM_MS,
  RELEASE_POLL_MS,
  nextReleaseState,
  releaseIdFrom,
  type ReleaseState,
} from "@/lib/release/release-check"

describe("releaseIdFrom", () => {
  it("is the commit alone on production builds", () => {
    expect(releaseIdFrom("bd200a1")).toBe("bd200a1")
    expect(releaseIdFrom(" bd200a1 ", "")).toBe("bd200a1")
  })
  it("adds the deploy time when there is one (sandbox: two deploys of the same checkout still differ)", () => {
    expect(releaseIdFrom("bd200a1+dirty", "Nov 05 11:20")).toBe("bd200a1+dirty@Nov 05 11:20")
  })
  it("is empty (unknown) when there is no stamp, and 'local' counts as no stamp", () => {
    expect(releaseIdFrom(undefined)).toBe("")
    expect(releaseIdFrom(null, "Nov 05 11:20")).toBe("")
    expect(releaseIdFrom("   ")).toBe("")
    expect(releaseIdFrom("local")).toBe("")
  })
})

describe("nextReleaseState", () => {
  const own = "aaaaaaa"
  const read = (s: ReleaseState, live: unknown) => nextReleaseState(s, own, live)

  it("same release live → nothing shows", () => {
    expect(read(INITIAL_RELEASE_STATE, "aaaaaaa")).toEqual({ different: null, show: false })
  })

  it("one different reading is only a suspicion — not shown yet", () => {
    expect(read(INITIAL_RELEASE_STATE, "bbbbbbb")).toEqual({ different: "bbbbbbb", show: false })
  })

  it("the same different release on the next reading shows the banner", () => {
    const first = read(INITIAL_RELEASE_STATE, "bbbbbbb")
    expect(read(first, "bbbbbbb")).toEqual({ different: "bbbbbbb", show: true })
  })

  it("a rollout in progress (new, old, new …) never shows it: an old answer in between resets the suspicion", () => {
    let s = read(INITIAL_RELEASE_STATE, "bbbbbbb") // new instance answers
    s = read(s, "aaaaaaa") // old instance answers
    expect(s.show).toBe(false)
    s = read(s, "bbbbbbb")
    expect(s.show).toBe(false) // only a suspicion again
    s = read(s, "bbbbbbb")
    expect(s.show).toBe(true) // two in a row
  })

  it("once showing it stays showing when an even newer release replaces the one first seen (no flicker off)", () => {
    const showing: ReleaseState = { different: "bbbbbbb", show: true }
    expect(read(showing, "ccccccc")).toEqual({ different: "ccccccc", show: true })
  })

  it("the banner clears when the live release goes back to this page's own (rollback)", () => {
    expect(read({ different: "bbbbbbb", show: true }, "aaaaaaa")).toEqual(INITIAL_RELEASE_STATE)
  })

  it("an unreadable answer changes nothing at all (offline, redirect to login, damaged body)", () => {
    const showing: ReleaseState = { different: "bbbbbbb", show: true }
    for (const bad of [undefined, null, 42, {}, [], "", "   "]) {
      expect(read(showing, bad)).toBe(showing)
    }
    const suspicion: ReleaseState = { different: "bbbbbbb", show: false }
    expect(read(suspicion, undefined)).toBe(suspicion)
  })

  it("a page with no release id of its own can never claim a new release", () => {
    expect(nextReleaseState(INITIAL_RELEASE_STATE, "", "bbbbbbb")).toBe(INITIAL_RELEASE_STATE)
    expect(nextReleaseState({ different: "x", show: true }, "", "bbbbbbb")).toEqual({ different: "x", show: true })
  })

  it("trims what the server says before comparing", () => {
    expect(read(INITIAL_RELEASE_STATE, " aaaaaaa ")).toEqual({ different: null, show: false })
  })
})

describe("the timings", () => {
  it("asks every minute, and confirms a first different answer much sooner than the next tick", () => {
    expect(RELEASE_POLL_MS).toBe(60_000)
    expect(RELEASE_CONFIRM_MS).toBeLessThan(RELEASE_POLL_MS)
    expect(RELEASE_CONFIRM_MS).toBeGreaterThanOrEqual(1_000)
  })
})
