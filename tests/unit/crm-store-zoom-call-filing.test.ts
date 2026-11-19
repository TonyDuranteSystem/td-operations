import { describe, it, expect } from "vitest"
import { fileZoomCalls, parseMode, type Areas, type FilingDeps, type FilingMode } from "@/lib/crm-store/zoom-call-filing"
import type { Booking, CandidateFolder } from "@/lib/crm-store/zoom-call-filing-rules"

const at = (iso: string) => new Date(iso)
const NOW = at("2026-11-10T14:40:00Z")
const areas: Areas = { ownerId: "owner", zoomCalls: "zc", tdZoom: "td", tdMarketing: "mk" }
const finished = (id: string, name: string, over: Partial<CandidateFolder> = {}): CandidateFolder => ({ id, name, createdAt: at("2026-11-10T14:01:01Z"), lastActivity: at("2026-11-10T14:27:35Z"), uploadOpen: false, ...over })
const LUCA = finished("luca", "2026-11-10 09.00.57 Luca Comaggi and Antonio Durante")
const calendly: Booking = { kind: "calendly", start: at("2026-11-10T14:00:00Z"), end: null, who: "Luca Comaggi" }

interface Log { moves: Array<[string, string]>; records: string[]; sorts: number; bookingReads: number; candidateReads: number }

function fake(over: Omit<Partial<FilingDeps>, "mode"> & { list?: CandidateFolder[]; mode?: FilingMode; bookingList?: Booking[]; sortAnswers?: Array<{ moved: number; failed: number; remaining: number }> } = {}) {
  const log: Log = { moves: [], records: [], sorts: 0, bookingReads: 0, candidateReads: 0 }
  const sortAnswers = over.sortAnswers ?? [{ moved: 1, failed: 0, remaining: 0 }]
  const deps: FilingDeps = {
    now: () => NOW,
    mode: async () => over.mode ?? "live",
    areas: async () => ({ ok: true, areas }),
    candidates: async () => { log.candidateReads++; return over.list ?? [LUCA] },
    recheck: async id => (over.list ?? [LUCA]).find(c => c.id === id) ?? null,
    bookings: async () => { log.bookingReads++; return over.bookingList ?? [calendly] },
    move: async (id, to) => { log.moves.push([id, to]) },
    sortTdZoom: async () => sortAnswers[Math.min(log.sorts++, sortAnswers.length - 1)],
    record: async e => { log.records.push(`${e.folder.id}:${e.origin}:${e.destination}:${e.text}`) },
  }
  return { deps: { ...deps, ...stripTestKeys(over) }, log }
}
function stripTestKeys(over: Record<string, unknown>) {
  const { list: _l, mode: _m, bookingList: _b, sortAnswers: _s, ...rest } = over
  void _l; void _m; void _b; void _s
  return rest as Partial<FilingDeps>
}

describe("the switch", () => {
  it("is off unless the setting says dry_run or live", () => {
    expect(parseMode({ mode: "live" })).toBe("live")
    expect(parseMode({ mode: "dry_run" })).toBe("dry_run")
    expect(parseMode("live")).toBe("live")
    expect(parseMode(undefined)).toBe("off")
    expect(parseMode(null)).toBe("off")
    expect(parseMode({ mode: "LIVE" })).toBe("off")
    expect(parseMode({ mode: true })).toBe("off")
    expect(parseMode([{ mode: "live" }])).toBe("off")
  })
  it("off: reads nothing and moves nothing", async () => {
    const { deps, log } = fake({ mode: "off" })
    const r = await fileZoomCalls(deps)
    expect(r.skipped).toMatch(/switched off/)
    expect(log.candidateReads).toBe(0)
    expect(log.moves).toEqual([])
  })
  it("a missing TD Zoom Calls folder stops the run and says why", async () => {
    const { deps, log } = fake({ areas: async () => ({ ok: false, reason: 'There is no "TD Zoom Calls" folder inside Zoom Calls.' }) })
    const r = await fileZoomCalls(deps)
    expect(r.skipped).toMatch(/TD Zoom Calls/)
    expect(log.moves).toEqual([])
  })
})

describe("dry run", () => {
  it("lists what it would do and changes nothing", async () => {
    const { deps, log } = fake({ mode: "dry_run" })
    const r = await fileZoomCalls(deps)
    expect(r.filed).toEqual([{ name: LUCA.name, destination: "td_zoom", origin: "calendly", text: "Calendly booking 2026-11-10 14:00 UTC — Luca Comaggi", dryRun: true }])
    expect(log.moves).toEqual([])
    expect(log.records).toEqual([])
    expect(log.sorts).toBe(0)
  })
})

describe("live filing", () => {
  it("the Luca call goes to TD Zoom Calls, is logged with where it came from, and TD Zoom Calls is sorted", async () => {
    const { deps, log } = fake()
    const r = await fileZoomCalls(deps)
    expect(log.moves).toEqual([["luca", "td"]])
    expect(log.records).toEqual(["luca:calendly:td_zoom:Calendly booking 2026-11-10 14:00 UTC — Luca Comaggi"])
    expect(log.sorts).toBe(1)
    expect(r.filed[0]).toMatchObject({ destination: "td_zoom", origin: "calendly", dryRun: false })
    expect(r.failed).toEqual([])
    expect(r.sort).toEqual({ moved: 1, failed: 0, remaining: 0 })
  })
  it("a call started straight from Zoom goes to TD Zoom Calls the same way", async () => {
    const zoom = finished("z", "2026-11-10 06.59.32 Antonio Durante - Tony Durante LLC's Zoom Meeting", { createdAt: at("2026-11-10T11:59:40Z"), lastActivity: at("2026-11-10T12:30:00Z") })
    const { deps, log } = fake({ list: [zoom] })
    const r = await fileZoomCalls(deps)
    expect(log.moves).toEqual([["z", "td"]])
    expect(r.filed[0].origin).toBe("zoom_direct")
    expect(log.records[0]).toContain("Started in Zoom")
  })
  it("a marketing-link booking goes to TD Marketing Calls and TD Zoom Calls is not sorted for it", async () => {
    const mk: Booking = { kind: "marketing", start: at("2026-11-10T14:00:00Z"), end: at("2026-11-10T14:30:00Z"), who: "Maria" }
    const { deps, log } = fake({ bookingList: [mk] })
    await fileZoomCalls(deps)
    expect(log.moves).toEqual([["luca", "mk"]])
    expect(log.sorts).toBe(0)
  })
  it("a marketing call with no marketing folder is held back, not put in TD Zoom Calls", async () => {
    const mk: Booking = { kind: "marketing", start: at("2026-11-10T14:00:00Z"), end: null, who: null }
    const { deps, log } = fake({ bookingList: [mk], areas: async () => ({ ok: true, areas: { ...areas, tdMarketing: null } }) })
    const r = await fileZoomCalls(deps)
    expect(log.moves).toEqual([])
    expect(r.waiting).toEqual([{ name: LUCA.name, reason: "no_marketing_folder" }])
  })
  it("a call still being recorded or uploaded waits; a finished one next to it is filed", async () => {
    const recording = finished("r", "2026-11-10 09.30.00 Still recording", { lastActivity: at("2026-11-10T14:38:00Z") })
    const uploading = finished("u", "2026-11-10 09.31.00 Uploading", { uploadOpen: true })
    const { deps, log } = fake({ list: [recording, uploading, LUCA] })
    const r = await fileZoomCalls(deps)
    expect(log.moves).toEqual([["luca", "td"]])
    expect(r.waiting).toEqual(expect.arrayContaining([{ name: recording.name, reason: "still_changing" }, { name: uploading.name, reason: "upload_running" }]))
  })
  it("folders that are not calls are never touched or counted", async () => {
    const { deps, log } = fake({ list: [finished("t", "TD Marketing Calls"), finished("n", "Zoom Call from Marketing QA")] })
    const r = await fileZoomCalls(deps)
    expect(r.seen).toBe(0)
    expect(log.moves).toEqual([])
  })
  it("the bookings are only read when some folder is old enough to file", async () => {
    const { deps, log } = fake({ list: [finished("r", "2026-11-10 09.30.00 Still recording", { lastActivity: at("2026-11-10T14:38:00Z") })] })
    await fileZoomCalls(deps)
    expect(log.bookingReads).toBe(0)
  })
  it("at most 10 calls are filed in one run; the rest wait for the next run", async () => {
    const many = Array.from({ length: 12 }, (_, i) => finished(`c${i}`, `2026-11-0${(i % 9) + 1} 09.00.0${i % 10} Person ${i}`, { lastActivity: at(`2026-11-09T0${i % 10}:00:00Z`) }))
    const { deps, log } = fake({ list: many, bookingList: [] })
    const r = await fileZoomCalls(deps)
    expect(log.moves.length).toBe(10)
    expect(r.deferred).toBe(2)
  })
  it("a folder that cannot be moved (same name already there) is reported and the others still go", async () => {
    const other = finished("o", "2026-11-10 08.00.00 Other call", { lastActivity: at("2026-11-10T13:00:00Z") })
    const { deps, log } = fake({ list: [LUCA, other], bookingList: [], move: async (id, to) => { if (id === "o") throw new Error('"TD Zoom Calls" already has a folder called "2026-11-10 08.00.00 Other call".'); log.moves.push([id, to]) } })
    const r = await fileZoomCalls(deps)
    expect(log.moves).toEqual([["luca", "td"]])
    expect(r.failed).toEqual([{ name: other.name, error: expect.stringContaining("already has a folder") }])
  })
  it("a file that arrived after the first look stops the move", async () => {
    const { deps, log } = fake({ recheck: async () => ({ ...LUCA, lastActivity: at("2026-11-10T14:39:30Z") }) })
    const r = await fileZoomCalls(deps)
    expect(log.moves).toEqual([])
    expect(r.waiting).toEqual([{ name: LUCA.name, reason: "still_changing" }])
  })
  it("a folder that is gone by the second look is dropped quietly", async () => {
    const { deps, log } = fake({ recheck: async () => null })
    const r = await fileZoomCalls(deps)
    expect(log.moves).toEqual([])
    expect(r.waiting).toEqual([{ name: LUCA.name, reason: "no_longer_there" }])
  })
  it("a failed log line is reported but the move stands", async () => {
    const { deps, log } = fake({ record: async () => { throw new Error("log down") } })
    const r = await fileZoomCalls(deps)
    expect(log.moves).toEqual([["luca", "td"]])
    expect(r.filed.length).toBe(1)
    expect(r.failed[0].name).toContain("activity log")
  })
})

describe("sorting after the moves", () => {
  it("repeats while items remain, and stops when they are done", async () => {
    const { deps, log } = fake({ sortAnswers: [{ moved: 15, failed: 0, remaining: 10 }, { moved: 10, failed: 0, remaining: 0 }] })
    const r = await fileZoomCalls(deps)
    expect(log.sorts).toBe(2)
    expect(r.sort).toEqual({ moved: 25, failed: 0, remaining: 0 })
  })
  it("stops when a round moves nothing (no endless loop) and says so", async () => {
    const { deps, log } = fake({ sortAnswers: [{ moved: 0, failed: 2, remaining: 2 }] })
    const r = await fileZoomCalls(deps)
    expect(log.sorts).toBe(1)
    expect(r.failed.some(f => f.name === "Sort by date")).toBe(true)
  })
  it("a sort that throws is reported; the folder stays filed", async () => {
    const { deps, log } = fake({ sortTdZoom: async () => { throw new Error("sort down") } })
    const r = await fileZoomCalls(deps)
    expect(log.moves).toEqual([["luca", "td"]])
    expect(r.failed).toEqual([{ name: "Sort by date", error: "sort down" }])
  })
})
