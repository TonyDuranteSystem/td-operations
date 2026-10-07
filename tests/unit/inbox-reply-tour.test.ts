import { describe, it, expect } from "vitest"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"
import {
  REPLY_TOUR_STEPS,
  endAction,
  transitionAction,
} from "../../lib/inbox/reply-tour"

const idx = (id: string) => REPLY_TOUR_STEPS.findIndex((s) => s.id === id)

describe("the script", () => {
  it("has the agreed steps in the agreed order, each once", () => {
    expect(REPLY_TOUR_STEPS.map((s) => s.id)).toEqual(["box", "toolbar", "ai", "expand", "popup-toolbar", "popup-default", "safety"])
  })
  it("the pop-up steps are one unbroken run at the end (so it opens once and closes once)", () => {
    const flags = REPLY_TOUR_STEPS.map((s) => s.inPopup)
    const first = flags.indexOf(true)
    expect(first).toBeGreaterThan(0)
    expect(flags.slice(first).every(Boolean)).toBe(true)
    expect(flags.slice(0, first).some(Boolean)).toBe(false)
  })
})

describe("transitionAction — what the reply box must do between steps", () => {
  it("going Next through the whole tour opens writing mode once and the pop-up once", () => {
    const seq: Array<string | null> = []
    let prev = -1
    for (let i = 0; i < REPLY_TOUR_STEPS.length; i++) {
      seq.push(transitionAction(prev, i))
      prev = i
    }
    expect(seq).toEqual([null, "compose", null, null, "expand", null, null])
  })
  it("Back out of the pop-up closes it; Back inside the same area does nothing", () => {
    expect(transitionAction(idx("popup-toolbar"), idx("expand"))).toBe("collapse")
    expect(transitionAction(idx("popup-default"), idx("popup-toolbar"))).toBeNull()
    expect(transitionAction(idx("toolbar"), idx("box"))).toBeNull()
  })
  it("Back and then Next again re-opens the pop-up", () => {
    expect(transitionAction(idx("expand"), idx("popup-toolbar"))).toBe("expand")
  })
  it("an unknown step does nothing", () => {
    expect(transitionAction(0, 99)).toBeNull()
    expect(transitionAction(0, -1)).toBeNull()
  })
})

describe("endAction (kept for the pop-up steps; the component also tracks what it opened itself)", () => {
  it("closes the pop-up only if the tour ended inside it", () => {
    expect(endAction(idx("safety"))).toBe("collapse")
    expect(endAction(idx("popup-default"))).toBe("collapse")
    expect(endAction(idx("ai"))).toBeNull()
    expect(endAction(99)).toBeNull()
  })
})

describe("the tour never starts by itself", () => {
  it("has no auto-start gate, dismissal storage or once-per-load flag any more (Antonio, 2026-10-07: button only)", () => {
    const lib = readFileSync(resolve(__dirname, "../../lib/inbox/reply-tour.ts"), "utf8")
    expect(lib).not.toMatch(/shouldAutoStartReplyTour|isReplyTourDismissed|ShownThisLoad/)
  })
  it("the inbox shell opens it only from the Reply tour button", () => {
    const shell = readFileSync(resolve(__dirname, "../../components/inbox/inbox-shell.tsx"), "utf8")
    expect(shell).not.toMatch(/shouldAutoStartReplyTour|markReplyTourShownThisLoad/)
    expect(shell).toContain("setReplyTourOpen(true)")
  })
})

describe("the tour component and the rules agree", () => {
  const src = readFileSync(resolve(__dirname, "../../components/inbox/reply-tour.tsx"), "utf8")
  it("has exactly one content entry per rule step, same ids in the same order", () => {
    const ids = [...src.matchAll(/^\s{4}id: '([a-z-]+)',$/gm)].map((m) => m[1])
    expect(ids).toEqual(REPLY_TOUR_STEPS.map((s) => s.id))
  })
  it("never clicks, types, ticks, restores or discards for the person", () => {
    expect(src).not.toMatch(/\.click\(|\.checked\s*=|writeReplyPopupDefault|dispatchEvent\(new (Mouse|Keyboard)Event/)
  })
  it("uses the shared one-tour-at-a-time lock and leaves Esc to the pop-up", () => {
    expect(src).toContain("acquireTour('reply')")
    expect(src).toContain("disableCloseOnEsc")
  })
  it("has no ✕ that would move to the next step, and closes the pop-up it opened on any exit", () => {
    expect(src).toContain("hideCloseButton")
    expect(src).toContain("popupOpenedByTour.current")
  })
})

describe("the reply box carries every target the tour points at", () => {
  const sources = ["compose-reply.tsx", "rich-editor.tsx"].map((f) => readFileSync(resolve(__dirname, "../../components/inbox/" + f), "utf8")).join("\n")
  const tour = readFileSync(resolve(__dirname, "../../components/inbox/reply-tour.tsx"), "utf8")
  it("every data-tour target in the tour exists on a real control", () => {
    const targets = [...tour.matchAll(/\[data-tour="(reply-[a-z-]+)"\]/g)].map((m) => m[1])
    expect(new Set(targets).size).toBeGreaterThanOrEqual(5)
    for (const t of new Set(targets)) expect(sources).toContain(`data-tour="${t}"`)
  })
})
