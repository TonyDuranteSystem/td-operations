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
let itinSubmissionsFixture: WizardRow[] = []
let formationSubmissionsFixture: WizardRow[] = []
let onboardingSubmissionsFixture: WizardRow[] = []

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
          if (lastFromTable === "itin_submissions") {
            return Promise.resolve({ data: itinSubmissionsFixture, error: null })
          }
          if (lastFromTable === "formation_submissions") {
            return Promise.resolve({ data: formationSubmissionsFixture, error: null })
          }
          if (lastFromTable === "onboarding_submissions") {
            return Promise.resolve({ data: onboardingSubmissionsFixture, error: null })
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
  itinSubmissionsFixture = []
  formationSubmissionsFixture = []
  onboardingSubmissionsFixture = []
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

// ─── Contact-scoped fallback: person-owned ITIN alongside a company ───
// Pietro De Pellegrino (2026-07-21): bought an ITIN standalone while already
// owning a company. The ITIN service delivery is contact-scoped (createSD
// strips account_id), so the account branch above cannot see it and the
// contact branch never fires — he got no entrance to the questionnaire at all.

describe("computeHasWizardPending — person-owned ITIN with a company selected", () => {
  it("returns true for an account holder whose ITIN is contact-scoped and not yet submitted", async () => {
    sdAccountFixture = [] // nothing wizard-eligible on the company
    sdContactFixture = [{ service_type: "ITIN" }] // the personal ITIN
    wizardProgressFixture = [] // never filled it in
    const result = await computeHasWizardPending({
      contactId: "contact-1",
      selectedAccountId: "acc-1",
      portalTier: "active",
    })
    expect(result).toBe(true)
  })

  it("returns false once that ITIN questionnaire has been submitted", async () => {
    // The service delivery stays `active` for months while the IRS processes
    // it. Treating "active" as "still owes us the form" would nag the client
    // forever and let them re-open their own filed application.
    sdAccountFixture = []
    sdContactFixture = [{ service_type: "ITIN" }]
    wizardProgressFixture = [{ id: "wp-itin" }]
    const result = await computeHasWizardPending({
      contactId: "contact-1",
      selectedAccountId: "acc-1",
      portalTier: "active",
    })
    expect(result).toBe(false)
  })

  it("a submitted ITIN does NOT suppress a genuinely pending flexible wizard (closure)", async () => {
    sdAccountFixture = []
    sdContactFixture = [{ service_type: "ITIN" }, { service_type: "Company Closure" }]
    wizardProgressFixture = [{ id: "wp-itin" }]
    const result = await computeHasWizardPending({
      contactId: "contact-1",
      selectedAccountId: "acc-1",
      portalTier: "active",
    })
    expect(result).toBe(true)
  })
})

// ─── Fallback (dev job 9a9c5cf5): submission-table proof when
// wizard_progress silently failed to write ───

describe("computeHasWizardPending — submission-table fallback when wizard_progress is missing", () => {
  it("tier fallback: does NOT nag when wizard_progress is empty but formation_submissions shows completed", async () => {
    sdAccountFixture = []
    sdContactFixture = []
    wizardProgressFixture = []
    formationSubmissionsFixture = [{ id: "fs-1" }]
    const result = await computeHasWizardPending({
      contactId: "contact-1",
      selectedAccountId: "",
      portalTier: "formation",
    })
    expect(result).toBe(false)
  })

  it("tier fallback: does NOT nag when wizard_progress is empty but onboarding_submissions shows reviewed", async () => {
    sdAccountFixture = []
    sdContactFixture = []
    wizardProgressFixture = []
    onboardingSubmissionsFixture = [{ id: "os-1" }]
    const result = await computeHasWizardPending({
      contactId: "contact-1",
      selectedAccountId: "",
      portalTier: "onboarding",
    })
    expect(result).toBe(false)
  })

  it("tier fallback: still nags when NEITHER wizard_progress NOR the submission table shows a completion", async () => {
    sdAccountFixture = []
    sdContactFixture = []
    wizardProgressFixture = []
    formationSubmissionsFixture = []
    const result = await computeHasWizardPending({
      contactId: "contact-1",
      selectedAccountId: "",
      portalTier: "formation",
    })
    expect(result).toBe(true)
  })

  it("ITIN fallback: does NOT nag when wizard_progress is empty but itin_submissions shows completed", async () => {
    sdAccountFixture = []
    sdContactFixture = [{ service_type: "ITIN" }]
    wizardProgressFixture = []
    itinSubmissionsFixture = [{ id: "itin-1" }]
    const result = await computeHasWizardPending({
      contactId: "contact-1",
      selectedAccountId: "acc-1",
      portalTier: "active",
    })
    expect(result).toBe(false)
  })

  it("ITIN fallback: still nags when neither wizard_progress nor itin_submissions shows a completion", async () => {
    sdAccountFixture = []
    sdContactFixture = [{ service_type: "ITIN" }]
    wizardProgressFixture = []
    itinSubmissionsFixture = []
    const result = await computeHasWizardPending({
      contactId: "contact-1",
      selectedAccountId: "acc-1",
      portalTier: "active",
    })
    expect(result).toBe(true)
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
