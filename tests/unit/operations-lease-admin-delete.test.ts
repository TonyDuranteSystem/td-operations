/**
 * deleteLeaseAsAdmin (lib/operations/lease.ts) — the owner-only, logged deletion of a lease that has already
 * gone to the client. The owner check lives in the route (tested with the route); this covers: a reason is
 * required, the database delete is called, the signed PDF is HIDDEN (never deleted), and a refusal is passed
 * straight through.
 */
import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }))

let leaseRow: Record<string, unknown> | null = null
let leaseReadError: { message: string } | null = null
let hiddenDocs: Array<{ id: string }> = []
const docUpdates: Array<Record<string, unknown>> = []
const docFilters: Array<[string, unknown]> = []
const logCalls: Array<Record<string, unknown>> = []
const adminDeleteLease = vi.fn()

vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      const chain: Record<string, unknown> = {}
      Object.assign(chain, {
        select: () => chain,
        update: (p: Record<string, unknown>) => {
          docUpdates.push(p)
          return chain
        },
        eq: (c: string, v: unknown) => {
          docFilters.push([c, v])
          return chain
        },
        ilike: (c: string, v: unknown) => {
          docFilters.push([c, v])
          return chain
        },
        maybeSingle: () => Promise.resolve({ data: leaseRow, error: leaseReadError }),
        then: (resolve: (v: unknown) => unknown) => resolve(table === "documents" ? { data: hiddenDocs, error: null } : { data: null, error: null }),
      })
      return chain
    },
  },
}))
vi.mock("@/lib/mcp/action-log", () => ({ logAction: (p: Record<string, unknown>) => logCalls.push(p) }))
vi.mock("@/lib/operations/suite", async () => {
  const actual = await vi.importActual<typeof import("@/lib/operations/suite")>("@/lib/operations/suite")
  return { ...actual, adminDeleteLease: (...a: unknown[]) => adminDeleteLease(...a) }
})

import { deleteLeaseAsAdmin } from "@/lib/operations/lease"

beforeEach(() => {
  leaseRow = { id: "L1", status: "signed", account_id: "A1", suite_number: "3D-115", tenant_company: "SEuforia LLC", contract_year: 2026 }
  leaseReadError = null
  hiddenDocs = [{ id: "D1" }]
  docUpdates.length = 0
  docFilters.length = 0
  logCalls.length = 0
  adminDeleteLease.mockReset()
  adminDeleteLease.mockResolvedValue({ deleted: true, status: "signed", suite: "3D-115", account_id: "A1", token: "t" })
})

describe("deleteLeaseAsAdmin", () => {
  it("requires a reason and touches nothing without one", async () => {
    const res = await deleteLeaseAsAdmin({ token: "t", reason: "   ", actor: "owner" })
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/reason/i)
    expect(adminDeleteLease).not.toHaveBeenCalled()
  })

  it("reports a missing lease", async () => {
    leaseRow = null
    const res = await deleteLeaseAsAdmin({ token: "nope", reason: "x", actor: "owner" })
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/not found/i)
    expect(adminDeleteLease).not.toHaveBeenCalled()
  })

  it("deletes through the logged database function, then HIDES (never deletes) the lease's signed PDF, and logs it", async () => {
    const res = await deleteLeaseAsAdmin({ token: "t", reason: "  shared suite  ", actor: "dashboard:antonio" })
    expect(res.success).toBe(true)
    expect(res.documentsHidden).toBe(1)
    expect(adminDeleteLease).toHaveBeenCalledWith({ leaseId: "L1", reason: "shared suite", actor: "dashboard:antonio" })
    expect(docUpdates).toEqual([{ portal_visible: false }])
    expect(docFilters).toContainEqual(["file_name", "%(Suite 3D-115%"])
    expect(docFilters).toContainEqual(["account_id", "A1"])
    expect(logCalls).toHaveLength(1)
    expect(logCalls[0].action_type).toBe("delete")
  })

  it("passes the database's refusal straight through and hides nothing", async () => {
    adminDeleteLease.mockRejectedValue(new Error("lease L1 not found"))
    const res = await deleteLeaseAsAdmin({ token: "t", reason: "x", actor: "owner" })
    expect(res.success).toBe(false)
    expect(res.error).toContain("not found")
    expect(docUpdates).toHaveLength(0)
    expect(logCalls).toHaveLength(0)
  })
})
