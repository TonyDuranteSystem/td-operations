/**
 * mergeArchiveMeta: the database function does `meta || patch` in one statement; where the function is not installed yet
 * (migration not run) it falls back to read-merge-write, keeping what the row already holds.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

const state = vi.hoisted(() => ({
  rpcResult: { error: null } as { error: { code?: string; message: string } | null },
  rpcCalls: [] as Array<{ fn: string; args: unknown }>,
  row: { drive_archive_meta: { attempts: 2, sweep_alerted: true } } as { drive_archive_meta: Record<string, unknown> | null } | null,
  written: [] as Array<{ table: string; payload: unknown }>,
}))

vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    rpc: async (fn: string, args: unknown) => { state.rpcCalls.push({ fn, args }); return state.rpcResult },
    from: (table: string) => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: state.row, error: null }) }) }),
      update: (payload: unknown) => ({ eq: async () => { state.written.push({ table, payload }); return { error: null } } }),
    }),
  },
}))

import { mergeArchiveMeta } from "@/lib/archive/meta-merge"

beforeEach(() => { state.rpcResult = { error: null }; state.rpcCalls.length = 0; state.written.length = 0; state.row = { drive_archive_meta: { attempts: 2, sweep_alerted: true } } })

describe("mergeArchiveMeta", () => {
  it("uses the one-statement database function when it exists", async () => {
    await mergeArchiveMeta("tax_return_submissions", "t1", { attempts: 3 })
    expect(state.rpcCalls).toEqual([{ fn: "archive_meta_merge", args: { p_table: "tax_return_submissions", p_id: "t1", p_patch: { attempts: 3 } } }])
    expect(state.written).toEqual([])
  })

  it("falls back to read-merge-write when the function is not installed — the alert flag survives an attempt record", async () => {
    state.rpcResult = { error: { code: "PGRST202", message: "Could not find the function public.archive_meta_merge" } }
    await mergeArchiveMeta("banking_submissions", "b1", { attempts: 3, last_error: "x" })
    expect(state.written).toEqual([{ table: "banking_submissions", payload: { drive_archive_meta: { attempts: 3, sweep_alerted: true, last_error: "x" } } }])
  })

  it("works on a row with no record yet", async () => {
    state.rpcResult = { error: { code: "42883", message: "function does not exist" } }
    state.row = { drive_archive_meta: null }
    await mergeArchiveMeta("banking_submissions", "b1", { filed_in: "storage" })
    expect(state.written[0].payload).toEqual({ drive_archive_meta: { filed_in: "storage" } })
  })

  it("any other database error is thrown, never swallowed", async () => {
    state.rpcResult = { error: { code: "XX000", message: "boom" } }
    await expect(mergeArchiveMeta("banking_submissions", "b1", {})).rejects.toThrow(/boom/)
  })
})
