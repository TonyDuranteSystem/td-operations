/**
 * TD Social — reading and writing one person's switches (dev job 2072bc3e, Step 2 pull request B).
 * Writes go through the two database functions (key-by-key merge; a time that only moves forward); errors are errors.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

const h = vi.hoisted(() => ({
  row: { data: null as unknown, error: null as null | { code?: string } },
  rpc: { data: null as unknown, error: null as null | { code?: string } },
  calls: [] as Array<{ op: string; args: unknown[] }>,
}))

vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    from: (t: string) => {
      h.calls.push({ op: "from", args: [t] })
      const c: Record<string, unknown> = {}
      c.select = (...a: unknown[]) => { h.calls.push({ op: "select", args: a }); return c }
      c.eq = (...a: unknown[]) => { h.calls.push({ op: "eq", args: a }); return c }
      c.maybeSingle = async () => h.row
      return c
    },
    rpc: async (fn: string, args: unknown) => { h.calls.push({ op: "rpc", args: [fn, args] }); return h.rpc },
  },
}))

import { readState, mergePrefs, markInboxOpened } from "@/lib/app/state"

beforeEach(() => { h.row = { data: null, error: null }; h.rpc = { data: null, error: null }; h.calls = [] })

describe("readState", () => {
  it("reads only THIS person's row", async () => {
    h.row = { data: { muted_tabs: ["talk"], alerts: { whatsapp: false }, inbox_opened: {} }, error: null }
    expect(await readState("u1")).toEqual({ muted_tabs: ["talk"], alerts: { whatsapp: false }, inbox_opened: {} })
    expect(h.calls.find(c => c.op === "eq")?.args).toEqual(["user_id", "u1"])
  })

  it("no row yet is null (everything is the rule defaults)", async () => {
    expect(await readState("u1")).toBeNull()
  })

  it("a database error is thrown, never turned into 'no row'", async () => {
    h.row = { data: null, error: { code: "42P01" } }
    await expect(readState("u1")).rejects.toThrow(/42P01/)
  })
})

describe("mergePrefs", () => {
  it("calls the key-by-key merge function with the person and the patch", async () => {
    await mergePrefs("u1", { mute: { talk: true }, alerts: { whatsapp: false } })
    expect(h.calls.find(c => c.op === "rpc")?.args).toEqual(["social_app_merge_prefs", { p_user: "u1", p_mute: { talk: true }, p_alerts: { whatsapp: false } }])
  })

  it("an error is thrown", async () => {
    h.rpc = { data: null, error: { code: "XX000" } }
    await expect(mergePrefs("u1", { mute: {}, alerts: { whatsapp: true } })).rejects.toThrow(/XX000/)
  })
})

describe("markInboxOpened", () => {
  it("sends the time as an ISO string and passes only-if-missing through", async () => {
    h.rpc = { data: "2026-11-05T12:00:00+00:00", error: null }
    const at = new Date("2026-11-05T12:00:00Z")
    expect(await markInboxOpened("u1", "support", at)).toBe("2026-11-05T12:00:00+00:00")
    expect(h.calls.find(c => c.op === "rpc")?.args).toEqual(["social_app_mark_inbox_opened", { p_user: "u1", p_mailbox: "support", p_at: "2026-11-05T12:00:00.000Z", p_only_if_missing: false }])
    await markInboxOpened("u1", "antonio", at, true)
    expect((h.calls.filter(c => c.op === "rpc")[1].args[1] as Record<string, unknown>).p_only_if_missing).toBe(true)
  })

  it("returns null when the function gives back nothing usable; an error is thrown", async () => {
    h.rpc = { data: 5, error: null }
    expect(await markInboxOpened("u1", "support", new Date())).toBeNull()
    h.rpc = { data: null, error: { code: "XX000" } }
    await expect(markInboxOpened("u1", "support", new Date())).rejects.toThrow(/XX000/)
  })
})
