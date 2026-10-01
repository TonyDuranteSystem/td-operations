/**
 * app/(dashboard)/accounts/actions.ts — the two ways staff touch a company's suite:
 *   issueCompanySuite  — any staff member; the system picks the number (nobody types one)
 *   changeCompanySuite — OWNER ONLY, reason required; the one logged way to change a locked suite
 * and: the free-text "suite_number" field edit no longer exists.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }))
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }))

let ownerUser = true
vi.mock("@/lib/supabase/server", () => ({
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: { email: ownerUser ? "antonio.durante@tonydurante.us" : "luca@tonydurante.us" } } }) },
  }),
}))
vi.mock("@/lib/auth", () => ({ isOwnerOnly: () => ownerUser }))

const allocateCompanySuite = vi.fn()
const adminChangeCompanySuite = vi.fn()
const syncPhysicalAddressToSuite = vi.fn()
vi.mock("@/lib/operations/suite", () => ({
  allocateCompanySuite: (...a: unknown[]) => allocateCompanySuite(...a),
  adminChangeCompanySuite: (...a: unknown[]) => adminChangeCompanySuite(...a),
  syncPhysicalAddressToSuite: (...a: unknown[]) => syncPhysicalAddressToSuite(...a),
}))

const accountUpdates: Array<Record<string, unknown>> = []
vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    from: () => {
      const chain: Record<string, unknown> = {}
      Object.assign(chain, {
        select: () => chain,
        update: (p: Record<string, unknown>) => {
          accountUpdates.push(p)
          return chain
        },
        eq: () => chain,
        maybeSingle: () => Promise.resolve({ data: null, error: null }),
        single: () => Promise.resolve({ data: null, error: null }),
        then: (r: (v: unknown) => unknown) => r({ data: null, error: null }),
      })
      return chain
    },
  },
}))
// the rest of actions.ts's imports are irrelevant here
vi.mock("@/lib/server-action", () => ({ safeAction: vi.fn(), updateWithLock: vi.fn() }))
vi.mock("@/lib/jobs/validation", () => ({ normalizeEIN: vi.fn() }))
vi.mock("@/lib/operations/ein-received", () => ({ triggerEINReceivedWorkflow: vi.fn() }))
vi.mock("@/lib/operations/sync-tier", () => ({ syncTier: vi.fn(), syncContactTiersForAccount: vi.fn() }))
vi.mock("@/lib/operations/portal-login-email", () => ({ syncPortalLoginEmail: vi.fn() }))
vi.mock("@/lib/operations/service-delivery", () => ({ createSD: vi.fn() }))
vi.mock("@/lib/operations/account", () => ({ createAccount: vi.fn(), createAndLinkContact: vi.fn() }))
vi.mock("@/lib/operations/renewal-dates", () => ({ setAccountRenewalDate: vi.fn() }))

import { issueCompanySuite, changeCompanySuite, updateAccountField } from "@/app/(dashboard)/accounts/actions"

beforeEach(() => {
  ownerUser = true
  allocateCompanySuite.mockReset()
  adminChangeCompanySuite.mockReset()
  syncPhysicalAddressToSuite.mockReset()
  accountUpdates.length = 0
})

describe("issueCompanySuite", () => {
  it("asks the allocator (nobody types a number) and keeps the address in step", async () => {
    allocateCompanySuite.mockResolvedValue("3D-400")
    const res = await issueCompanySuite("acct-1")
    expect(res).toMatchObject({ success: true, suite: "3D-400" })
    expect(allocateCompanySuite).toHaveBeenCalledWith(expect.objectContaining({ accountId: "acct-1" }))
    expect(syncPhysicalAddressToSuite).toHaveBeenCalledWith("acct-1", "3D-400")
  })

  it("reports the real reason when the allocator fails", async () => {
    allocateCompanySuite.mockRejectedValue(new Error("Could not issue a suite: down"))
    const res = await issueCompanySuite("acct-1")
    expect(res.success).toBe(false)
    expect(res.error).toContain("Could not issue a suite")
  })
})

describe("changeCompanySuite — owner only, reason required", () => {
  it("refuses anyone but the owner, and never calls the database", async () => {
    ownerUser = false
    const res = await changeCompanySuite("acct-1", "3D-500", "moved")
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/only the owner/i)
    expect(adminChangeCompanySuite).not.toHaveBeenCalled()
  })

  it("refuses an empty reason", async () => {
    const res = await changeCompanySuite("acct-1", "3D-500", "   ")
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/reason/i)
    expect(adminChangeCompanySuite).not.toHaveBeenCalled()
  })

  it("the owner changes it with a reason, and is told how many signed leases still show the old suite", async () => {
    adminChangeCompanySuite.mockResolvedValue({ changed: true, old: "3D-115", new: "3D-500", signed_leases_to_replace: 1 })
    const res = await changeCompanySuite("acct-1", "3D-500", "  shared with another company ")
    expect(res).toMatchObject({ success: true, signedLeasesToReplace: 1 })
    expect(adminChangeCompanySuite).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: "acct-1", newSuite: "3D-500", reason: "shared with another company" }),
    )
    expect(syncPhysicalAddressToSuite).toHaveBeenCalledWith("acct-1", "3D-500")
  })

  it("the owner can take the suite off a company (null) — the address is not rewritten", async () => {
    adminChangeCompanySuite.mockResolvedValue({ changed: true, old: "3D-235", new: null, signed_leases_to_replace: 0 })
    const res = await changeCompanySuite("acct-1", null, "no suite for one-time accounts")
    expect(res.success).toBe(true)
    expect(syncPhysicalAddressToSuite).not.toHaveBeenCalled()
  })

  it("passes the database's own refusal (e.g. another company holds it) straight through", async () => {
    adminChangeCompanySuite.mockRejectedValue(new Error("Suite 3D-210 already belongs to another company"))
    const res = await changeCompanySuite("acct-1", "3D-210", "x")
    expect(res.success).toBe(false)
    expect(res.error).toContain("already belongs to another company")
  })
})

describe("the free-text suite edit is gone", () => {
  it("updateAccountField refuses suite_number — nobody can type a suite into Company Info", async () => {
    const res = await updateAccountField("acct-1", "suite_number", "3D-999", "2026-01-01T00:00:00Z")
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/not editable/i)
    expect(accountUpdates).toHaveLength(0)
  })
})
