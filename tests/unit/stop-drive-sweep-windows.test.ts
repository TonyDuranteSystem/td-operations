/**
 * readSweepWindow: the window is filtered in the QUERY — real submissions only, not-yet-alerted only, companies that are not
 * Closed/Cancelled (a missing status counts as not finished), completed rows with NO company kept — so rows that can never be
 * acted on can never fill it. Checked against a recording fake of the Supabase builder.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

const state = vi.hoisted(() => ({
  queries: [] as Array<{ table: string; select: string; opts: unknown; calls: Array<[string, unknown[]]> }>,
  answers: [] as Array<{ data: unknown[] | null; count?: number | null; error: { message: string } | null }>,
}))

vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    from: (table: string) => ({
      select: (select: string, opts?: unknown) => {
        const q = { table, select, opts, calls: [] as Array<[string, unknown[]]> }
        state.queries.push(q)
        const c: Record<string, unknown> = {}
        for (const m of ["is", "gte", "not", "in", "or", "order", "limit"]) c[m] = (...a: unknown[]) => { q.calls.push([m, a]); return c }
        c.then = (r: (v: unknown) => unknown) => Promise.resolve(state.answers.shift() ?? { data: [], count: 0, error: null }).then(r)
        return c
      },
    }),
  },
}))

import { readSweepWindow } from "@/lib/archive/skip-no-drive-folder"

const REAL = "status.in.(completed,reviewed),review_status.not.is.null"
beforeEach(() => { state.queries.length = 0; state.answers.length = 0 })

describe("readSweepWindow", () => {
  it("asks for REAL, not-yet-alerted rows of companies that are not finished — all in the query — oldest first, limited", async () => {
    state.answers.push({ data: [{ id: "r1" }], error: null }, { data: [{ id: "n1" }], error: null }, { data: null, count: 40, error: null })
    const w = await readSweepWindow<{ id: string }>("tax_return_submissions", "id, account_id", { cutoffIso: "2026-01-01T00:00:00Z", realFilter: REAL })
    expect(w.candidates.map((r) => r.id)).toEqual(["r1", "n1"])
    expect(w.skippedFinished).toBe(40)
    const [withCompany, noCompany, finished] = state.queries
    // rows of a company that is not finished (status missing counts as not finished)
    expect(withCompany.select).toContain("accounts!inner(status)")
    expect(withCompany.calls).toContainEqual(["or", ["status.is.null,status.not.in.(Closed,Cancelled)", { referencedTable: "accounts" }]])
    // only real submissions; only rows whose one alert has not fired; only not-yet-archived, forward of the cutoff
    expect(withCompany.calls).toContainEqual(["or", [REAL]])
    expect(withCompany.calls).toContainEqual(["is", ["drive_archive_meta->>sweep_alerted", null]])
    expect(withCompany.calls).toContainEqual(["is", ["drive_archived_at", null]])
    expect(withCompany.calls).toContainEqual(["gte", ["created_at", "2026-01-01T00:00:00Z"]])
    expect(withCompany.calls).toContainEqual(["limit", [200]])
    // a completed row with NO company stays visible (the loud anomaly)
    expect(noCompany.calls).toContainEqual(["is", ["account_id", null]])
    expect(noCompany.calls).toContainEqual(["or", [REAL]])
    // the finished ones are only counted
    expect(finished.opts).toEqual({ count: "exact", head: true })
    // ONE finished rule (the enum labels in no-storage.ts); ilike would fail on the enum column
    expect(finished.calls).toContainEqual(["or", ["status.in.(Closed,Cancelled)", { referencedTable: "accounts" }]])
  })

  it("a table with no company column (a lead-stage form) gets one plain query: no join, no finished filter", async () => {
    state.answers.push({ data: [{ id: "f1" }], error: null })
    const w = await readSweepWindow<{ id: string }>("formation_submissions", "id", { cutoffIso: "2026-01-01", realFilter: "status.eq.completed", hasAccount: false })
    expect(w.candidates).toEqual([{ id: "f1" }])
    expect(state.queries).toHaveLength(1)
    expect(state.queries[0].select).not.toContain("accounts")
    expect(state.queries[0].calls).toContainEqual(["or", ["status.eq.completed"]])
  })

  it("a row that is in both result sets appears once", async () => {
    state.answers.push({ data: [{ id: "x" }], error: null }, { data: [{ id: "x" }], error: null }, { data: null, count: 0, error: null })
    const w = await readSweepWindow<{ id: string }>("banking_submissions", "id", { cutoffIso: "2026-01-01", realFilter: "status.in.(completed,reviewed)" })
    expect(w.candidates).toEqual([{ id: "x" }])
  })

  it("a read error is returned, never turned into 'nothing to do'", async () => {
    state.answers.push({ data: null, error: { message: "db down" } })
    const w = await readSweepWindow("banking_submissions", "id", { cutoffIso: "2026-01-01", realFilter: "status.in.(completed,reviewed)" })
    expect(w.readError).toBe("db down")
    expect(w.candidates).toEqual([])
  })
})
