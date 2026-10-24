import { describe, it, expect } from "vitest"
import { BOARD_VIEWS, boardCards, boardRole, cardsInColumn, columnOf, columnsFor, hiddenCount, parseBoardView, type BoardCard } from "@/lib/marketing/board"
import { MAX_WINDOWS, EMPTY_WINDOWS, closeWindow, clampPosition, focusWindow, frontWindowId, minimizeWindow, moveWindow, openWindow, windowSrc, WINDOW_W } from "@/lib/marketing/lead-windows"
import { MARKETING_SETTING_DEFS } from "@/lib/marketing/settings-schema"

const card = (id: string, stage: string, over: Partial<BoardCard> = {}): BoardCard => ({ id, name: id, stage, stageLabel: stage, phone: null, filledIn: "", apptAt: null, arrivedMs: 0, chips: [], pickedText: "", note: null, ad: null, existingClient: false, handedOver: true, unread: 0, ...over })
const vp = { w: 1440, h: 900 }

describe("the lead board: who sees which columns", () => {
  it("whoever can create payment links is the seller; everyone else is on the setter's board", () => {
    expect(boardRole(["leads.read", "payment_links.create"])).toBe("seller")
    expect(boardRole(["leads.read", "leads.worklist"])).toBe("setter")
    expect(boardRole([])).toBe("setter")
  })
  it("the setter has five columns and the seller four, as approved", () => {
    expect(columnsFor("setter").map(c => c.key)).toEqual(["to_contact", "tried", "in_target", "booked", "paid"])
    expect(columnsFor("seller").map(c => c.key)).toEqual(["booked", "passed", "with_me", "paid"])
  })
  it("every column stage is a real pipeline stage (a renamed stage must not silently empty a column)", () => {
    const real = new Set(MARKETING_SETTING_DEFS.pipeline_stages.fallback.map(s => s.key))
    for (const role of ["setter", "seller"] as const) for (const c of columnsFor(role)) for (const st of c.stages) expect(real.has(st)).toBe(true)
  })
  it("a stage sits in one column per role, and 'not in target' sits in none", () => {
    for (const role of ["setter", "seller"] as const) {
      const seen = columnsFor(role).flatMap(c => c.stages)
      expect(new Set(seen).size).toBe(seen.length)
      expect(columnOf(role, "not_in_target")).toBeNull()
      expect(columnOf(role, "nonsense")).toBeNull()
    }
    expect(columnOf("setter", "qualified")).toBe("in_target")
    expect(columnOf("seller", "qualified")).toBe("passed")
    expect(columnOf("setter", "showed")).toBe("booked")
    expect(columnOf("seller", "showed")).toBe("with_me")
  })
  it("booked calls are listed soonest first; the other columns newest first", () => {
    const cards = [card("late", "booked", { apptAt: "2026-10-28T10:00:00Z", arrivedMs: 5 }), card("soon", "booked", { apptAt: "2026-10-26T10:00:00Z", arrivedMs: 1 }), card("none", "booked", { arrivedMs: 9 })]
    expect(cardsInColumn("seller", "booked", cards).map(c => c.id)).toEqual(["soon", "late", "none"])
    const fresh = [card("a", "new", { arrivedMs: 1 }), card("b", "new", { arrivedMs: 3 }), card("c", "new", { arrivedMs: 2 })]
    expect(cardsInColumn("setter", "to_contact", fresh).map(c => c.id)).toEqual(["b", "c", "a"])
    expect(cardsInColumn("setter", "no_such_column", fresh)).toEqual([])
  })
  it("the Cards view is the columns one after the other; leads at no column are counted, not lost", () => {
    const cards = [card("p", "paid_call"), card("n", "new"), card("x", "not_in_target")]
    expect(boardCards("setter", cards).map(c => c.id)).toEqual(["n", "p"])
    expect(hiddenCount("setter", cards)).toBe(1)
  })
  it("the saved view is one of the three, anything else falls back to the pipeline", () => {
    expect(BOARD_VIEWS).toEqual(["pipeline", "cards", "list"])
    expect(parseBoardView("list")).toBe("list")
    expect(parseBoardView("grid")).toBe("pipeline")
    expect(parseBoardView(null)).toBe("pipeline")
  })
})

describe("the floating lead windows", () => {
  const lead = (n: number) => ({ id: `0000000${n}-0000-4000-8000-000000000000`, name: `Lead ${n}` })
  it("opens a lead once; opening it again only brings it to the front", () => {
    let s = openWindow(EMPTY_WINDOWS, lead(1), vp)
    s = openWindow(s, lead(2), vp)
    s = openWindow(s, lead(1), vp)
    expect(s.list).toHaveLength(2)
    expect(frontWindowId(s)).toBe(lead(1).id)
  })
  it("never more than three: a fourth closes the one touched longest ago", () => {
    let s = EMPTY_WINDOWS
    for (const n of [1, 2, 3]) s = openWindow(s, lead(n), vp)
    s = focusWindow(s, lead(1).id)
    s = openWindow(s, lead(4), vp)
    expect(s.list).toHaveLength(MAX_WINDOWS)
    expect(s.list.map(w => w.id)).not.toContain(lead(2).id)
    expect(s.list.map(w => w.id)).toContain(lead(1).id)
  })
  it("minimize puts it in the bar, opening it again brings it back; close removes it", () => {
    let s = openWindow(EMPTY_WINDOWS, lead(1), vp)
    s = minimizeWindow(s, lead(1).id)
    expect(s.list[0].minimized).toBe(true)
    expect(frontWindowId(s)).toBeNull()
    s = openWindow(s, lead(1), vp)
    expect(s.list[0].minimized).toBe(false)
    s = closeWindow(s, lead(1).id)
    expect(s.list).toEqual([])
  })
  it("new windows cascade so they do not hide each other, and stay on the screen", () => {
    let s = openWindow(EMPTY_WINDOWS, lead(1), vp)
    s = openWindow(s, lead(2), vp)
    expect(s.list[1].y).toBeGreaterThan(s.list[0].y)
    for (const w of s.list) { expect(w.x).toBeGreaterThanOrEqual(-(WINDOW_W - 120)); expect(w.y).toBeGreaterThanOrEqual(0) }
  })
  it("a window can be dragged but its title bar can never leave the screen", () => {
    const s = openWindow(EMPTY_WINDOWS, lead(1), vp)
    const far = moveWindow(s, lead(1).id, 99999, 99999, vp).list[0]
    expect(far.x).toBeLessThanOrEqual(vp.w - 120)
    expect(far.y).toBeLessThan(vp.h)
    const up = clampPosition(10, -500, vp)
    expect(up.y).toBe(0)
  })
  it("only a plain lead id becomes a window address", () => {
    expect(windowSrc(lead(1).id)).toBe(`/marketing/window/${lead(1).id}`)
    expect(windowSrc("../../etc")).toBeNull()
    expect(windowSrc("1; drop table")).toBeNull()
  })
})
