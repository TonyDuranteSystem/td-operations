import { describe, it, expect, vi, beforeEach } from "vitest"

const state = vi.hoisted(() => ({ result: { data: null as null | { created_at: string }, error: null as null | { message: string } }, filters: {} as Record<string, unknown> }))

vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    from: () => {
      const b: Record<string, unknown> = {}
      for (const m of ["select", "order", "limit"]) b[m] = () => b
      b.eq = (k: string, v: unknown) => { state.filters[k] = v; return b }
      b.maybeSingle = async () => state.result
      return b
    },
  },
}))

import { latestSs4ResubmitAt, SS4_RESUBMIT_MARKER } from "@/lib/fax/ss4-resubmit-marker"

beforeEach(() => { state.result = { data: null, error: null }; state.filters = {} })

describe("latestSs4ResubmitAt", () => {
  it("returns null when the flow was never resubmitted", async () => {
    expect(await latestSs4ResubmitAt("sd-1")).toEqual({ at: null, error: null })
  })
  it("returns the latest marker time and looks only at this flow's marker rows", async () => {
    state.result = { data: { created_at: "2026-10-28T16:00:00Z" }, error: null }
    expect(await latestSs4ResubmitAt("sd-1")).toEqual({ at: "2026-10-28T16:00:00Z", error: null })
    expect(state.filters).toEqual({ action_type: SS4_RESUBMIT_MARKER, service_delivery_id: "sd-1" })
  })
  it("a read error is reported (callers must not read it as 'never resubmitted')", async () => {
    state.result = { data: null, error: { message: "db down" } }
    expect(await latestSs4ResubmitAt("sd-1")).toEqual({ at: null, error: "db down" })
  })
})
