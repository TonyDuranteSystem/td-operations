/**
 * Notes calendar maths. The bug class these guard against is date-bucketing: a note set for
 * 9am local must land on the LOCAL day, not the UTC one, or the whole grid is off by a day for
 * anyone not on UTC.
 */
import { describe, it, expect } from "vitest"
import {
  localDayKey,
  noteDayKey,
  groupNotesByDay,
  buildMonthGrid,
  shiftMonth,
  isOverdue,
  monthLabel,
} from "@/lib/notes/note-calendar"

const note = (over: Partial<{ id: string; snoozed_until: string | null; archived_at: string | null }> = {}) => ({
  id: over.id ?? "n1",
  snoozed_until: over.snoozed_until ?? null,
  archived_at: over.archived_at ?? null,
})

describe("localDayKey — local, never UTC", () => {
  it("uses the local calendar day", () => {
    const d = new Date(2026, 6, 21, 9, 0, 0) // 21 Jul 2026, 09:00 local
    expect(localDayKey(d)).toBe("2026-07-21")
  })
  it("pads single-digit months and days", () => {
    expect(localDayKey(new Date(2026, 0, 5))).toBe("2026-01-05")
  })
  it("late-evening local time stays on the local day (the UTC-rollover trap)", () => {
    const d = new Date(2026, 6, 21, 23, 30, 0)
    expect(localDayKey(d)).toBe("2026-07-21")
  })
})

describe("noteDayKey — which day a note lands on", () => {
  it("uses the come-back date", () => {
    const iso = new Date(2026, 6, 23, 9, 0, 0).toISOString()
    expect(noteDayKey(note({ snoozed_until: iso }))).toBe("2026-07-23")
  })
  it("a note with no come-back date has no day (it's on screen now)", () => {
    expect(noteDayKey(note())).toBeNull()
  })
  it("a done note never appears on the calendar", () => {
    const iso = new Date(2026, 6, 23).toISOString()
    expect(noteDayKey(note({ snoozed_until: iso, archived_at: new Date().toISOString() }))).toBeNull()
  })
  it("a rubbish date is ignored rather than crashing the grid", () => {
    expect(noteDayKey(note({ snoozed_until: "not-a-date" }))).toBeNull()
  })
})

describe("groupNotesByDay", () => {
  it("buckets by day, keeps undated live notes, drops done ones", () => {
    const d23 = new Date(2026, 6, 23, 9).toISOString()
    const d24 = new Date(2026, 6, 24, 9).toISOString()
    const notes = [
      note({ id: "a", snoozed_until: d23 }),
      note({ id: "b", snoozed_until: d23 }),
      note({ id: "c", snoozed_until: d24 }),
      note({ id: "d" }), // undated, live
      note({ id: "e", archived_at: new Date().toISOString() }), // done
    ]
    const { byDay, undated } = groupNotesByDay(notes)
    expect(byDay.get("2026-07-23")?.map((n) => n.id)).toEqual(["a", "b"])
    expect(byDay.get("2026-07-24")?.map((n) => n.id)).toEqual(["c"])
    expect(undated.map((n) => n.id)).toEqual(["d"])
    expect(byDay.size).toBe(2)
  })
  it("handles an empty list", () => {
    const { byDay, undated } = groupNotesByDay([])
    expect(byDay.size).toBe(0)
    expect(undated).toEqual([])
  })
})

describe("buildMonthGrid", () => {
  const today = new Date(2026, 6, 21)

  it("always returns 42 cells so the grid height never jumps", () => {
    for (let m = 0; m < 12; m++) expect(buildMonthGrid(2026, m, today)).toHaveLength(42)
  })
  it("starts the week on Monday", () => {
    // 1 Jul 2026 is a Wednesday → grid starts Mon 29 Jun
    const cells = buildMonthGrid(2026, 6, today)
    expect(cells[0].key).toBe("2026-06-29")
    expect(cells[0].date.getDay()).toBe(1) // Monday
    expect(cells[0].inMonth).toBe(false)
  })
  it("marks in-month days and today", () => {
    const cells = buildMonthGrid(2026, 6, today)
    const t = cells.find((c) => c.key === "2026-07-21")
    expect(t?.inMonth).toBe(true)
    expect(t?.isToday).toBe(true)
    expect(cells.filter((c) => c.isToday)).toHaveLength(1)
  })
  it("covers every day of the month", () => {
    const cells = buildMonthGrid(2026, 6, today).filter((c) => c.inMonth)
    expect(cells).toHaveLength(31)
    expect(cells[0].key).toBe("2026-07-01")
    expect(cells[30].key).toBe("2026-07-31")
  })
  it("handles February in a leap year", () => {
    const inMonth = buildMonthGrid(2024, 1, today).filter((c) => c.inMonth)
    expect(inMonth).toHaveLength(29)
  })
})

describe("shiftMonth — rolls the year", () => {
  it("forward across December", () => {
    expect(shiftMonth(2026, 11, 1)).toEqual({ year: 2027, monthIndex: 0 })
  })
  it("back across January", () => {
    expect(shiftMonth(2026, 0, -1)).toEqual({ year: 2025, monthIndex: 11 })
  })
  it("stays put on zero", () => {
    expect(shiftMonth(2026, 5, 0)).toEqual({ year: 2026, monthIndex: 5 })
  })
})

describe("isOverdue", () => {
  const now = new Date(2026, 6, 21, 12, 0, 0)
  it("true when the come-back time has passed and it's still live", () => {
    expect(isOverdue(note({ snoozed_until: new Date(2026, 6, 20).toISOString() }), now)).toBe(true)
  })
  it("false for a future come-back", () => {
    expect(isOverdue(note({ snoozed_until: new Date(2026, 6, 22).toISOString() }), now)).toBe(false)
  })
  it("false when undated or already done", () => {
    expect(isOverdue(note(), now)).toBe(false)
    expect(isOverdue(note({ snoozed_until: new Date(2026, 6, 20).toISOString(), archived_at: now.toISOString() }), now)).toBe(false)
  })
})

describe("monthLabel", () => {
  it("names the month and year", () => {
    const label = monthLabel(2026, 6)
    expect(label).toMatch(/2026/)
    expect(label.length).toBeGreaterThan(4)
  })
})
