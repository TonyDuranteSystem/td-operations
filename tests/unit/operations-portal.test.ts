/**
 * P1.6 — lib/operations/portal.ts unit tests
 *
 * Focus: reconcileTier (the new helper added in P1.6 — the other exports
 * are thin re-exports of already-tested functions in
 * lib/portal/auto-create.ts).
 *
 * After Step 3 migration, reconcileTier delegates tier writes to syncTier.
 * This test mocks syncTier and verifies reconcileTier's orchestration logic.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import type { SyncTierResult } from "@/lib/operations/sync-tier"

// ─── Mock syncTier ──────────────────────────────────────
const mockSyncTier = vi.hoisted(() => vi.fn<() => Promise<SyncTierResult>>())

vi.mock("@/lib/operations/sync-tier", () => ({
  syncTier: mockSyncTier,
}))

// ─── Mock supabaseAdmin (only contact + account_contacts reads) ───

interface ContactRow {
  id: string
  email: string | null
  portal_tier: string | null
}

let contactFixture: ContactRow | null = null
let linkFixture: Array<{ account_id: string | null }> = []

vi.mock("@/lib/supabase-admin", () => {
  return {
    supabaseAdmin: {
      from: (table: string) => {
        if (table === "contacts") {
          const chain = {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
            single: vi.fn(() =>
              Promise.resolve({ data: contactFixture, error: contactFixture ? null : { message: "not found" } }),
            ),
          }
          return chain
        }
        if (table === "account_contacts") {
          const chain: Record<string, unknown> = {
            select: vi.fn().mockReturnThis(),
            eq: vi.fn().mockReturnThis(),
          }
          // thenable — resolves to link list
          chain.then = (resolve: (v: { data: Array<{ account_id: string | null }>; error: null }) => void) =>
            resolve({ data: linkFixture, error: null })
          return chain
        }
        return {
          select: vi.fn().mockReturnThis(),
          eq: vi.fn().mockReturnThis(),
          single: vi.fn(() => Promise.resolve({ data: null, error: null })),
        }
      },
    },
  }
})

// Mock the auto-create module (thin re-exports, not under test here)
vi.mock("@/lib/portal/auto-create", () => ({
  autoCreatePortalUser: vi.fn(),
  sendPortalWelcomeEmail: vi.fn(),
  upgradePortalTier: vi.fn(),
}))

import { reconcileTier } from "@/lib/operations/portal"

beforeEach(() => {
  contactFixture = null
  linkFixture = []
  mockSyncTier.mockReset()
  mockSyncTier.mockResolvedValue({
    success: true,
    previousTier: null,
    newTier: "active",
    contactsUpdated: [],
  })
})

// ─── reconcileTier ─────────────────────────────────────

describe("reconcileTier", () => {
  it("returns error when contact is not found", async () => {
    contactFixture = null
    const result = await reconcileTier({ contact_id: "missing" })
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/Contact not found/)
    expect(mockSyncTier).not.toHaveBeenCalled()
  })

  it("returns error when contact has no portal_tier and no target_tier provided", async () => {
    contactFixture = {
      id: "c1",
      email: "test@example.com",
      portal_tier: null,
    }
    const result = await reconcileTier({ contact_id: "c1" })
    expect(result.success).toBe(false)
    expect(result.error).toMatch(/No tier to reconcile/)
    expect(mockSyncTier).not.toHaveBeenCalled()
  })

  it("uses contacts.portal_tier as source of truth when target_tier omitted", async () => {
    contactFixture = {
      id: "c1",
      email: "test@example.com",
      portal_tier: "active",
    }
    linkFixture = [{ account_id: "acc-1" }]

    // syncTier: account was at onboarding, now set to active; contact DB tier already correct
    mockSyncTier.mockResolvedValueOnce({
      success: true,
      previousTier: "onboarding",
      newTier: "active",
      contactsUpdated: [], // contact DB tier was already 'active' — no DB change
    })

    const result = await reconcileTier({ contact_id: "c1" })

    expect(result.success).toBe(true)
    expect(result.resolved_tier).toBe("active")
    expect(mockSyncTier).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: "acc-1", newTier: "active" }),
    )
    // account tier changed (onboarding → active), contact DB tier unchanged
    expect(result.changed.accounts).toEqual(["acc-1"])
    expect(result.changed.contact).toBe(false)
  })

  it("overrides contacts.portal_tier when target_tier is provided", async () => {
    contactFixture = {
      id: "c1",
      email: "test@example.com",
      portal_tier: "active",
    }
    linkFixture = [{ account_id: "acc-1" }]

    // syncTier: account and contact both changed from active → lead
    mockSyncTier.mockResolvedValueOnce({
      success: true,
      previousTier: "active",
      newTier: "lead",
      contactsUpdated: [{ contactId: "c1", previousTier: "active", newTier: "lead" }],
    })

    const result = await reconcileTier({
      contact_id: "c1",
      target_tier: "lead",
    })

    expect(result.success).toBe(true)
    expect(result.resolved_tier).toBe("lead")
    expect(mockSyncTier).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: "acc-1", newTier: "lead" }),
    )
    expect(result.changed.accounts).toEqual(["acc-1"])
    expect(result.changed.contact).toBe(true)
    expect(result.changed.auth_user).toBe(true)
  })

  it("does not report changes when account and contact are already synced", async () => {
    contactFixture = {
      id: "c1",
      email: "test@example.com",
      portal_tier: "active",
    }
    linkFixture = [{ account_id: "acc-1" }]

    // syncTier: account was already at 'active', no contact change
    mockSyncTier.mockResolvedValueOnce({
      success: true,
      previousTier: "active",
      newTier: "active",
      contactsUpdated: [],
    })

    const result = await reconcileTier({ contact_id: "c1" })

    expect(result.success).toBe(true)
    // previousTier === newTier → account not counted as changed
    expect(result.changed.accounts).toEqual([])
    expect(result.changed.contact).toBe(false)
    expect(result.changed.auth_user).toBe(false)
  })

  it("handles contacts with no linked accounts gracefully", async () => {
    contactFixture = {
      id: "c1",
      email: null,
      portal_tier: "active",
    }
    linkFixture = []
    const result = await reconcileTier({ contact_id: "c1" })
    expect(result.success).toBe(true)
    expect(result.changed.accounts).toEqual([])
    expect(result.changed.auth_user).toBe(false)
    expect(mockSyncTier).not.toHaveBeenCalled()
  })
})
