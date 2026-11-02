import { describe, it, expect, vi, beforeEach } from "vitest"

type Op = { filters: [string, string, unknown][]; payload: Record<string, unknown> | null }
const h = vi.hoisted(() => ({ ops: [] as Op[], result: { data: { id: "x" }, error: null } as { data: unknown; error: unknown } }))

vi.mock("@/lib/supabase-admin", () => {
  const builder = () => {
    const op: Op = { filters: [], payload: null }
    const b: Record<string, unknown> = {}
    b.update = (p: Record<string, unknown>) => { op.payload = p; return b }
    b.select = () => b
    for (const f of ["eq", "is", "or"]) b[f] = (...a: unknown[]) => { op.filters.push([f, String(a[0]), a[1]]); return b }
    b.maybeSingle = () => { h.ops.push(op); return Promise.resolve(h.result) }
    return b
  }
  return { supabaseAdmin: { from: builder } }
})

import { markReviewed } from "@/lib/bofa-intake/review"

beforeEach(() => { h.ops = []; h.result = { data: { id: "x" }, error: null } })

describe("markReviewed", () => {
  it("only matches a submitted, not-yet-reviewed, not-sent-back application that has not been submitted to the bank contact", async () => {
    const r = await markReviewed("id1", "luca@x.co")
    expect(r).toEqual({ ok: true })
    const f = h.ops[0].filters
    expect(f).toContainEqual(["eq", "status", "completed"])
    expect(f).toContainEqual(["is", "reviewed_at", null])
    expect(f).toContainEqual(["is", "returned_at", null])
    expect(f).toContainEqual(["or", "email_status.is.null,email_status.neq.sent", undefined])
    expect(h.ops[0].payload).toMatchObject({ reviewed_by: "luca@x.co" })
  })

  it("says so in words when nothing matched (already reviewed, submitted or sent back)", async () => {
    h.result = { data: null, error: null }
    const r = await markReviewed("id1", "luca@x.co")
    expect("error" in r && r.error).toContain("already reviewed")
  })

  it("a database error is an error, not a silent success", async () => {
    h.result = { data: null, error: { message: "db" } }
    expect((await markReviewed("id1", "l")).ok).toBe(false)
  })
})
