import { describe, it, expect } from "vitest"
import { DEFAULT_DATE_SORT, dateFromName, groupKey, groupKeyFromName, groupPath, orderFolders, parseSettings, planSort, type DateSortSettings } from "@/lib/crm-store/date-sort-rules"

const S = (o: Partial<DateSortSettings> = {}): DateSortSettings => ({ ...DEFAULT_DATE_SORT, ...o })

describe("dateFromName", () => {
  it("reads the date at the start of a Zoom folder name", () => {
    expect(dateFromName("2026-11-02 06.59.32 Antonio Durante - Tony Durante LLC's Zoom Meeting")).toEqual({ year: 2026, month: 11, day: 2 })
    expect(dateFromName("  2025-09-11 call")).toEqual({ year: 2025, month: 9, day: 11 })
  })
  it("refuses names with no date, a date in the middle, or a date that is not on the calendar", () => {
    expect(dateFromName("Zoom Call from Marketing")).toBeNull()
    expect(dateFromName("Call 2026-11-02")).toBeNull()
    expect(dateFromName("2026-02-30 x")).toBeNull()
    expect(dateFromName("2026-13-01 x")).toBeNull()
    expect(dateFromName("1999-01-01 x")).toBeNull()
    expect(dateFromName("2026-11-023 x")).toBeNull()
    expect(dateFromName("")).toBeNull()
  })
  it("accepts 29 February only in a leap year", () => {
    expect(dateFromName("2028-02-29 a")).not.toBeNull()
    expect(dateFromName("2027-02-29 a")).toBeNull()
  })
})

describe("groupPath", () => {
  const d = { year: 2026, month: 11 }
  it("year then month, number and name (the default)", () => expect(groupPath(d, S())).toEqual(["2026", "11 November"]))
  it("month written as a number or as a name", () => {
    expect(groupPath(d, S({ monthLabel: "number" }))).toEqual(["2026", "11"])
    expect(groupPath(d, S({ monthLabel: "name" }))).toEqual(["2026", "November"])
  })
  it("year only", () => expect(groupPath(d, S({ grouping: "year" }))).toEqual(["2026"]))
  it("month only always carries the year", () => {
    expect(groupPath(d, S({ grouping: "month", monthLabel: "number" }))).toEqual(["2026-11"])
    expect(groupPath(d, S({ grouping: "month", monthLabel: "number_name" }))).toEqual(["2026-11 November"])
    expect(groupPath(d, S({ grouping: "month", monthLabel: "name" }))).toEqual(["November 2026"])
  })
  it("own patterns replace the built-in names", () => {
    expect(groupPath(d, S({ custom: { year: "Year {year}", month: "{month} - {monthName}" } }))).toEqual(["Year 2026", "11 - November"])
    expect(groupPath(d, S({ grouping: "month", custom: { month: "{year} {monthName}" } }))).toEqual(["2026 November"])
  })
})

describe("parseSettings", () => {
  it("accepts the default", () => expect(parseSettings(DEFAULT_DATE_SORT)).toEqual({ ok: true, settings: DEFAULT_DATE_SORT }))
  it("says what is missing in plain words", () => {
    expect(parseSettings(null)).toMatchObject({ ok: false })
    expect(parseSettings({ ...DEFAULT_DATE_SORT, grouping: "week" })).toMatchObject({ ok: false, message: expect.stringContaining("group") })
    expect(parseSettings({ ...DEFAULT_DATE_SORT, order: "random" })).toMatchObject({ ok: false })
    expect(parseSettings({ ...DEFAULT_DATE_SORT, monthLabel: "x" })).toMatchObject({ ok: false })
  })
  it("refuses a custom pattern that would put every date in one folder, or has a slash, or an unknown token", () => {
    expect(parseSettings({ ...DEFAULT_DATE_SORT, custom: { month: "Calls" } })).toMatchObject({ ok: false })
    expect(parseSettings({ ...DEFAULT_DATE_SORT, custom: { month: "{year}/{month}" } })).toMatchObject({ ok: false })
    expect(parseSettings({ ...DEFAULT_DATE_SORT, custom: { month: "{week}" } })).toMatchObject({ ok: false })
    expect(parseSettings({ ...DEFAULT_DATE_SORT, custom: { month: "x".repeat(61) } })).toMatchObject({ ok: false })
  })
  it("keeps a valid custom pattern and drops an empty one", () => {
    expect(parseSettings({ ...DEFAULT_DATE_SORT, custom: { year: "{year}", month: "{month} {monthName}" } })).toMatchObject({ ok: true, settings: { custom: { year: "{year}", month: "{month} {monthName}" } } })
    const empty = parseSettings({ ...DEFAULT_DATE_SORT, custom: { year: "", month: "" } })
    expect(empty).toMatchObject({ ok: true })
    expect(empty.ok && "custom" in empty.settings).toBe(false)
  })
})

const item = (id: string, name: string, locked: string | null = null) => ({ id, kind: "folder" as const, name, locked })

describe("planSort", () => {
  const items = [
    item("a", "2026-11-02 06.59.32 Zoom Meeting"), item("b", "2026-11-02 09.06.31 Zoom Meeting"),
    item("c", "2025-09-11 10.00.00 Call"), item("d", "Zoom Call from Marketing"), item("e", "2026-10-16 09.05.52 Call", "a fixed folder"),
  ]
  it("moves the dated items into year / month, leaves undated and fixed ones with a reason", () => {
    const p = planSort(items, S())
    expect(p.moves.map((m) => [m.id, m.path.join("/")])).toEqual([["a", "2026/11 November"], ["b", "2026/11 November"], ["c", "2025/09 September"]])
    expect(p.stay.map((x) => x.id)).toEqual(["d", "e"])
    expect(p.stay[0].reason).toMatch(/no date/)
    expect(p.newGroups.sort()).toEqual(["2025", "2025 / 09 September", "2026", "2026 / 11 November"])
    expect(p.reusedGroups).toEqual([])
  })
  it("reuses a group an earlier run made (the year and the month) instead of planning it again", () => {
    const held = new Map([[groupKey(["2026"]), new Set<string>(["11 november"])], [groupKey(["2026", "11 November"]), new Set<string>()]])
    const p = planSort(items, S(), held)
    expect(p.newGroups.sort()).toEqual(["2025", "2025 / 09 September"])
    expect(p.reusedGroups.sort()).toEqual(["2026", "2026 / 11 November"])
  })
  it("skips an item whose name is already in the target group, and two items with one name", () => {
    const held = new Map([[groupKey(["2026"]), new Set<string>()], [groupKey(["2026", "11 November"]), new Set<string>(["2026-11-02 06.59.32 zoom meeting"])]])
    const p = planSort(items, S(), held)
    expect(p.clashes.map((c) => c.id)).toEqual(["a"])
    const dup = planSort([item("x", "2026-01-05 a"), item("y", "2026-01-05 A")], S({ grouping: "year" }))
    expect(dup.moves.map((m) => m.id)).toEqual(["x"])
    expect(dup.clashes.map((c) => c.id)).toEqual(["y"])
  })
  it("year only puts every month of a year together", () => {
    const p = planSort(items, S({ grouping: "year" }))
    expect(p.moves.map((m) => m.path.join("/"))).toEqual(["2026", "2026", "2025"])
  })
  it("an empty folder plans nothing", () => expect(planSort([], S())).toMatchObject({ moves: [], stay: [], newGroups: [] }))
  it("a 167-item pile is planned in one pass", () => {
    const many = Array.from({ length: 167 }, (_, i) => item(String(i), `2026-${String((i % 12) + 1).padStart(2, "0")}-${String((i % 28) + 1).padStart(2, "0")} ${i}`))
    const p = planSort(many, S())
    expect(p.moves).toHaveLength(167)
    expect(p.newGroups.filter((g) => !g.includes("/"))).toEqual(["2026"])
  })
})

describe("groupKeyFromName / orderFolders", () => {
  it("reads year and month out of every built-in label", () => {
    expect(groupKeyFromName("2026")).toBe(202600)
    expect(groupKeyFromName("11 November")).toBe(11)
    expect(groupKeyFromName("November")).toBe(11)
    expect(groupKeyFromName("2026-11")).toBe(202611)
    expect(groupKeyFromName("2026-11 November")).toBe(202611)
    expect(groupKeyFromName("November 2026")).toBe(202611)
    expect(groupKeyFromName("Notes")).toBeNull()
    expect(groupKeyFromName("May")).toBe(5)
    expect(groupKeyFromName("Mayfair")).toBeNull()
  })
  const names = (l: { name: string }[]) => l.map((x) => x.name)
  it("newest first: months descending, a hand-made folder stays on top", () => {
    const l = ["01 January", "11 November", "Notes", "09 September"].map((name) => ({ name }))
    expect(names(orderFolders(l, "newest"))).toEqual(["Notes", "11 November", "09 September", "01 January"])
    expect(names(orderFolders(l, "oldest"))).toEqual(["Notes", "01 January", "09 September", "11 November"])
  })
  it("years newest / oldest first", () => {
    const l = ["2025", "2026", "2024"].map((name) => ({ name }))
    expect(names(orderFolders(l, "newest"))).toEqual(["2026", "2025", "2024"])
    expect(names(orderFolders(l, "oldest"))).toEqual(["2024", "2025", "2026"])
  })
  it("month-only folders sort by year then month", () => {
    const l = ["2025-12", "2026-01", "2025-02"].map((name) => ({ name }))
    expect(names(orderFolders(l, "newest"))).toEqual(["2026-01", "2025-12", "2025-02"])
  })
  it("a custom '11 - November' label is still ordered by its month", () => {
    const l = ["02 - February", "11 - November", "07 - July"].map((name) => ({ name }))
    expect(names(orderFolders(l, "newest"))).toEqual(["11 - November", "07 - July", "02 - February"])
  })
})
