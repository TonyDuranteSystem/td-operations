/**
 * readSweepWindows: the window is filtered in the QUERY — an inner join on the company with a folder / status filter — so
 * skipped rows can never fill it. Checked against a recording fake of the Supabase builder.
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
        for (const m of ["is", "gte", "not", "in", "order", "limit"]) c[m] = (...a: unknown[]) => { q.calls.push([m, a]); return c }
        c.then = (r: (v: unknown) => unknown) => Promise.resolve(state.answers.shift() ?? { data: [], count: 0, error: null }).then(r)
        return c
      },
    }),
  },
}))

import { readSweepWindows, raiseUnfiledAlarm } from "@/lib/archive/skip-no-drive-folder"

beforeEach(() => { state.queries.length = 0; state.answers.length = 0 })

describe("readSweepWindows", () => {
  it("asks for companies WITH a folder that are not Closed/Cancelled, oldest first, limited — in the query", async () => {
    state.answers.push({ data: [{ id: "r1" }], error: null }, { data: [{ id: "n1" }], error: null }, { data: null, count: 1500, error: null }, { data: null, count: 40, error: null })
    const w = await readSweepWindows<{ id: string }>("tax_return_submissions", "id, account_id", "2026-01-01T00:00:00Z")
    expect(w.withFolder).toEqual([{ id: "r1" }])
    expect(w.noFolder).toEqual([{ id: "n1" }])
    expect(w.skippedNoFolder).toBe(1500)
    expect(w.skippedFinished).toBe(40)
    const [withFolder, noFolder, countNo, countFin] = state.queries
    expect(withFolder.select).toContain("accounts!inner(drive_folder_id, status)")
    expect(withFolder.calls).toContainEqual(["not", ["accounts.drive_folder_id", "is", null]])
    expect(withFolder.calls).toContainEqual(["not", ["accounts.status", "in", "(Closed,Cancelled)"]])
    expect(withFolder.calls).toContainEqual(["limit", [200]])
    expect(withFolder.calls).toContainEqual(["is", ["drive_archived_at", null]])
    expect(withFolder.calls).toContainEqual(["gte", ["created_at", "2026-01-01T00:00:00Z"]])
    expect(noFolder.calls).toContainEqual(["is", ["accounts.drive_folder_id", null]])
    expect(noFolder.calls).toContainEqual(["not", ["accounts.status", "in", "(Closed,Cancelled)"]])
    expect(countNo.opts).toEqual({ count: "exact", head: true })
    expect(countFin.calls).toContainEqual(["in", ["accounts.status", ["Closed", "Cancelled"]]])
  })

  it("a read error is returned, never turned into 'nothing to do'", async () => {
    state.answers.push({ data: null, error: { message: "db down" } })
    const w = await readSweepWindows("banking_submissions", "id", "2026-01-01")
    expect(w.readError).toBe("db down")
    expect(w.withFolder).toEqual([])
  })
})

describe("raiseUnfiledAlarm", () => {
  it("does nothing for an empty list", async () => {
    await expect(raiseUnfiledAlarm("/x", "things", [])).resolves.toBeUndefined()
  })
})
