/**
 * The windows tour's content and rules (dev job f3f3e237) — pure, so the whole script is pinned here:
 * what each step says, when it counts as done, and what happens when it can't run.
 */

import { describe, it, expect } from "vitest"
import {
  STEPS, TOUR_VERSION, detectPlatform, keyNames, fillKeys, stepIndexOf, newProgress, enterStep, applyWindowEvent,
  isStepDone, precheck, ringSelector, type TourProgress, type StepId,
} from "@/lib/windows/tour-steps"
import { EMPTY_SNAPSHOT, type WindowsSnapshot } from "@/lib/windows/windows-store"

const snap = (over: Partial<WindowsSnapshot> = {}): WindowsSnapshot => ({ ...EMPTY_SNAPSHOT, ready: true, ...over })
const step = (id: StepId) => STEPS[stepIndexOf(id)]
const at = (id: StepId, p: Partial<TourProgress> = {}): TourProgress => ({ ...enterStep(newProgress(), stepIndexOf(id)), ...p })

describe("this person's keys", () => {
  it("detects a Mac from either hint", () => {
    expect(detectPlatform("MacIntel", "")).toBe("mac")
    expect(detectPlatform("", "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)")).toBe("mac")
    expect(detectPlatform("Win32", "Mozilla/5.0 (Windows NT 10.0)")).toBe("other")
    expect(detectPlatform(undefined, undefined)).toBe("other")
  })
  it("names the keys the way that computer labels them", () => {
    expect(keyNames("mac")).toEqual({ opt: "Option (⌥)", cmd: "Command (⌘)" })
    expect(keyNames("other")).toEqual({ opt: "Alt", cmd: "Ctrl" })
  })
  it("fills every key placeholder, everywhere it appears", () => {
    expect(fillKeys("Hold {OPT} and click. {CMD}+K. {OPT} again.", keyNames("mac"))).toBe("Hold Option (⌥) and click. Command (⌘)+K. Option (⌥) again.")
  })
})

describe("the script", () => {
  it("has 8 steps in the agreed order, starting with a welcome and ending on the wrap-up", () => {
    expect(STEPS.map(s => s.id)).toEqual(["welcome", "open", "move-resize", "buttons", "hide-restore", "fast-way", "close", "done"])
    expect(TOUR_VERSION).toBeGreaterThanOrEqual(1)
  })

  it("every step that asks the person to do something says exactly what, what it is waiting for, and what 'done' looks like", () => {
    for (const s of STEPS.filter(x => x.kind === "act")) {
      expect(s.tryIt, s.id).toBeTruthy()
      expect(s.waiting, s.id).toBeTruthy()
      expect(s.done, s.id).toBeTruthy()
    }
  })

  it("every step has a real-life example, except the wrap-up", () => {
    for (const s of STEPS.filter(x => x.id !== "done")) expect(s.example, s.id).toBeTruthy()
  })

  it("practice steps only ever name Accounts or Leads (Portal Chats / Inbox mark client messages read when opened)", () => {
    for (const s of STEPS.filter(x => x.kind === "act")) {
      const text = `${s.tryIt} ${s.waiting} ${s.done}`
      expect(text, s.id).not.toMatch(/Portal Chats|Inbox/)
    }
  })

  it("never tells the person to pop a window out or move it to the main page (that would end or replace the tour's screen)", () => {
    for (const s of STEPS.filter(x => x.kind === "act")) {
      expect(`${s.tryIt} ${s.waiting}`, s.id).not.toMatch(/separate browser window|Move to the main page/i)
    }
  })

  it("is plain English: no developer words, and no unfilled placeholder left after the keys are filled in", () => {
    const keys = keyNames("other")
    const all = STEPS.flatMap(s => [s.title, s.body, s.example, s.tryIt, s.waiting, s.done, ...(s.more ?? [])]).filter((t): t is string => !!t)
    for (const raw of all) {
      const t = fillKeys(raw, keys)
      expect(t).not.toMatch(/\{[A-Z]+\}/)
      expect(t).not.toMatch(/iframe|viewport|DOM|localStorage|\bAPI\b|z-index|pixel-perfect/i)
    }
  })

  it("warns that 'Move to the main page' replaces the page behind it, and that a double-click hides the window", () => {
    const text = (step("buttons").more ?? []).join(" ")
    expect(text).toMatch(/replaces the page you were on/)
    expect(text).toMatch(/Double-clicking the dark bar also hides the window/)
  })
})

describe("progress", () => {
  it("entering a step resets what was done in the previous one", () => {
    let p = applyWindowEvent(at("move-resize", { practiceId: "w1" }), { type: "moved", id: "w1" })
    expect(p.flags.moved).toBe(true)
    p = enterStep(p, stepIndexOf("hide-restore"))
    expect(p.flags.moved).toBe(false)
    expect(p.practiceId).toBe("w1") // the practice window carries over
  })

  it("the first window opened becomes the practice window; reopening an existing one does not count as 'opened by the tour'", () => {
    const a = applyWindowEvent(at("open"), { type: "opened", id: "w1", url: "/accounts", reused: false })
    expect(a.practiceId).toBe("w1")
    expect(a.opened).toEqual(["w1"])
    const b = applyWindowEvent(at("open"), { type: "opened", id: "w2", url: "/leads", reused: true })
    expect(b.opened).toEqual([]) // it was already open before the tour: not ours to close
    expect(b.practiceId).toBe("w2")
  })

  it("moving or resizing some OTHER window does not count", () => {
    const p = at("move-resize", { practiceId: "w1" })
    expect(applyWindowEvent(p, { type: "moved", id: "w9" }).flags.moved).toBe(false)
    expect(applyWindowEvent(p, { type: "resized", id: "w9" }).flags.resized).toBe(false)
  })

  it("'restored' only counts after a minimize in the same step", () => {
    const p = at("hide-restore", { practiceId: "w1" })
    expect(applyWindowEvent(p, { type: "restored", id: "w1" }).flags.restored).toBe(false)
    const hidden = applyWindowEvent(p, { type: "minimized", id: "w1" })
    expect(applyWindowEvent(hidden, { type: "restored", id: "w1" }).flags.restored).toBe(true)
  })

  it("a plain close of a window the person opened counts; a pop-out or 'move to main page' does not; a window they already had does not", () => {
    const base = at("close", { practiceId: "w1", opened: ["w1", "w2"] })
    expect(applyWindowEvent(base, { type: "closed", id: "w2", reason: "closed" }).flags.closed).toBe(true)
    expect(applyWindowEvent(base, { type: "closed", id: "w2", reason: "popout" }).flags.closed).toBe(false)
    expect(applyWindowEvent(base, { type: "closed", id: "w2", reason: "docked" }).flags.closed).toBe(false)
    expect(applyWindowEvent(base, { type: "closed", id: "w77", reason: "closed" }).flags.closed).toBe(false)
  })

  it("closing the practice window forgets it", () => {
    const p = applyWindowEvent(at("close", { practiceId: "w1", opened: ["w1"] }), { type: "closed", id: "w1", reason: "closed" })
    expect(p.practiceId).toBeNull()
    expect(p.opened).toEqual([])
  })
})

describe("is a step done", () => {
  it("read steps are always ready for Next", () => {
    for (const s of STEPS.filter(x => x.kind === "read")) expect(isStepDone(s, newProgress(), EMPTY_SNAPSHOT)).toBe(true)
  })
  it("'open' is done only while the practice window really exists", () => {
    const p = at("open", { practiceId: "w1" })
    expect(isStepDone(step("open"), p, snap({ ids: ["w1"], count: 1 }))).toBe(true)
    expect(isStepDone(step("open"), p, snap())).toBe(false)
    expect(isStepDone(step("open"), at("open"), snap())).toBe(false)
  })
  it("'move-resize' needs BOTH a move and a resize", () => {
    const m = applyWindowEvent(at("move-resize", { practiceId: "w1" }), { type: "moved", id: "w1" })
    expect(isStepDone(step("move-resize"), m, snap({ ids: ["w1"], count: 1 }))).toBe(false)
    const both = applyWindowEvent(m, { type: "resized", id: "w1" })
    expect(isStepDone(step("move-resize"), both, snap({ ids: ["w1"], count: 1 }))).toBe(true)
  })
  it("'fast-way' is done by a window opened on Leads, with or without a query", () => {
    const base = at("fast-way", { practiceId: "w1" })
    expect(isStepDone(step("fast-way"), applyWindowEvent(base, { type: "opened", id: "w2", url: "/leads", reused: false }), snap())).toBe(true)
    expect(isStepDone(step("fast-way"), applyWindowEvent(base, { type: "opened", id: "w2", url: "/leads?x=1", reused: false }), snap())).toBe(true)
    expect(isStepDone(step("fast-way"), applyWindowEvent(base, { type: "opened", id: "w2", url: "/accounts", reused: false }), snap())).toBe(false)
  })
})

describe("can a step run", () => {
  it("'open': with 3 windows already open it picks one to practise on and says so", () => {
    const r = precheck(step("open"), newProgress(), snap({ count: 3, ids: ["w1", "w2", "w3"], minimized: ["w1"] }))
    expect(r.kind).toBe("auto")
    if (r.kind === "auto") {
      expect(r.practiceId).toBe("w2") // prefers a window that is on screen
      expect(r.note).toMatch(/3 windows/)
    }
  })
  it("'open': otherwise it simply waits for the person", () => {
    expect(precheck(step("open"), newProgress(), snap({ count: 1, ids: ["w1"] })).kind).toBe("ok")
  })
  it("'move-resize' / 'hide-restore': practice window gone → use another one, or offer to open one", () => {
    expect(precheck(step("move-resize"), at("move-resize", { practiceId: "w1" }), snap({ ids: ["w1"], count: 1 })).kind).toBe("ok")
    expect(precheck(step("hide-restore"), at("hide-restore", { practiceId: "w1" }), snap({ ids: ["w5"], count: 1 })).kind).toBe("auto")
    expect(precheck(step("hide-restore"), at("hide-restore", { practiceId: "w1" }), snap())).toEqual({ kind: "missing", canOpen: true })
  })
  it("'fast-way': blocked when a 4th window would be needed, fine when Leads is already open or there is room", () => {
    const full = snap({ count: 3, ids: ["w1", "w2", "w3"], urls: ["/accounts", "/inbox", "/tasks"] })
    expect(precheck(step("fast-way"), newProgress(), full).kind).toBe("blocked")
    expect(precheck(step("fast-way"), newProgress(), { ...full, urls: ["/accounts", "/leads", "/tasks"] }).kind).toBe("ok")
    expect(precheck(step("fast-way"), newProgress(), snap({ count: 2, ids: ["w1", "w2"], urls: ["/a", "/b"] })).kind).toBe("ok")
  })
  it("'close': nothing left to close is not an error", () => {
    expect(precheck(step("close"), newProgress(), snap()).kind).toBe("auto")
    expect(precheck(step("close"), newProgress(), snap({ count: 1, ids: ["w1"] })).kind).toBe("ok")
  })
})

describe("what the ring points at", () => {
  it("the launcher button for 'open'", () => {
    expect(ringSelector(step("open"), newProgress(), snap())).toBe('[data-tour="win-launcher"]')
  })
  it("the dark bar first, then the whole window once it has been moved", () => {
    const p = at("move-resize", { practiceId: "w1" })
    expect(ringSelector(step("move-resize"), p, snap())).toBe('[data-win-id="w1"] [data-win-part="titlebar"]')
    const moved = applyWindowEvent(p, { type: "moved", id: "w1" })
    expect(ringSelector(step("move-resize"), moved, snap())).toBe('[data-win-id="w1"]')
  })
  it("Minimize, then the tab at the bottom once it is hidden", () => {
    const p = at("hide-restore", { practiceId: "w1" })
    expect(ringSelector(step("hide-restore"), p, snap({ ids: ["w1"] }))).toBe('[data-win-id="w1"] [data-win-part="minimize"]')
    expect(ringSelector(step("hide-restore"), p, snap({ ids: ["w1"], minimized: ["w1"] }))).toBe('[data-win-part="tray-chip"][data-win-id="w1"]')
  })
  it("the Leads item in the left menu for the fast way, and X of the window the person opened for 'close'", () => {
    expect(ringSelector(step("fast-way"), newProgress(), snap())).toBe('aside a[href="/leads"]')
    expect(ringSelector(step("close"), at("close", { practiceId: "w1", opened: ["w1", "w2"] }), snap())).toBe('[data-win-id="w2"] [data-win-part="close"]')
  })
  it("nothing to point at when there is no practice window, and none on the welcome / wrap-up cards", () => {
    expect(ringSelector(step("buttons"), newProgress(), snap())).toBeNull()
    expect(ringSelector(step("welcome"), newProgress(), snap())).toBeNull()
    expect(ringSelector(step("done"), newProgress(), snap())).toBeNull()
  })
})
