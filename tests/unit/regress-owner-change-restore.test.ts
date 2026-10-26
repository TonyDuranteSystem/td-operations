import { describe, it, expect, vi, beforeEach } from "vitest"

const alarm = vi.fn(async () => {})
let rpcError: { message: string } | null = null
let updateError: { message: string } | null = null

vi.mock("@/lib/supabase-admin", () => {
  const table = (name: string) => ({
    select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { published: true }, error: null }), then: undefined }) }),
    update: () => ({ eq: async () => ({ error: name === "documents" ? updateError : null }) }),
  })
  return { supabaseAdmin: { from: (n: string) => table(n), rpc: async () => ({ error: rpcError }) } }
})
vi.mock("@/lib/crm-store/event-log", async () => {
  const actual = await vi.importActual<typeof import("@/lib/crm-store/event-log")>("@/lib/crm-store/event-log")
  return { ...actual, rollBackOrAlarm: (what: string, d: Record<string, unknown>, step: Parameters<typeof actual.rollBackOrAlarm>[2]) => actual.rollBackOrAlarm(what, d, step, { alarm }) }
})

import { hideForOwnerChange, RESTORE_FAILED_NOTE } from "@/lib/crm-store/owner-change-hide"

describe("hideForOwnerChange().restore() checks its own results (task 5a)", () => {
  beforeEach(() => { alarm.mockClear(); rpcError = null; updateError = null })

  it("a restore that works answers true and raises no alarm", async () => {
    // the select chain of this fake returns a published file and no CRM rows
    const fake = await import("@/lib/supabase-admin")
    ;(fake.supabaseAdmin as unknown as { from: (n: string) => unknown }).from = (n: string) => ({
      select: () => ({ eq: (..._a: unknown[]) => (n === "store_files" ? { maybeSingle: async () => ({ data: { published: true }, error: null }) } : Promise.resolve({ data: [{ id: "d1", portal_visible: true, flow_stage: null, client_notified_at: null }], error: null })) }),
      update: () => ({ eq: async () => ({ error: updateError }) }),
    })
    const h = await hideForOwnerChange("11111111-1111-1111-1111-111111111111", null)
    expect(h.note).toBeTruthy()
    expect(await h.restore()).toBe(true)
    expect(alarm).not.toHaveBeenCalled()
  })

  it("a failed put-back raises an alarm and answers false", async () => {
    const fake = await import("@/lib/supabase-admin")
    ;(fake.supabaseAdmin as unknown as { from: (n: string) => unknown }).from = (n: string) => ({
      select: () => ({ eq: (..._a: unknown[]) => (n === "store_files" ? { maybeSingle: async () => ({ data: { published: true }, error: null }) } : Promise.resolve({ data: [{ id: "d1", portal_visible: true, flow_stage: null, client_notified_at: null }], error: null })) }),
      update: () => ({ eq: async () => ({ error: updateError }) }),
    })
    const h = await hideForOwnerChange("11111111-1111-1111-1111-111111111111", null)
    rpcError = { message: "store: nope" }
    updateError = { message: "db down" }
    expect(await h.restore()).toBe(false)
    expect(alarm).toHaveBeenCalled()
    expect(RESTORE_FAILED_NOTE).toMatch(/stays hidden/)
  })
})
