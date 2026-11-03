/**
 * Bank application intake — "Undo send back", tested against a small in-memory database that really applies the filters (so the
 * guards "only while the client has not opened it" and "only if it is still that same send-back" are exercised, not assumed).
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

type Row = Record<string, unknown>

const h = vi.hoisted(() => ({
  rows: [] as Record<string, unknown>[],
  writes: [] as { id: unknown; payload: Record<string, unknown> }[],
  /** run just before an UPDATE is applied: lets a test play "the client / another staff member got there first" */
  beforeUpdate: null as null | ((id: string, payload: Record<string, unknown>) => void),
  readError: null as null | string,
  gmail: vi.fn(),
}))

vi.mock("@/lib/gmail", () => ({ gmailPost: (...a: unknown[]) => h.gmail(...a) }))
vi.mock("@/lib/supabase-admin", () => {
  const builder = () => {
    let kind: "select" | "update" = "select"
    let payload: Record<string, unknown> = {}
    const filters: [string, unknown][] = []
    const match = () => h.rows.filter((r) => filters.every(([c, v]) => r[c] === v))
    const run = () => {
      if (kind === "update") {
        const target = match()
        h.beforeUpdate?.(String(filters.find((f) => f[0] === "id")?.[1]), payload)
        const hit = match()
        void target
        for (const r of hit) { Object.assign(r, payload); h.writes.push({ id: r.id, payload }) }
        return { data: hit[0] ? { id: hit[0].id } : null, error: null }
      }
      if (h.readError) return { data: null, error: { message: h.readError } }
      return { data: match(), error: null }
    }
    const b: Record<string, unknown> = {}
    b.select = () => b
    b.update = (p: Record<string, unknown>) => { kind = "update"; payload = p; return b }
    b.eq = (c: string, v: unknown) => { filters.push([c, v]); return b }
    b.maybeSingle = () => { const r = run(); return Promise.resolve({ ...r, data: kind === "select" ? ((r.data as Row[] | null)?.[0] ?? null) : r.data }) }
    b.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve(run()).then(res, rej)
    return b
  }
  return { supabaseAdmin: { from: () => builder() } }
})

import { undoSendBack } from "@/lib/bofa-intake/undo-send-back"

const SENT_BACK_AT = "2026-11-03T10:00:00.000000+00:00"
const original = (over: Row = {}): Row => ({
  id: "old", status: "completed", email_status: "sent", reviewed_at: "2026-11-02T09:00:00+00:00", reviewed_by: "luca@x.co",
  sent_by: "antonio@x.co", sent_to: ["bank@example.com"], returned_at: SENT_BACK_AT, returned_by: "luca@x.co", return_note: "Passport is cut off",
  replaces_id: null, staff_note: null, ...over,
})
const replacement = (over: Row = {}): Row => ({ id: "new", status: "pending", replaces_id: "old", staff_note: "Passport is cut off", returned_at: null, ...over })

beforeEach(() => {
  h.rows = [original(), replacement()]
  h.writes = []
  h.beforeUpdate = null
  h.readError = null
  h.gmail.mockReset()
})

const get = (id: string) => h.rows.find((r) => r.id === id) as Row

describe("Undo send back", () => {
  it("cancels the new link and puts the application back exactly as it was, emailing nobody", async () => {
    const r = await undoSendBack("old")
    expect(r).toEqual({ ok: true, cancelledLink: true })
    expect(get("new").status).toBe("revoked")
    expect(get("old")).toMatchObject({ returned_at: null, returned_by: null, return_note: null })
    // everything a send-back never touches is still there: reviewed, submitted, to whom
    expect(get("old")).toMatchObject({ status: "completed", email_status: "sent", reviewed_by: "luca@x.co", sent_by: "antonio@x.co", sent_to: ["bank@example.com"] })
    expect(h.gmail).not.toHaveBeenCalled()
  })

  it("keeps what the staff asked for on the cancelled link, so the history is not lost", async () => {
    await undoSendBack("old")
    expect(get("new").staff_note).toBe("Passport is cut off")
  })

  it("only ever writes the three 'returned' fields on the application, and only the status on the link", async () => {
    await undoSendBack("old")
    const keys = (id: string) => Object.keys(h.writes.find((w) => w.id === id)!.payload).filter((k) => k !== "updated_at").sort()
    expect(keys("old")).toEqual(["return_note", "returned_at", "returned_by"])
    expect(keys("new")).toEqual(["status"])
  })

  it("works when the new link was already revoked: nothing to cancel, the application just goes back", async () => {
    h.rows = [original(), replacement({ status: "revoked" })]
    const r = await undoSendBack("old")
    expect(r).toEqual({ ok: true, cancelledLink: false })
    expect(get("old").returned_at).toBeNull()
    expect(get("new").status).toBe("revoked")
  })

  it("works when there is no replacement row at all", async () => {
    h.rows = [original()]
    expect(await undoSendBack("old")).toEqual({ ok: true, cancelledLink: false })
  })

  it("refuses once the client has opened the new link, and changes nothing", async () => {
    h.rows = [original(), replacement({ status: "opened" })]
    const r = await undoSendBack("old")
    expect(r.ok).toBe(false)
    if ("error" in r) expect(r.error).toMatch(/Revoke/)
    expect(h.writes).toEqual([])
    expect(get("old").returned_at).toBe(SENT_BACK_AT)
  })

  it("refuses once the client has sent the corrected application, and changes nothing", async () => {
    h.rows = [original(), replacement({ status: "completed" })]
    const r = await undoSendBack("old")
    expect(r.ok).toBe(false)
    if ("error" in r) expect(r.error).toMatch(/corrected application/)
    expect(h.writes).toEqual([])
  })

  it("refuses an application that is not sent back", async () => {
    h.rows = [original({ returned_at: null, returned_by: null, return_note: null })]
    const r = await undoSendBack("old")
    expect(r.ok).toBe(false)
    expect(h.writes).toEqual([])
  })

  it("refuses a link that is not a submitted application (opened, not yet submitted)", async () => {
    h.rows = [original({ status: "opened" })]
    expect((await undoSendBack("old")).ok).toBe(false)
    expect(h.writes).toEqual([])
  })

  it("says so when the application does not exist", async () => {
    h.rows = []
    const r = await undoSendBack("old")
    expect(r).toEqual({ ok: false, error: "Application not found." })
  })

  it("a second press finds nothing to undo (no double effect)", async () => {
    await undoSendBack("old")
    const writesAfterFirst = h.writes.length
    const again = await undoSendBack("old")
    expect(again.ok).toBe(false)
    expect(h.writes.length).toBe(writesAfterFirst)
  })

  it("if the database cannot be read, nothing is changed", async () => {
    h.readError = "boom"
    const r = await undoSendBack("old")
    expect(r.ok).toBe(false)
    expect(h.writes).toEqual([])
  })

  it("RACE: the client presses Start on the new link at the same moment — the client wins, the undo is refused, nothing is thrown away", async () => {
    h.beforeUpdate = (id) => { if (id === "new") get("new").status = "opened" }
    const r = await undoSendBack("old")
    expect(r.ok).toBe(false)
    if ("error" in r) expect(r.error).toMatch(/just opened/)
    expect(get("new").status).toBe("opened")
    expect(get("old").returned_at).toBe(SENT_BACK_AT)
  })

  it("RACE: someone sends it back again between the two steps — the new send-back is never overwritten", async () => {
    const SECOND = "2026-11-03T10:05:00.000000+00:00"
    h.beforeUpdate = (id) => {
      if (id === "old") Object.assign(get("old"), { returned_at: SECOND, returned_by: "support@x.co", return_note: "Second thoughts" })
    }
    const r = await undoSendBack("old")
    expect(r.ok).toBe(false)
    if ("error" in r) expect(r.error).toMatch(/cancelled/)
    expect(get("old")).toMatchObject({ returned_at: SECOND, returned_by: "support@x.co", return_note: "Second thoughts" })
  })
})
