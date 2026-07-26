/**
 * Unit tests for sendLeaseToPortal() in lib/operations/lease.ts
 *
 * Covers: lease-not-found / already-in-portal (sent, viewed, signed) no-op /
 * missing-tenant-email / happy-path draft→sent (+ action log + response fields) /
 * TOCTOU guard lost the race, re-read classifies honestly.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }))

// ─── Mock state ──────────────────────────────────────────

let leaseRow:
  | {
      id: string
      status: string
      tenant_email: string | null
      tenant_company: string
      account_id: string
      access_code: string
    }
  | null = null
let updateReturnsRows: Array<{ id: string }> = []
let updateError: { message: string } | null = null
// What a re-read (select "status") sees after a lost draft→sent race.
let rereadStatus: string | null = null

const updateCalls: Array<Record<string, unknown>> = []
const actionLogCalls: Array<Record<string, unknown>> = []

// ─── Mocks ───────────────────────────────────────────────

vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    from: () => {
      const chain: Record<string, unknown> = {}
      let pendingUpdate: Record<string, unknown> | null = null
      let selectCols = ""

      Object.assign(chain, {
        select: vi.fn((cols: string) => {
          selectCols = cols
          return chain
        }),
        update: vi.fn((payload: Record<string, unknown>) => {
          pendingUpdate = payload
          return chain
        }),
        eq: vi.fn(() => chain),
        single: vi.fn(() => {
          // The lost-race re-read selects only "status".
          if (selectCols === "status") {
            return Promise.resolve({
              data: rereadStatus ? { status: rereadStatus } : null,
              error: null,
            })
          }
          return Promise.resolve({
            data: leaseRow,
            error: leaseRow ? null : { message: "no rows" },
          })
        }),
        then: (resolve: (v: unknown) => void) => resolve(resolveValue()),
      })

      function resolveValue() {
        if (pendingUpdate) {
          updateCalls.push(pendingUpdate)
          pendingUpdate = null
          return { data: updateError ? null : updateReturnsRows, error: updateError }
        }
        return { data: leaseRow, error: null }
      }

      return chain
    },
  },
}))

vi.mock("@/lib/mcp/action-log", () => ({
  logAction: vi.fn((params: Record<string, unknown>) => {
    actionLogCalls.push(params)
  }),
}))

beforeEach(() => {
  leaseRow = {
    id: "lease-1",
    status: "draft",
    tenant_email: "jane@example.com",
    tenant_company: "Example LLC",
    account_id: "acct-1",
    access_code: "abc123",
  }
  updateReturnsRows = [{ id: "lease-1" }]
  updateError = null
  rereadStatus = null
  updateCalls.length = 0
  actionLogCalls.length = 0
})

describe("sendLeaseToPortal", () => {
  it("errors when the lease is not found", async () => {
    leaseRow = null
    const { sendLeaseToPortal } = await import("@/lib/operations/lease")
    const result = await sendLeaseToPortal("missing-token")
    expect(result.success).toBe(false)
    expect(result.error).toContain("not found")
    expect(updateCalls.length).toBe(0)
  })

  it.each(["sent", "viewed", "signed"])(
    "is a no-op success when the lease is already %s (never re-flips)",
    async (status) => {
      leaseRow!.status = status
      const { sendLeaseToPortal } = await import("@/lib/operations/lease")
      const result = await sendLeaseToPortal("example-llc-2026")
      expect(result.success).toBe(true)
      expect(result.already).toBe(true)
      expect(result.status).toBe(status)
      expect(updateCalls.length).toBe(0)
      expect(actionLogCalls.length).toBe(0)
    },
  )

  it("errors when the draft lease has no tenant email", async () => {
    leaseRow!.tenant_email = null
    const { sendLeaseToPortal } = await import("@/lib/operations/lease")
    const result = await sendLeaseToPortal("example-llc-2026")
    expect(result.success).toBe(false)
    expect(result.error).toContain("tenant email")
    expect(updateCalls.length).toBe(0)
  })

  it("flips a draft to sent, logs the action, and returns response fields", async () => {
    const { sendLeaseToPortal } = await import("@/lib/operations/lease")
    const result = await sendLeaseToPortal("example-llc-2026")
    expect(result.success).toBe(true)
    expect(result.status).toBe("sent")
    expect(result.already).toBeFalsy()
    expect(result.lease_id).toBe("lease-1")
    expect(result.access_code).toBe("abc123")
    expect(result.recipient).toBe("jane@example.com")
    expect(result.token).toBe("example-llc-2026")
    expect(updateCalls.length).toBe(1)
    expect(updateCalls[0]).toEqual({ status: "sent" })
    expect(actionLogCalls.length).toBe(1)
    expect(actionLogCalls[0].details).toMatchObject({ channel: "portal" })
  })

  it("treats a lost race that landed on 'sent' as a no-op success (no double log)", async () => {
    updateReturnsRows = []
    rereadStatus = "sent"
    const { sendLeaseToPortal } = await import("@/lib/operations/lease")
    const result = await sendLeaseToPortal("example-llc-2026")
    expect(result.success).toBe(true)
    expect(result.already).toBe(true)
    expect(result.status).toBe("sent")
    expect(updateCalls.length).toBe(1)
    expect(actionLogCalls.length).toBe(0)
  })

  it("errors (does not falsely report sent) when a lost race left the row un-flipped", async () => {
    updateReturnsRows = []
    rereadStatus = "draft"
    const { sendLeaseToPortal } = await import("@/lib/operations/lease")
    const result = await sendLeaseToPortal("example-llc-2026")
    expect(result.success).toBe(false)
    expect(result.error).toContain("draft")
    expect(actionLogCalls.length).toBe(0)
  })
})
