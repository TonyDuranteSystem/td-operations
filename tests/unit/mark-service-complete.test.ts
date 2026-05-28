/**
 * markServiceComplete — completes a service delivery IN PLACE (status='completed'
 * + end_date + appended note) WITHOUT advancing the stage, so it fires NO
 * stage-advance side-effects. Used by the Flexible Formation flow (Antonio
 * 2026-05-28): the Company Formation SD completes at EIN received, instead of
 * advancing into the (now-decoupled) "Post-Formation + Banking" stage.
 *
 * Idempotent (already_completed → success), TOCTOU-guarded on status.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

interface SdRow {
  id: string
  status: string
  notes: string | null
}

const fixtures: {
  sd: SdRow | null
  readError: { message: string } | null
  updateReturnsRow: boolean
  updateError: { message: string } | null
} = { sd: null, readError: null, updateReturnsRow: true, updateError: null }

const recorded: { patch?: Record<string, unknown>; eqs: Array<[string, unknown]> } = { eqs: [] }

vi.mock("@/lib/supabase-admin", () => {
  const builder = () => {
    const b: Record<string, unknown> = {}
    let isUpdate = false
    b.select = () => b
    b.update = (patch: Record<string, unknown>) => {
      isUpdate = true
      recorded.patch = patch
      return b
    }
    b.eq = (col: string, val: unknown) => {
      if (isUpdate) recorded.eqs.push([col, val])
      return b
    }
    b.maybeSingle = async () => {
      if (isUpdate) {
        return {
          data: fixtures.updateReturnsRow ? { id: fixtures.sd?.id } : null,
          error: fixtures.updateError,
        }
      }
      return { data: fixtures.sd, error: fixtures.readError }
    }
    return b
  }
  return { supabaseAdmin: { from: () => builder() } }
})

import { markServiceComplete } from "@/lib/operations/service-delivery"

beforeEach(() => {
  fixtures.sd = null
  fixtures.readError = null
  fixtures.updateReturnsRow = true
  fixtures.updateError = null
  recorded.patch = undefined
  recorded.eqs = []
})

describe("markServiceComplete", () => {
  it("active SD → completed: sets status + end_date + appends note", async () => {
    fixtures.sd = { id: "sd-1", status: "active", notes: "existing note" }
    const res = await markServiceComplete({ delivery_id: "sd-1", actor: "antonio", reason: "EIN received" })

    expect(res.success).toBe(true)
    expect(res.outcome).toBe("completed")
    expect(recorded.patch?.status).toBe("completed")
    expect(typeof recorded.patch?.end_date).toBe("string")
    // Note appended below the existing note, carrying the reason + actor.
    expect(String(recorded.patch?.notes)).toContain("existing note")
    expect(String(recorded.patch?.notes)).toContain("EIN received")
    expect(String(recorded.patch?.notes)).toContain("antonio")
    // TOCTOU guard: the UPDATE is filtered on the previously-read status.
    expect(recorded.eqs).toContainEqual(["status", "active"])
  })

  it("starts a fresh note when the SD has no notes", async () => {
    fixtures.sd = { id: "sd-1", status: "active", notes: null }
    const res = await markServiceComplete({ delivery_id: "sd-1" })
    expect(res.success).toBe(true)
    expect(String(recorded.patch?.notes)).toContain("Marked complete in place")
  })

  it("already completed → success, no-op (no update issued)", async () => {
    fixtures.sd = { id: "sd-1", status: "completed", notes: null }
    const res = await markServiceComplete({ delivery_id: "sd-1" })
    expect(res.success).toBe(true)
    expect(res.outcome).toBe("already_completed")
    expect(recorded.patch).toBeUndefined()
  })

  it("cancelled SD → failure, no update", async () => {
    fixtures.sd = { id: "sd-1", status: "cancelled", notes: null }
    const res = await markServiceComplete({ delivery_id: "sd-1" })
    expect(res.success).toBe(false)
    expect(res.outcome).toBe("cancelled")
    expect(recorded.patch).toBeUndefined()
  })

  it("missing SD → not_found", async () => {
    fixtures.sd = null
    const res = await markServiceComplete({ delivery_id: "nope" })
    expect(res.success).toBe(false)
    expect(res.outcome).toBe("not_found")
  })

  it("read error → error outcome", async () => {
    fixtures.readError = { message: "boom" }
    const res = await markServiceComplete({ delivery_id: "sd-1" })
    expect(res.success).toBe(false)
    expect(res.outcome).toBe("error")
    expect(res.error).toBe("boom")
  })

  it("TOCTOU: status changed concurrently (update returns no row) → error", async () => {
    fixtures.sd = { id: "sd-1", status: "active", notes: null }
    fixtures.updateReturnsRow = false
    const res = await markServiceComplete({ delivery_id: "sd-1" })
    expect(res.success).toBe(false)
    expect(res.outcome).toBe("error")
    expect(res.error).toMatch(/concurrently/i)
  })
})
