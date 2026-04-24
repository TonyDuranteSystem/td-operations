/**
 * P3.4 #1 Commit C — lib/portal/wizard-visibility.ts unit tests.
 *
 * Three branches in priority order (see file header for SOP context):
 *   1. SD-by-account: selectedAccountId set + active wizard-eligible SD.
 *   2. SD-by-contact: no account, contact_id + active wizard-eligible SD
 *      with account_id IS NULL.
 *   3. Tier-based onboarding fallback (NEW in Commit C): portal_tier=
 *      'onboarding' AND no wizard_progress row with status='submitted'
 *      for this contact_id.
 *
 * Mocking strategy:
 *   - supabaseAdmin.from(table) returns a chainable stub that resolves
 *     to the fixture for the table being queried. Each test sets the
 *     fixture before calling computeHasWizardPending.
 */

import { describe, it, expect, vi, beforeEach } from "vitest"

// ─── Fixture state ─────────────────────────────────────

interface SDRow { service_type: string }
interface WizardRow { id: string }

let sdAccountFixture: SDRow[] = []
let sdContactFixture: SDRow[] = []
let wizardProgressFixture: WizardRow[] = []

// Track query shape so we can route the fixture per branch.
let lastFromTable = ""
let chainState: { isAccountQuery: boolean; isContactQuery: boolean } = {
  isAccountQuery: false,
  isContactQuery: false,
}

vi.mock("@/lib/supabase-admin", () => ({
  supabaseAdmin: {
    from: (table: string) => {
      lastFromTable = table
      chainState = { isAccountQuery: false, isContactQuery: false }
      const chain = {
        select: vi.fn().mockReturnThis(),
        eq: vi.fn((col: string, _val: unknown) => {
          if (col === "account_id") chainState.isAccountQuery = true
          if (col === "contact_id") chainState.isContactQuery = true
          return chain
        }),
        in: vi.fn().mockReturnThis(),
        is: vi.fn().mockReturnThis(),
        limit: vi.fn(() => {
          if (lastFromTable === "service_deliveries") {
            const data = chainState.isAccountQuery
              ? sdAccountFixture
              : sdContactFixture
            return Promise.resolve({ data, error: null })
          }
          if (lastFromTable === "wizard_progress") {
            return Promise.resolve({ data: wizardProgressFixture, error: null })
          }
          return Promise.resolve({ data: [], error: null })
        }),
      }
      return chain
    },
  },
}))

import { computeHasWizardPending } from "@/lib/portal/wizard-visibility"

beforeEach(() => {
  sdAccountFixture = []
  sdContactFixture = []
  wizardProgressFixture = []
  lastFromTable = ""
  chainState = { isAccountQuery: false, isContactQuery: false }
})

// ─── Branch 1: SD-by-account ───────────────────────────

describe("computeHasWizardPending — SD-by-account branch", () => {
  it("returns true when selectedAccountId has at least one wizard-eligible active SD", async () => {
    sdAccountFixture = [{ service_type: "Banking Fintech" }]
    const result = await computeHasWizardPending({
      contactId: "contact-1",
      selectedAccountId: "acc-1",
      portalTier: "active",
    })
    expect(result).toBe(true)
  })

  it("returns false when selectedAccountId has no wizard-eligible SDs and tier is not onboarding", async () => {
    sdAccountFixture = []
    const result = await computeHasWizardPending({
      contactId: "contact-1",
      selectedAccountId: "acc-1",
      portalTier: "active",
    })
    expect(result).toBe(false)
  })
})

// ─── Branch 2: SD-by-contact (no selected account) ─────

describe("computeHasWizardPending — SD-by-contact branch", () => {
  it("returns true when no account selected but contact has individual-context wizard SD", async () => {
    sdContactFixture = [{ service_type: "ITIN" }]
    const result = await computeHasWizardPending({
      contactId: "contact-1",
      selectedAccountId: "",
      portalTier: "active",
    })
    expect(result).toBe(true)
  })

  it("returns false when no account selected and contact has no individual-context wizard SDs (tier active)", async () => {
    sdContactFixture = []
    const result = await computeHasWizardPending({
      contactId: "contact-1",
      selectedAccountId: "",
      portalTier: "active",
    })
    expect(result).toBe(false)
  })
})

// ─── Branch 3 (Commit C): tier-based onboarding/formation fallback ───

describe("computeHasWizardPending — tier-based onboarding fallback (Commit C)", () => {
  it("returns true when tier='onboarding', no SDs, no submitted wizard_progress", async () => {
    sdAccountFixture = []
    sdContactFixture = []
    wizardProgressFixture = []
    const result = await computeHasWizardPending({
      contactId: "contact-1",
      selectedAccountId: "",
      portalTier: "onboarding",
    })
    expect(result).toBe(true)
  })

  it("returns false when tier='onboarding' but contact has already submitted a wizard", async () => {
    sdAccountFixture = []
    sdContactFixture = []
    wizardProgressFixture = [{ id: "wp-1" }]
    const result = await computeHasWizardPending({
      contactId: "contact-1",
      selectedAccountId: "",
      portalTier: "onboarding",
    })
    expect(result).toBe(false)
  })

  it("returns true when tier='formation', no SDs, no submitted wizard_progress", async () => {
    sdAccountFixture = []
    sdContactFixture = []
    wizardProgressFixture = []
    const result = await computeHasWizardPending({
      contactId: "contact-1",
      selectedAccountId: "",
      portalTier: "formation",
    })
    expect(result).toBe(true)
  })

  it("returns false when tier='formation' but contact has already submitted a wizard", async () => {
    sdAccountFixture = []
    sdContactFixture = []
    wizardProgressFixture = [{ id: "wp-1" }]
    const result = await computeHasWizardPending({
      contactId: "contact-1",
      selectedAccountId: "",
      portalTier: "formation",
    })
    expect(result).toBe(false)
  })

  it("does NOT trigger tier fallback when tier is 'active'", async () => {
    sdAccountFixture = []
    sdContactFixture = []
    wizardProgressFixture = []
    const result = await computeHasWizardPending({
      contactId: "contact-1",
      selectedAccountId: "",
      portalTier: "active",
    })
    expect(result).toBe(false)
  })

  it("returns false when contactId is null even if tier='onboarding'", async () => {
    wizardProgressFixture = []
    const result = await computeHasWizardPending({
      contactId: null,
      selectedAccountId: "",
      portalTier: "onboarding",
    })
    expect(result).toBe(false)
  })

  it("returns false when contactId is null even if tier='formation'", async () => {
    wizardProgressFixture = []
    const result = await computeHasWizardPending({
      contactId: null,
      selectedAccountId: "",
      portalTier: "formation",
    })
    expect(result).toBe(false)
  })
})

// ─── Branch precedence (SD branch wins before tier fallback) ───

describe("computeHasWizardPending — branch precedence", () => {
  it("returns true via SD branch even when tier='onboarding' (SD wins, tier query not needed)", async () => {
    sdAccountFixture = [{ service_type: "Banking Fintech" }]
    wizardProgressFixture = [{ id: "wp-1" }] // would block tier branch, but SD branch fires first
    const result = await computeHasWizardPending({
      contactId: "contact-1",
      selectedAccountId: "acc-1",
      portalTier: "onboarding",
    })
    expect(result).toBe(true)
  })
})

// ─── Tax Return wizard gate (requires active tier + EIN) ───

describe("computeHasWizardPending — Tax Return gate", () => {
  it("returns true when only Tax Return SD exists but tier is formation (tier fallback fires)", async () => {
    // Tax Return SD is filtered out (formation phase, no EIN), but the tier-based
    // fallback still returns true so formation clients see the "Complete Setup" button
    // for their formation wizard. The wizard PAGE (not this function) prevents routing
    // to the tax wizard — it checks portal_tier=active && ein_number before pushing.
    sdAccountFixture = [{ service_type: "Tax Return" }]
    wizardProgressFixture = []
    const result = await computeHasWizardPending({
      contactId: "contact-1",
      selectedAccountId: "acc-1",
      portalTier: "formation",
      einNumber: null,
    })
    expect(result).toBe(true)
  })

  it("returns false when only Tax Return SD exists, tier is active but EIN missing", async () => {
    sdAccountFixture = [{ service_type: "Tax Return" }]
    const result = await computeHasWizardPending({
      contactId: "contact-1",
      selectedAccountId: "acc-1",
      portalTier: "active",
      einNumber: null,
    })
    expect(result).toBe(false)
  })

  it("returns true when Tax Return SD exists and tier is active with EIN", async () => {
    sdAccountFixture = [{ service_type: "Tax Return" }]
    const result = await computeHasWizardPending({
      contactId: "contact-1",
      selectedAccountId: "acc-1",
      portalTier: "active",
      einNumber: "12-3456789",
    })
    expect(result).toBe(true)
  })

  it("returns true when account has both Tax Return and Banking Fintech SDs even if tier is formation", async () => {
    sdAccountFixture = [{ service_type: "Tax Return" }, { service_type: "Banking Fintech" }]
    const result = await computeHasWizardPending({
      contactId: "contact-1",
      selectedAccountId: "acc-1",
      portalTier: "formation",
      einNumber: null,
    })
    expect(result).toBe(true)
  })
})
