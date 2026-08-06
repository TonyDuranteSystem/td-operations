/**
 * WS-D adversarial QA matrix — cell 6, manual linking semantics (dev job c0a61e44).
 * Actions exercised directly with supabaseAdmin mocked; asserts the exact writes.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

interface State {
  lead: { circleback_call_id: string | null }
  updates: Array<{ table: string; values: Record<string, unknown> }>
}
const state: State = { lead: { circleback_call_id: null }, updates: [] }

vi.mock("next/cache", () => ({ revalidatePath: () => undefined }))
vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- test double
      const o: any = {}
      for (const m of ["select", "eq", "order", "limit", "ilike"]) o[m] = () => o
      o.single = async () =>
        table === "leads" ? { data: state.lead, error: null } : { data: null, error: null }
      o.maybeSingle = o.single
      o.update = (values: Record<string, unknown>) => {
        state.updates.push({ table, values })
        return o
      }
      o.then = (res: (v: unknown) => unknown) => Promise.resolve({ data: [], error: null }).then(res)
      return o
    },
  },
}))

import { linkCallToLead, unlinkCallFromLead } from "@/app/(dashboard)/leads/[id]/actions"

beforeEach(() => {
  state.lead = { circleback_call_id: null }
  state.updates.length = 0
})

describe("cell 6 — manual linking is additive with a primary pointer", () => {
  it("pointer EMPTY → link sets the pointer AND the call row, clearing the review marker", async () => {
    const r = await linkCallToLead("lead-1", "call-9")
    expect(r.success).toBe(true)
    const leadWrite = state.updates.find(u => u.table === "leads")
    const callWrite = state.updates.find(u => u.table === "call_summaries")
    expect(leadWrite?.values).toMatchObject({ circleback_call_id: "call-9" })
    expect(callWrite?.values).toMatchObject({ lead_id: "lead-1", link_review: null })
  })

  it("pointer ALREADY SET → a second link never replaces it; the call row is still linked (additive)", async () => {
    state.lead = { circleback_call_id: "call-first" }
    const r = await linkCallToLead("lead-1", "call-second")
    expect(r.success).toBe(true)
    expect(state.updates.find(u => u.table === "leads")).toBeUndefined()
    expect(state.updates.find(u => u.table === "call_summaries")?.values).toMatchObject({
      lead_id: "lead-1",
      link_review: null,
    })
  })
})

// ─── Hunter re-attack additions (findings 1, 2, 8) ───

describe("cell 6 — unlink targets a specific call (hunter finding 2)", () => {
  it("unlinking the POINTER call clears both the pointer and the call row", async () => {
    state.lead = { circleback_call_id: "call-A" }
    const r = await unlinkCallFromLead("lead-1", "call-A")
    expect(r.success).toBe(true)
    expect(state.updates.find(u => u.table === "leads")?.values).toMatchObject({ circleback_call_id: null })
    expect(state.updates.find(u => u.table === "call_summaries")?.values).toMatchObject({ lead_id: null })
  })

  it("unlinking a NON-pointer call clears only that call — the pointer survives (was a dead-end)", async () => {
    state.lead = { circleback_call_id: "call-A" }
    const r = await unlinkCallFromLead("lead-1", "call-B")
    expect(r.success).toBe(true)
    expect(state.updates.find(u => u.table === "leads")).toBeUndefined()
    expect(state.updates.find(u => u.table === "call_summaries")?.values).toMatchObject({ lead_id: null })
  })

  it("legacy no-param call falls back to the pointer; nothing linked → honest error", async () => {
    state.lead = { circleback_call_id: null }
    const r = await unlinkCallFromLead("lead-1")
    expect(r.success).toBe(false)
    expect(r.error).toBe("No call linked")
  })

  it("unlink → relink cycle: relink after unlink re-sets the pointer (was empty again)", async () => {
    state.lead = { circleback_call_id: "call-A" }
    await unlinkCallFromLead("lead-1", "call-A")
    state.lead = { circleback_call_id: null }
    const r = await linkCallToLead("lead-1", "call-A")
    expect(r.success).toBe(true)
    const leadWrites = state.updates.filter(u => u.table === "leads")
    expect(leadWrites[leadWrites.length - 1]?.values).toMatchObject({ circleback_call_id: "call-A" })
  })
})
