/**
 * Task 918fe55e / P3.4 new item — reconcile-invoice-mirror route tests.
 *
 * Covers: admin auth gating (403), input validation (payment_id
 * required), delegation to the operations helper, action_log payload
 * shape, and the response message branches (changed vs no-drift).
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

// ─── Fixture state ─────────────────────────────────────

let authUserFixture: { id: string; email: string | null } | null = null
let isAdminReturn = true
let reconcileResult = {
  success: true,
  payment_id: "pay-1",
  changed: false,
  before: { ce_status: "Overdue" as string | null, ce_paid_date: null as string | null },
  after: { ce_status: "Overdue" as string | null, ce_paid_date: null as string | null },
  error: undefined as string | undefined,
}
let lastActionLogInsert: Record<string, unknown> | null = null

vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({
    auth: {
      getUser: vi.fn(() => Promise.resolve({ data: { user: authUserFixture }, error: null })),
    },
  }),
}))

vi.mock("@/lib/auth", () => ({
  isAdmin: vi.fn(() => isAdminReturn),
}))

vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      if (table === "action_log") {
        return {
          insert: vi.fn((payload: Record<string, unknown>) => {
            lastActionLogInsert = payload
            return Promise.resolve({ data: null, error: null })
          }),
        }
      }
      return {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn().mockReturnThis(),
        single: vi.fn(() => Promise.resolve({ data: null, error: null })),
      }
    },
  },
}))

vi.mock("@/lib/operations/payment", () => ({
  reconcileInvoiceMirror: vi.fn(() => Promise.resolve(reconcileResult)),
}))

import { POST } from "@/app/api/crm/admin-actions/reconcile-invoice-mirror/route"

function makeRequest(body: unknown): Request {
  return new Request("http://localhost/api/crm/admin-actions/reconcile-invoice-mirror", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  authUserFixture = { id: "admin-1", email: "admin@tonydurante.us" }
  isAdminReturn = true
  reconcileResult = {
    success: true,
    payment_id: "pay-1",
    changed: false,
    before: { ce_status: "Overdue", ce_paid_date: null },
    after: { ce_status: "Overdue", ce_paid_date: null },
    error: undefined,
  }
  lastActionLogInsert = null
})

describe("reconcile-invoice-mirror — auth + validation", () => {
  it("returns 403 when not admin", async () => {
    isAdminReturn = false
    const res = await POST(makeRequest({ payment_id: "pay-1" }) as Parameters<typeof POST>[0])
    expect(res.status).toBe(403)
  })

  it("returns 400 when payment_id missing", async () => {
    const res = await POST(makeRequest({}) as Parameters<typeof POST>[0])
    expect(res.status).toBe(400)
  })
})

describe("reconcile-invoice-mirror — delegation + response", () => {
  it("returns no-drift message when mirror already matches", async () => {
    reconcileResult.changed = false
    const res = await POST(makeRequest({ payment_id: "pay-1" }) as Parameters<typeof POST>[0])
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.success).toBe(true)
    expect(body.changed).toBe(false)
    expect(body.message).toMatch(/no drift/i)
  })

  it("returns reconciled message when mirror was updated", async () => {
    reconcileResult.changed = true
    reconcileResult.after = { ce_status: "Paid", ce_paid_date: "2026-04-01" }
    const res = await POST(makeRequest({ payment_id: "pay-1" }) as Parameters<typeof POST>[0])
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.changed).toBe(true)
    expect(body.message).toMatch(/Overdue.*Paid/)
  })

  it("returns 500 when reconcile fails", async () => {
    reconcileResult = { ...reconcileResult, success: false, error: "Payment not found" }
    const res = await POST(makeRequest({ payment_id: "missing" }) as Parameters<typeof POST>[0])
    expect(res.status).toBe(500)
  })
})

describe("reconcile-invoice-mirror — action_log", () => {
  it("writes an action_log row with actor + payment_id + before/after + reason", async () => {
    reconcileResult.changed = true
    await POST(
      makeRequest({ payment_id: "pay-1", reason: "test reason" }) as Parameters<typeof POST>[0],
    )
    expect(lastActionLogInsert).not.toBeNull()
    expect(lastActionLogInsert).toMatchObject({
      action_type: "update",
      table_name: "client_expenses",
      record_id: "pay-1",
    })
    expect(lastActionLogInsert?.actor).toMatch(/^dashboard:/)
    const details = lastActionLogInsert?.details as Record<string, unknown>
    expect(details.payment_id).toBe("pay-1")
    expect(details.changed).toBe(true)
    expect(details.reason).toBe("test reason")
  })
})
