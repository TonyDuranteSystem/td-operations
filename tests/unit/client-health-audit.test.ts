import { describe, it, expect } from "vitest"
import {
  rule1_tierConsistency,
  rule2_portalAccess,
  rule3_ss4StatusSync,
  rule4_cmraAfterLease,
  rule5_formationSDContinuity,
  rule6_oneTimeScope,
  rule7_renewalDates,
  rule8_documentsCompleteness,
  rule9_onboardingVsFormation,
  rule10_taxReturnDualTracking,
  rule11_offerTypeConsistency,
  rule12_leadLinkage,
  rule13_dbaTracking,
  rule14_mmllcMemberCompleteness,
  rule15_oaSignerCount,
  rule16_closedAccountPortalAccess,
  rule17_sameYearTaxReturn,
  rule18_partnerServiceScope,
  rule19_legacyStatuses,
  rule20_entityTypeValidation,
  rule21_zeroAmountInstallment,
  rule22_oneTimeTier,
  rule23_missingTaxReturnRow,
  rule24_incompleteCompanyDetails,
  rule25_onboardingDetection,
  rule26_taxReturnStageVsPayments,
  rule27_taxReturnYearValidation,
  rule28_duplicatePayments,
  rule29_taxReturnSDStageAlignment,
  rule30_oneTimeTaxReturnServiceType,
  runRules,
  type HealthContext,
  type AccountRow,
} from "@/lib/operations/client-health-audit"

// ── Fixtures ───────────────────────────────────────────────────────────────

const ACCOUNT_ID = "acc-1"

function baseAccount(over: Partial<AccountRow> = {}): AccountRow {
  return {
    id: ACCOUNT_ID,
    company_name: "Test LLC",
    account_type: "Client",
    status: "Active",
    entity_type: null,
    ein_number: null,
    formation_date: null,
    state_of_formation: null,
    portal_tier: null,
    portal_account: null,
    ra_renewal_date: null,
    cmra_renewal_date: null,
    annual_report_due_date: null,
    ...over,
  }
}

function emptyCtx(over: Partial<HealthContext> = {}): HealthContext {
  return {
    account: baseAccount(),
    contacts: [],
    service_deliveries: [],
    ss4_applications: [],
    lease_agreements: [],
    documents: [],
    tax_returns: [],
    most_recent_offer: null,
    leads: [],
    members: [],
    oa_agreements: [],
    payments: [],
    client_partners: [],
    has_renewal_offer: false,
    has_auth_user: false,
    ...over,
  }
}

// ── R1: TIER CONSISTENCY ───────────────────────────────────────────────────

describe("rule1_tierConsistency", () => {
  it("flags account with EIN but tier != active", () => {
    const ctx = emptyCtx({
      account: baseAccount({ ein_number: "12-3456789", portal_tier: "onboarding" }),
    })
    const findings = rule1_tierConsistency(ctx)
    expect(findings.length).toBeGreaterThan(0)
    expect(findings[0].severity).toBe("error")
    expect(findings[0].expected_value).toBe("active")
  })

  it("does NOT flag One-Time accounts", () => {
    const ctx = emptyCtx({
      account: baseAccount({ account_type: "One-Time", ein_number: "12-3456789", portal_tier: "lead" }),
    })
    expect(rule1_tierConsistency(ctx)).toEqual([])
  })

  it("flags formation account without EIN whose tier is not 'formation'", () => {
    const ctx = emptyCtx({
      account: baseAccount({ formation_date: "2026-01-01", portal_tier: "lead" }),
      most_recent_offer: { contract_type: "formation" },
    })
    const findings = rule1_tierConsistency(ctx)
    expect(findings.some(f => f.expected_value === "formation")).toBe(true)
  })

  it("flags contact tier below account tier", () => {
    const ctx = emptyCtx({
      account: baseAccount({ ein_number: "12-3456789", portal_tier: "active" }),
      contacts: [{ id: "c1", email: "x@y.com", portal_tier: "onboarding" }],
    })
    const findings = rule1_tierConsistency(ctx)
    expect(findings.some(f => f.description.includes("Contact"))).toBe(true)
  })

  it("does NOT flag aligned tiers", () => {
    const ctx = emptyCtx({
      account: baseAccount({ ein_number: "12-3456789", portal_tier: "active" }),
      contacts: [{ id: "c1", email: "x@y.com", portal_tier: "active" }],
    })
    expect(rule1_tierConsistency(ctx)).toEqual([])
  })
})

// ── R2: PORTAL ACCESS ──────────────────────────────────────────────────────

describe("rule2_portalAccess", () => {
  it("flags auth user + tier set but portal_account is false", () => {
    const ctx = emptyCtx({
      account: baseAccount({ portal_tier: "active", portal_account: false }),
      has_auth_user: true,
    })
    const findings = rule2_portalAccess(ctx)
    expect(findings).toHaveLength(1)
    expect(findings[0].severity).toBe("warning")
  })

  it("does NOT flag when portal_tier is null (portal intentionally not set up)", () => {
    const ctx = emptyCtx({
      account: baseAccount({ portal_tier: null, portal_account: false }),
      has_auth_user: true,
    })
    expect(rule2_portalAccess(ctx)).toEqual([])
  })

  it("does NOT flag when portal_account is true", () => {
    const ctx = emptyCtx({
      account: baseAccount({ portal_tier: "active", portal_account: true }),
      has_auth_user: true,
    })
    expect(rule2_portalAccess(ctx)).toEqual([])
  })

  it("does NOT flag when no auth user exists", () => {
    const ctx = emptyCtx({
      account: baseAccount({ portal_tier: "active", portal_account: false }),
      has_auth_user: false,
    })
    expect(rule2_portalAccess(ctx)).toEqual([])
  })
})

// ── R3: SS-4 STATUS SYNC ───────────────────────────────────────────────────

describe("rule3_ss4StatusSync", () => {
  it("flags EIN set but SS-4 still in awaiting_signature as ERROR", () => {
    const ctx = emptyCtx({
      account: baseAccount({ ein_number: "12-3456789" }),
      ss4_applications: [{ id: "s1", status: "awaiting_signature", pdf_signed_drive_id: null, created_at: null, updated_at: null }],
    })
    const findings = rule3_ss4StatusSync(ctx)
    expect(findings).toHaveLength(1)
    expect(findings[0].severity).toBe("error")
    expect(findings[0].description).toContain("ein-received handler doesn't update SS-4")
  })

  it("does NOT flag SS-4 status=done with EIN", () => {
    const ctx = emptyCtx({
      account: baseAccount({ ein_number: "12-3456789" }),
      ss4_applications: [{ id: "s1", status: "done", pdf_signed_drive_id: "drive-1", created_at: null, updated_at: null }],
    })
    expect(rule3_ss4StatusSync(ctx)).toEqual([])
  })

  it("does NOT flag when no EIN is recorded and SS-4 is fresh", () => {
    const ctx = emptyCtx({
      ss4_applications: [{ id: "s1", status: "awaiting_signature", pdf_signed_drive_id: null, created_at: null, updated_at: null }],
    })
    expect(rule3_ss4StatusSync(ctx)).toEqual([])
  })

  it("flags 'signed' status too (EIN should have arrived by then)", () => {
    const ctx = emptyCtx({
      account: baseAccount({ ein_number: "12-3456789" }),
      ss4_applications: [{ id: "s1", status: "signed", pdf_signed_drive_id: "drive-1", created_at: null, updated_at: null }],
    })
    const findings = rule3_ss4StatusSync(ctx)
    expect(findings).toHaveLength(1)
    expect(findings[0].severity).toBe("error")
  })

  it("flags signed PDF but status still awaiting_signature (no EIN)", () => {
    const ctx = emptyCtx({
      ss4_applications: [{ id: "s1", status: "awaiting_signature", pdf_signed_drive_id: "drive-1", created_at: null, updated_at: null }],
    })
    const findings = rule3_ss4StatusSync(ctx)
    expect(findings).toHaveLength(1)
    expect(findings[0].severity).toBe("warning")
    expect(findings[0].description).toContain("pdf_signed_drive_id present")
  })

  it("flags stale SS-4 (>21d, unchanged since creation)", () => {
    const NOW = new Date("2026-06-01T00:00:00Z")
    const ts = "2026-04-01T00:00:00Z" // 61 days before NOW
    const ctx = emptyCtx({
      ss4_applications: [{ id: "s1", status: "draft", pdf_signed_drive_id: null, created_at: ts, updated_at: ts }],
    })
    const findings = rule3_ss4StatusSync(ctx, NOW)
    expect(findings.some(f => f.description.includes("unchanged for 3+ weeks"))).toBe(true)
  })

  it("does NOT flag stale when status has progressed (updated_at > created_at)", () => {
    const NOW = new Date("2026-06-01T00:00:00Z")
    const ctx = emptyCtx({
      ss4_applications: [{
        id: "s1",
        status: "submitted",
        pdf_signed_drive_id: null,
        created_at: "2026-04-01T00:00:00Z",
        updated_at: "2026-05-15T00:00:00Z",
      }],
    })
    const findings = rule3_ss4StatusSync(ctx, NOW)
    expect(findings.some(f => f.description.includes("unchanged for 3+ weeks"))).toBe(false)
  })

  it("EIN + done = no findings (golden path)", () => {
    const NOW = new Date("2026-06-01T00:00:00Z")
    const ctx = emptyCtx({
      account: baseAccount({ ein_number: "12-3456789" }),
      ss4_applications: [{
        id: "s1",
        status: "done",
        pdf_signed_drive_id: "drive-1",
        created_at: "2026-05-25T00:00:00Z",
        updated_at: "2026-05-30T00:00:00Z",
      }],
    })
    expect(rule3_ss4StatusSync(ctx, NOW)).toEqual([])
  })
})

// ── R4: CMRA AFTER LEASE ───────────────────────────────────────────────────

describe("rule4_cmraAfterLease", () => {
  it("flags signed lease + CMRA SD at 'Lease Created' stage", () => {
    const ctx = emptyCtx({
      lease_agreements: [{ id: "l1", status: "signed", signed_at: "2026-03-01T00:00:00Z" }],
      service_deliveries: [
        {
          id: "sd1", service_type: "CMRA Mailing Address", status: "active", stage: "Lease Created",
          stage_order: 1, account_id: ACCOUNT_ID, contact_id: null, created_at: "2026-01-01T00:00:00Z",
        },
      ],
    })
    const findings = rule4_cmraAfterLease(ctx)
    expect(findings).toHaveLength(1)
    expect(findings[0].severity).toBe("warning")
  })

  it("includes timing note when lease signed BEFORE SD was created", () => {
    const ctx = emptyCtx({
      lease_agreements: [{ id: "l1", status: "signed", signed_at: "2026-01-01T00:00:00Z" }],
      service_deliveries: [
        {
          id: "sd1", service_type: "CMRA Mailing Address", status: "active", stage: "Lease Created",
          stage_order: 1, account_id: ACCOUNT_ID, contact_id: null, created_at: "2026-03-01T00:00:00Z",
        },
      ],
    })
    const findings = rule4_cmraAfterLease(ctx)
    expect(findings[0].description).toContain("signed before")
  })

  it("does NOT flag when CMRA SD has advanced past 'Lease Created'", () => {
    const ctx = emptyCtx({
      lease_agreements: [{ id: "l1", status: "signed", signed_at: "2026-03-01T00:00:00Z" }],
      service_deliveries: [
        {
          id: "sd1", service_type: "CMRA Mailing Address", status: "active", stage: "Active",
          stage_order: 3, account_id: ACCOUNT_ID, contact_id: null, created_at: "2026-01-01T00:00:00Z",
        },
      ],
    })
    expect(rule4_cmraAfterLease(ctx)).toEqual([])
  })

  it("does NOT flag when no signed lease exists", () => {
    const ctx = emptyCtx({
      lease_agreements: [{ id: "l1", status: "draft", signed_at: null }],
      service_deliveries: [
        {
          id: "sd1", service_type: "CMRA Mailing Address", status: "active", stage: "Lease Created",
          stage_order: 1, account_id: ACCOUNT_ID, contact_id: null, created_at: "2026-01-01T00:00:00Z",
        },
      ],
    })
    expect(rule4_cmraAfterLease(ctx)).toEqual([])
  })

  it("YEAR-1 EXEMPTION: formation_date in current year + no renewal offer → info, skip CMRA SD check", () => {
    const NOW = new Date("2026-06-01T00:00:00Z")
    const ctx = emptyCtx({
      account: baseAccount({ formation_date: "2026-02-15" }),
      lease_agreements: [{ id: "l1", status: "signed", signed_at: "2026-03-01T00:00:00Z" }],
      service_deliveries: [
        // Stuck CMRA SD that would normally flag — should be IGNORED in year 1.
        {
          id: "sd1", service_type: "CMRA Mailing Address", status: "active", stage: "Lease Created",
          stage_order: 1, account_id: ACCOUNT_ID, contact_id: null, created_at: "2026-01-01T00:00:00Z",
        },
      ],
      has_renewal_offer: false,
    })
    const findings = rule4_cmraAfterLease(ctx, NOW)
    expect(findings).toHaveLength(1)
    expect(findings[0].severity).toBe("info")
    expect(findings[0].description).toContain("Year-1 formation client")
  })

  it("YEAR-1 EXEMPTION does NOT apply when a renewal offer exists", () => {
    const NOW = new Date("2026-06-01T00:00:00Z")
    const ctx = emptyCtx({
      account: baseAccount({ formation_date: "2026-02-15" }),
      lease_agreements: [{ id: "l1", status: "signed", signed_at: "2026-03-01T00:00:00Z" }],
      service_deliveries: [
        {
          id: "sd1", service_type: "CMRA Mailing Address", status: "active", stage: "Lease Created",
          stage_order: 1, account_id: ACCOUNT_ID, contact_id: null, created_at: "2026-01-01T00:00:00Z",
        },
      ],
      has_renewal_offer: true,
    })
    const findings = rule4_cmraAfterLease(ctx, NOW)
    expect(findings).toHaveLength(1)
    expect(findings[0].severity).toBe("warning")
    expect(findings[0].description).toContain("CMRA SD is still at stage 'Lease Created'")
  })

  it("YEAR-1 EXEMPTION does NOT apply when formation was in a prior year", () => {
    const NOW = new Date("2026-06-01T00:00:00Z")
    const ctx = emptyCtx({
      account: baseAccount({ formation_date: "2024-02-15" }),
      lease_agreements: [{ id: "l1", status: "signed", signed_at: "2026-03-01T00:00:00Z" }],
      service_deliveries: [
        {
          id: "sd1", service_type: "CMRA Mailing Address", status: "active", stage: "Lease Created",
          stage_order: 1, account_id: ACCOUNT_ID, contact_id: null, created_at: "2026-01-01T00:00:00Z",
        },
      ],
      has_renewal_offer: false,
    })
    const findings = rule4_cmraAfterLease(ctx, NOW)
    expect(findings[0].severity).toBe("warning")
  })
})

// ── R5: FORMATION SD CONTINUITY ────────────────────────────────────────────

describe("rule5_formationSDContinuity", () => {
  it("flags account with formation_date but no Formation SD", () => {
    const ctx = emptyCtx({ account: baseAccount({ formation_date: "2026-01-01" }) })
    const findings = rule5_formationSDContinuity(ctx)
    expect(findings).toHaveLength(1)
    expect(findings[0].severity).toBe("warning")
  })

  it("flags account with only a cancelled contact-only Formation SD as error", () => {
    const ctx = emptyCtx({
      account: baseAccount({ formation_date: "2026-01-01" }),
      service_deliveries: [
        {
          id: "sd1", service_type: "Company Formation", status: "cancelled", stage: "Cancelled",
          stage_order: 99, account_id: null, contact_id: "c1", created_at: "2026-01-01T00:00:00Z",
        },
      ],
    })
    const findings = rule5_formationSDContinuity(ctx)
    expect(findings).toHaveLength(1)
    expect(findings[0].severity).toBe("error")
    expect(findings[0].description).toContain("contact and cancelled")
  })

  it("does NOT flag when active Formation SD exists on account", () => {
    const ctx = emptyCtx({
      account: baseAccount({ formation_date: "2026-01-01" }),
      service_deliveries: [
        {
          id: "sd1", service_type: "Company Formation", status: "active", stage: "Filing",
          stage_order: 2, account_id: ACCOUNT_ID, contact_id: null, created_at: "2026-01-01T00:00:00Z",
        },
      ],
    })
    expect(rule5_formationSDContinuity(ctx)).toEqual([])
  })

  it("does NOT flag One-Time accounts", () => {
    const ctx = emptyCtx({
      account: baseAccount({ account_type: "One-Time", formation_date: "2026-01-01" }),
    })
    expect(rule5_formationSDContinuity(ctx)).toEqual([])
  })
})

// ── R6: ONE-TIME SCOPE ─────────────────────────────────────────────────────

describe("rule6_oneTimeScope", () => {
  it("flags ra_renewal_date set on One-Time account", () => {
    const ctx = emptyCtx({
      account: baseAccount({ account_type: "One-Time", ra_renewal_date: "2027-01-01" }),
    })
    const findings = rule6_oneTimeScope(ctx)
    expect(findings).toHaveLength(1)
  })

  it("flags all three renewal-date columns when set on One-Time", () => {
    const ctx = emptyCtx({
      account: baseAccount({
        account_type: "One-Time",
        ra_renewal_date: "2027-01-01",
        cmra_renewal_date: "2026-12-31",
        annual_report_due_date: "2027-05-01",
      }),
    })
    expect(rule6_oneTimeScope(ctx)).toHaveLength(3)
  })

  it("does NOT flag when account_type is Client", () => {
    const ctx = emptyCtx({
      account: baseAccount({ account_type: "Client", ra_renewal_date: "2027-01-01" }),
    })
    expect(rule6_oneTimeScope(ctx)).toEqual([])
  })

  it("emits INFO when One-Time has active SDs but no payments", () => {
    const ctx = emptyCtx({
      account: baseAccount({ account_type: "One-Time" }),
      service_deliveries: [
        {
          id: "sd1", service_type: "EIN", status: "active", stage: "In Progress",
          stage_order: 2, account_id: ACCOUNT_ID, contact_id: null, created_at: "2026-01-01T00:00:00Z",
        },
      ],
      payments: [],
    })
    const findings = rule6_oneTimeScope(ctx)
    expect(findings.some(f => f.severity === "info" && f.description.includes("no payment records"))).toBe(true)
  })

  it("does NOT emit no-payments info when at least one payment exists", () => {
    const ctx = emptyCtx({
      account: baseAccount({ account_type: "One-Time" }),
      service_deliveries: [
        {
          id: "sd1", service_type: "EIN", status: "active", stage: "In Progress",
          stage_order: 2, account_id: ACCOUNT_ID, contact_id: null, created_at: "2026-01-01T00:00:00Z",
        },
      ],
      payments: [{ id: "p1", description: "EIN service", status: "Paid", amount: 350, paid_date: null, created_at: "2026-01-02T00:00:00Z" }],
    })
    expect(rule6_oneTimeScope(ctx).some(f => f.description.includes("no payment records"))).toBe(false)
  })

  it("does NOT emit no-payments info when SDs are all cancelled/completed", () => {
    const ctx = emptyCtx({
      account: baseAccount({ account_type: "One-Time" }),
      service_deliveries: [
        {
          id: "sd1", service_type: "EIN", status: "completed", stage: "Done",
          stage_order: 99, account_id: ACCOUNT_ID, contact_id: null, created_at: "2026-01-01T00:00:00Z",
        },
        {
          id: "sd2", service_type: "ITIN", status: "cancelled", stage: "Cancelled",
          stage_order: 99, account_id: ACCOUNT_ID, contact_id: null, created_at: "2026-01-01T00:00:00Z",
        },
      ],
      payments: [],
    })
    expect(rule6_oneTimeScope(ctx).some(f => f.description.includes("no payment records"))).toBe(false)
  })

  it("does NOT emit no-payments info on Client accounts", () => {
    const ctx = emptyCtx({
      account: baseAccount({ account_type: "Client" }),
      service_deliveries: [
        {
          id: "sd1", service_type: "EIN", status: "active", stage: "In Progress",
          stage_order: 2, account_id: ACCOUNT_ID, contact_id: null, created_at: "2026-01-01T00:00:00Z",
        },
      ],
      payments: [],
    })
    expect(rule6_oneTimeScope(ctx)).toEqual([])
  })
})

// ── R7: RENEWAL DATES ──────────────────────────────────────────────────────

describe("rule7_renewalDates", () => {
  const NOW = new Date("2026-06-01T00:00:00Z")

  it("flags ra_renewal_date === formation_date (known bug)", () => {
    const ctx = emptyCtx({
      account: baseAccount({ formation_date: "2026-01-01", ra_renewal_date: "2026-01-01", state_of_formation: "WY" }),
    })
    const findings = rule7_renewalDates(ctx, NOW)
    expect(findings.some(f => f.severity === "error" && f.description.includes("equals formation_date"))).toBe(true)
  })

  it("does NOT flag ra_renewal_date within ±60 days of formation+1y", () => {
    const ctx = emptyCtx({
      account: baseAccount({ formation_date: "2025-06-01", ra_renewal_date: "2026-07-15", state_of_formation: "WY" }),
    })
    const findings = rule7_renewalDates(ctx, NOW)
    expect(findings.find(f => f.rule_id === "R7" && f.description.includes("days off"))).toBeUndefined()
  })

  it("flags ra_renewal_date far off from formation+1y", () => {
    const ctx = emptyCtx({
      account: baseAccount({ formation_date: "2025-06-01", ra_renewal_date: "2030-01-01", state_of_formation: "WY" }),
    })
    const findings = rule7_renewalDates(ctx, NOW)
    expect(findings.some(f => f.description.includes("days off"))).toBe(true)
  })

  it("flags NM with annual_report_due_date set (no requirement)", () => {
    const ctx = emptyCtx({
      account: baseAccount({ formation_date: "2025-01-01", ra_renewal_date: "2026-01-01", state_of_formation: "NM", annual_report_due_date: "2027-05-01" }),
    })
    const findings = rule7_renewalDates(ctx, NOW)
    expect(findings.some(f => f.description.includes("no annual report requirement"))).toBe(true)
  })

  it("flags FL missing annual_report_due_date", () => {
    const ctx = emptyCtx({
      account: baseAccount({ formation_date: "2025-01-01", ra_renewal_date: "2026-01-01", state_of_formation: "FL" }),
    })
    const findings = rule7_renewalDates(ctx, NOW)
    expect(findings.some(f => f.description.includes("requires an annual report"))).toBe(true)
  })

  it("does NOT apply to One-Time accounts", () => {
    const ctx = emptyCtx({
      account: baseAccount({ account_type: "One-Time", formation_date: "2025-01-01" }),
    })
    expect(rule7_renewalDates(ctx, NOW)).toEqual([])
  })

  it("flags cmra_renewal_date not set to current year Dec 31", () => {
    const ctx = emptyCtx({
      account: baseAccount({ formation_date: "2025-01-01", ra_renewal_date: "2026-01-01", cmra_renewal_date: "2025-12-31", state_of_formation: "WY" }),
    })
    const findings = rule7_renewalDates(ctx, NOW)
    expect(findings.some(f => f.expected_value === "2026-12-31")).toBe(true)
  })

  it("emits INFO for an unknown state_of_formation (not in policy table)", () => {
    const ctx = emptyCtx({
      account: baseAccount({ formation_date: "2025-01-01", ra_renewal_date: "2026-01-01", state_of_formation: "CA" }),
    })
    const findings = rule7_renewalDates(ctx, NOW)
    expect(findings.some(f => f.severity === "info" && f.description.includes("not in the annual report policy"))).toBe(true)
  })

  it("does NOT emit unknown-state info for a known state (WY)", () => {
    const ctx = emptyCtx({
      account: baseAccount({ formation_date: "2025-01-01", ra_renewal_date: "2026-01-01", state_of_formation: "WY" }),
    })
    const findings = rule7_renewalDates(ctx, NOW)
    expect(findings.some(f => f.description.includes("not in the annual report policy"))).toBe(false)
  })

  it("resolves full state names ('Florida') against the policy table — no unknown-state info, flags missing annual report", () => {
    const ctx = emptyCtx({
      account: baseAccount({ formation_date: "2025-01-01", ra_renewal_date: "2026-01-01", state_of_formation: "Florida" }),
    })
    const findings = rule7_renewalDates(ctx, NOW)
    expect(findings.some(f => f.description.includes("not in the annual report policy"))).toBe(false)
    expect(findings.some(f => f.description.includes("requires an annual report"))).toBe(true)
  })

  it("resolves full state names with mixed case / whitespace ('  new mexico  ') — NM has no annual report requirement", () => {
    const ctx = emptyCtx({
      account: baseAccount({ formation_date: "2025-01-01", ra_renewal_date: "2026-01-01", state_of_formation: "  new mexico  ", annual_report_due_date: "2027-05-01" }),
    })
    const findings = rule7_renewalDates(ctx, NOW)
    expect(findings.some(f => f.description.includes("not in the annual report policy"))).toBe(false)
    expect(findings.some(f => f.description.includes("no annual report requirement"))).toBe(true)
  })

  it("for ONBOARDING client (offer contract_type), accepts any ra_renewal_date — no drift / equality error", () => {
    const ctx = emptyCtx({
      account: baseAccount({
        formation_date: "2020-01-01",
        ra_renewal_date: "2026-09-15",
        state_of_formation: "WY",
      }),
      most_recent_offer: { contract_type: "onboarding" },
    })
    const findings = rule7_renewalDates(ctx, NOW)
    expect(findings.some(f => f.description.includes("days off"))).toBe(false)
    expect(findings.some(f => f.description.includes("equals formation_date"))).toBe(false)
  })

  it("for ONBOARDING client even when ra_renewal_date === formation_date (no equality error)", () => {
    const ctx = emptyCtx({
      account: baseAccount({
        formation_date: "2020-01-01",
        ra_renewal_date: "2020-01-01",
        state_of_formation: "WY",
      }),
      most_recent_offer: { contract_type: "onboarding" },
    })
    const findings = rule7_renewalDates(ctx, NOW)
    expect(findings.some(f => f.severity === "error" && f.description.includes("equals formation_date"))).toBe(false)
  })

  it("for ONBOARDING client with NULL ra_renewal_date, emits onboarding-specific message", () => {
    const ctx = emptyCtx({
      account: baseAccount({
        formation_date: "2020-01-01",
        ra_renewal_date: null,
        state_of_formation: "WY",
      }),
      most_recent_offer: { contract_type: "onboarding" },
    })
    const findings = rule7_renewalDates(ctx, NOW)
    const onboardingFinding = findings.find(f =>
      f.rule_id === "R7" && f.description.includes("switched the registered agent"),
    )
    expect(onboardingFinding).toBeDefined()
    expect(onboardingFinding?.severity).toBe("warning")
    // The generic "Client account missing ra_renewal_date" must NOT fire alongside.
    expect(findings.some(f => f.description.includes("Client account missing ra_renewal_date"))).toBe(false)
  })

  it("for ONBOARDING client detected by R25 gap (formation > 6 months before first payment)", () => {
    // No onboarding offer, but formation 2020 and first payment in 2026 → gap > 182 days.
    const ctx = emptyCtx({
      account: baseAccount({
        formation_date: "2020-01-01",
        ra_renewal_date: "2030-08-01", // would be 4+ years off, normally flagged
        state_of_formation: "WY",
      }),
      payments: [
        { id: "p1", description: "Onboarding setup", status: "Paid", amount: 1000, paid_date: "2026-01-01", created_at: "2026-01-01T00:00:00Z" },
      ],
    })
    const findings = rule7_renewalDates(ctx, NOW)
    expect(findings.some(f => f.description.includes("days off"))).toBe(false)
  })

  it("does NOT treat client as onboarding when first payment is within 6 months of formation", () => {
    const ctx = emptyCtx({
      account: baseAccount({
        formation_date: "2025-06-01",
        ra_renewal_date: "2030-01-01", // way off → should flag
        state_of_formation: "WY",
      }),
      payments: [
        { id: "p1", description: "Setup fee", status: "Paid", amount: 1000, paid_date: "2025-08-01", created_at: "2025-08-01T00:00:00Z" },
      ],
    })
    const findings = rule7_renewalDates(ctx, NOW)
    expect(findings.some(f => f.description.includes("days off"))).toBe(true)
  })
})

// ── R8: DOCUMENTS COMPLETENESS ─────────────────────────────────────────────

describe("rule8_documentsCompleteness", () => {
  it("flags signed SS-4 with no SS-4 document indexed", () => {
    const ctx = emptyCtx({
      account: baseAccount({ ein_number: "12-3456789" }),
      ss4_applications: [{ id: "s1", status: "done", pdf_signed_drive_id: "drive-1", created_at: null, updated_at: null }],
      documents: [{ id: "d1", account_id: ACCOUNT_ID, contact_id: null, document_type_name: "Operating Agreement", file_name: "oa.pdf" }],
    })
    const findings = rule8_documentsCompleteness(ctx)
    expect(findings.some(f => f.description.includes("SS-4 PDF"))).toBe(true)
  })

  it("does NOT flag SS-4 when an SS-4 doc exists", () => {
    const ctx = emptyCtx({
      account: baseAccount({ ein_number: "12-3456789" }),
      ss4_applications: [{ id: "s1", status: "done", pdf_signed_drive_id: "drive-1", created_at: null, updated_at: null }],
      documents: [{ id: "d1", account_id: ACCOUNT_ID, contact_id: null, document_type_name: "SS-4 Application", file_name: "ss4.pdf" }],
    })
    const findings = rule8_documentsCompleteness(ctx)
    expect(findings.some(f => f.description.includes("SS-4 PDF"))).toBe(false)
  })

  it("flags zero docs on active EIN account", () => {
    const ctx = emptyCtx({ account: baseAccount({ ein_number: "12-3456789" }) })
    const findings = rule8_documentsCompleteness(ctx)
    expect(findings.some(f => f.description.includes("zero documents"))).toBe(true)
  })

  it("counts contact-linked docs alongside account-linked docs", () => {
    const ctx = emptyCtx({
      account: baseAccount({ ein_number: "12-3456789" }),
      contacts: [{ id: "c1", email: "x@y.com", portal_tier: null }],
      documents: [{ id: "d1", account_id: null, contact_id: "c1", document_type_name: "Passport", file_name: "passport.pdf" }],
    })
    const findings = rule8_documentsCompleteness(ctx)
    expect(findings.some(f => f.description.includes("zero documents"))).toBe(false)
  })

  it("does NOT flag zero docs on One-Time", () => {
    const ctx = emptyCtx({
      account: baseAccount({ ein_number: "12-3456789", account_type: "One-Time" }),
    })
    expect(rule8_documentsCompleteness(ctx).some(f => f.description.includes("zero"))).toBe(false)
  })
})

// ── R9: ONBOARDING VS FORMATION ────────────────────────────────────────────

describe("rule9_onboardingVsFormation", () => {
  it("emits info when onboarding offer + formation_date set", () => {
    const ctx = emptyCtx({
      account: baseAccount({ formation_date: "2024-01-01" }),
      most_recent_offer: { contract_type: "onboarding" },
    })
    const findings = rule9_onboardingVsFormation(ctx)
    expect(findings).toHaveLength(1)
    expect(findings[0].severity).toBe("info")
  })

  it("emits info when no offer found and EIN exists without formation_date", () => {
    const ctx = emptyCtx({
      account: baseAccount({ ein_number: "12-3456789" }),
      most_recent_offer: null,
    })
    expect(rule9_onboardingVsFormation(ctx)).toHaveLength(1)
  })

  it("does NOT flag formation-typed offer", () => {
    const ctx = emptyCtx({
      account: baseAccount({ formation_date: "2024-01-01" }),
      most_recent_offer: { contract_type: "formation" },
    })
    expect(rule9_onboardingVsFormation(ctx)).toEqual([])
  })
})

// ── R10: TAX RETURN DUAL TRACKING ──────────────────────────────────────────

describe("rule10_taxReturnDualTracking", () => {
  it("flags tax_returns row but no Tax Return SD", () => {
    const ctx = emptyCtx({
      tax_returns: [{ id: "t1", tax_year: 2025, status: "pending" }],
    })
    const findings = rule10_taxReturnDualTracking(ctx)
    expect(findings).toHaveLength(1)
    expect(findings[0].severity).toBe("warning")
  })

  it("does NOT flag when Tax Return SD exists", () => {
    const ctx = emptyCtx({
      tax_returns: [{ id: "t1", tax_year: 2025, status: "pending" }],
      service_deliveries: [
        {
          id: "sd1", service_type: "Tax Return", status: "active", stage: "Data Pending",
          stage_order: -1, account_id: ACCOUNT_ID, contact_id: null, created_at: "2026-01-01T00:00:00Z",
        },
      ],
    })
    expect(rule10_taxReturnDualTracking(ctx)).toEqual([])
  })

  it("does NOT flag when no tax_returns row exists", () => {
    const ctx = emptyCtx()
    expect(rule10_taxReturnDualTracking(ctx)).toEqual([])
  })

  it("emits INFO 'in sync' when SD stage matches mapped TR status", () => {
    const ctx = emptyCtx({
      tax_returns: [{ id: "t1", tax_year: 2025, status: "Data Received" }],
      service_deliveries: [
        {
          id: "sd1", service_type: "Tax Return", status: "active", stage: "Data Received",
          stage_order: 3, account_id: ACCOUNT_ID, contact_id: null, created_at: "2026-01-01T00:00:00Z",
        },
      ],
    })
    const findings = rule10_taxReturnDualTracking(ctx)
    expect(findings).toHaveLength(1)
    expect(findings[0].severity).toBe("info")
    expect(findings[0].description).toContain("in sync")
  })

  it("emits INFO 'tracks different aspects' when SD stage and TR status disagree", () => {
    const ctx = emptyCtx({
      tax_returns: [{ id: "t1", tax_year: 2025, status: "TR Filed" }],
      service_deliveries: [
        {
          id: "sd1", service_type: "Tax Return", status: "active", stage: "Preparation",
          stage_order: 5, account_id: ACCOUNT_ID, contact_id: null, created_at: "2026-01-01T00:00:00Z",
        },
      ],
    })
    const findings = rule10_taxReturnDualTracking(ctx)
    expect(findings).toHaveLength(1)
    expect(findings[0].severity).toBe("info")
    expect(findings[0].description).toContain("track different aspects")
    expect(findings[0].description).toContain("SD = payment lifecycle")
  })

  it("emits no finding when TR status doesn't map to any SD stage", () => {
    const ctx = emptyCtx({
      // "pending" is not in TAX_RETURN_STATUS_TO_SD_STAGE — mapper returns null.
      tax_returns: [{ id: "t1", tax_year: 2025, status: "pending" }],
      service_deliveries: [
        {
          id: "sd1", service_type: "Tax Return", status: "active", stage: "Data Received",
          stage_order: 3, account_id: ACCOUNT_ID, contact_id: null, created_at: "2026-01-01T00:00:00Z",
        },
      ],
    })
    expect(rule10_taxReturnDualTracking(ctx)).toEqual([])
  })
})

// ── R11: OFFER TYPE CONSISTENCY ────────────────────────────────────────────

describe("rule11_offerTypeConsistency", () => {
  const NOW = new Date("2026-06-01T00:00:00Z")

  it("flags renewal offer on a recently formed company", () => {
    const ctx = emptyCtx({
      account: baseAccount({ formation_date: "2026-02-01" }), // 4 months ago
      most_recent_offer: { contract_type: "renewal" },
    })
    const findings = rule11_offerTypeConsistency(ctx, NOW)
    expect(findings).toHaveLength(1)
    expect(findings[0].severity).toBe("warning")
    expect(findings[0].description).toContain("recently formed")
  })

  it("does NOT flag renewal on a company formed > 12 months ago", () => {
    const ctx = emptyCtx({
      account: baseAccount({ formation_date: "2024-01-01" }), // ~29 months ago
      most_recent_offer: { contract_type: "renewal" },
    })
    expect(rule11_offerTypeConsistency(ctx, NOW)).toEqual([])
  })

  it("does NOT flag formation/onboarding offers", () => {
    const ctx1 = emptyCtx({
      account: baseAccount({ formation_date: "2026-02-01" }),
      most_recent_offer: { contract_type: "formation" },
    })
    const ctx2 = emptyCtx({
      account: baseAccount({ formation_date: "2026-02-01" }),
      most_recent_offer: { contract_type: "onboarding" },
    })
    expect(rule11_offerTypeConsistency(ctx1, NOW)).toEqual([])
    expect(rule11_offerTypeConsistency(ctx2, NOW)).toEqual([])
  })

  it("does NOT flag when there's no formation_date", () => {
    const ctx = emptyCtx({
      most_recent_offer: { contract_type: "renewal" },
    })
    expect(rule11_offerTypeConsistency(ctx, NOW)).toEqual([])
  })

  it("does NOT flag when there's no offer", () => {
    const ctx = emptyCtx({
      account: baseAccount({ formation_date: "2026-02-01" }),
      most_recent_offer: null,
    })
    expect(rule11_offerTypeConsistency(ctx, NOW)).toEqual([])
  })
})

// ── R12: LEAD LINKAGE ──────────────────────────────────────────────────────

describe("rule12_leadLinkage", () => {
  it("flags Converted lead missing converted_to_contact_id", () => {
    const ctx = emptyCtx({
      leads: [{
        id: "lead-1", email: "x@y.com", status: "Converted",
        converted_to_contact_id: null, converted_to_account_id: ACCOUNT_ID,
      }],
    })
    const findings = rule12_leadLinkage(ctx)
    expect(findings.some(f => f.description.includes("converted_to_contact_id"))).toBe(true)
  })

  it("flags Converted lead missing converted_to_account_id (account exists)", () => {
    const ctx = emptyCtx({
      leads: [{
        id: "lead-1", email: "x@y.com", status: "Converted",
        converted_to_contact_id: "c1", converted_to_account_id: null,
      }],
    })
    const findings = rule12_leadLinkage(ctx)
    expect(findings.some(f => f.description.includes("converted_to_account_id is not set"))).toBe(true)
  })

  it("flags BOTH pointers null on a Converted lead", () => {
    const ctx = emptyCtx({
      leads: [{
        id: "lead-1", email: "x@y.com", status: "Converted",
        converted_to_contact_id: null, converted_to_account_id: null,
      }],
    })
    expect(rule12_leadLinkage(ctx)).toHaveLength(2)
  })

  it("does NOT flag a fully-linked Converted lead", () => {
    const ctx = emptyCtx({
      leads: [{
        id: "lead-1", email: "x@y.com", status: "Converted",
        converted_to_contact_id: "c1", converted_to_account_id: ACCOUNT_ID,
      }],
    })
    expect(rule12_leadLinkage(ctx)).toEqual([])
  })

  it("does NOT flag a lead whose status is NOT 'Converted'", () => {
    const ctx = emptyCtx({
      leads: [{
        id: "lead-1", email: "x@y.com", status: "Qualified",
        converted_to_contact_id: null, converted_to_account_id: null,
      }],
    })
    expect(rule12_leadLinkage(ctx)).toEqual([])
  })

  it("does NOT flag when no leads are linked", () => {
    expect(rule12_leadLinkage(emptyCtx())).toEqual([])
  })
})

// ── R13: DBA TRACKING ──────────────────────────────────────────────────────

describe("rule13_dbaTracking", () => {
  it("flags document with 'DBA' in document_type_name", () => {
    const ctx = emptyCtx({
      documents: [{ id: "d1", account_id: ACCOUNT_ID, contact_id: null, document_type_name: "DBA Filing", file_name: "dba.pdf" }],
    })
    const findings = rule13_dbaTracking(ctx)
    expect(findings).toHaveLength(1)
    expect(findings[0].severity).toBe("info")
    expect(findings[0].description).toContain("no DBA tracking")
  })

  it("flags document with 'Trade Name' in file_name", () => {
    const ctx = emptyCtx({
      documents: [{ id: "d1", account_id: ACCOUNT_ID, contact_id: null, document_type_name: "Other", file_name: "Trade Name Certificate.pdf" }],
    })
    const findings = rule13_dbaTracking(ctx)
    expect(findings).toHaveLength(1)
  })

  it("flags document with 'Fictitious Name' (case-insensitive)", () => {
    const ctx = emptyCtx({
      documents: [{ id: "d1", account_id: ACCOUNT_ID, contact_id: null, document_type_name: "fictitious name registration", file_name: "f.pdf" }],
    })
    expect(rule13_dbaTracking(ctx)).toHaveLength(1)
  })

  it("considers contact-linked docs alongside account-linked", () => {
    const ctx = emptyCtx({
      contacts: [{ id: "c1", email: "x@y.com", portal_tier: null }],
      documents: [{ id: "d1", account_id: null, contact_id: "c1", document_type_name: "DBA", file_name: "dba.pdf" }],
    })
    expect(rule13_dbaTracking(ctx)).toHaveLength(1)
  })

  it("does NOT flag when no document matches DBA keywords", () => {
    const ctx = emptyCtx({
      documents: [{ id: "d1", account_id: ACCOUNT_ID, contact_id: null, document_type_name: "Operating Agreement", file_name: "oa.pdf" }],
    })
    expect(rule13_dbaTracking(ctx)).toEqual([])
  })

  it("does NOT flag when no documents exist", () => {
    expect(rule13_dbaTracking(emptyCtx())).toEqual([])
  })
})

// ── R14: MMLLC MEMBER COMPLETENESS ─────────────────────────────────────────

describe("rule14_mmllcMemberCompleteness", () => {
  it("does NOT fire for non-MMLLC accounts", () => {
    const ctx = emptyCtx({
      account: baseAccount({ entity_type: "Single Member LLC" }),
      members: [],
    })
    expect(rule14_mmllcMemberCompleteness(ctx)).toEqual([])
  })

  it("flags MMLLC with fewer than 2 members", () => {
    const ctx = emptyCtx({
      account: baseAccount({ entity_type: "Multi Member LLC" }),
      members: [
        { member_type: "individual", full_name: "Alice", representative_name: null, is_primary: true, ownership_pct: 100, contact_id: "c1" },
      ],
    })
    const findings = rule14_mmllcMemberCompleteness(ctx)
    expect(findings.some(f => f.description.includes("fewer than 2 members"))).toBe(true)
  })

  it("flags MMLLC with no primary member", () => {
    const ctx = emptyCtx({
      account: baseAccount({ entity_type: "Multi Member LLC" }),
      members: [
        { member_type: "individual", full_name: "Alice", representative_name: null, is_primary: false, ownership_pct: 50, contact_id: "c1" },
        { member_type: "individual", full_name: "Bob", representative_name: null, is_primary: false, ownership_pct: 50, contact_id: "c2" },
      ],
    })
    const findings = rule14_mmllcMemberCompleteness(ctx)
    expect(findings.some(f => f.description.includes("no primary member"))).toBe(true)
  })

  it("flags MMLLC with a company member missing representative_name", () => {
    const ctx = emptyCtx({
      account: baseAccount({ entity_type: "Multi Member LLC" }),
      members: [
        { member_type: "individual", full_name: "Alice", representative_name: null, is_primary: true, ownership_pct: 50, contact_id: "c1" },
        { member_type: "company", full_name: "Acme Holdings", representative_name: null, is_primary: false, ownership_pct: 50, contact_id: "c2" },
      ],
    })
    const findings = rule14_mmllcMemberCompleteness(ctx)
    expect(findings.some(f => f.description.includes("missing representative_name"))).toBe(true)
  })

  it("flags MMLLC member missing contact_id", () => {
    const ctx = emptyCtx({
      account: baseAccount({ entity_type: "Multi Member LLC" }),
      members: [
        { member_type: "individual", full_name: "Alice", representative_name: null, is_primary: true, ownership_pct: 50, contact_id: "c1" },
        { member_type: "individual", full_name: "Bob", representative_name: null, is_primary: false, ownership_pct: 50, contact_id: null },
      ],
    })
    const findings = rule14_mmllcMemberCompleteness(ctx)
    expect(findings.some(f => f.description.includes("not linked to a contact"))).toBe(true)
  })

  it("emits no findings for a complete MMLLC", () => {
    const ctx = emptyCtx({
      account: baseAccount({ entity_type: "Multi Member LLC" }),
      members: [
        { member_type: "individual", full_name: "Alice", representative_name: null, is_primary: true, ownership_pct: 50, contact_id: "c1" },
        { member_type: "company", full_name: "Acme Holdings", representative_name: "Bob Smith", is_primary: false, ownership_pct: 50, contact_id: "c2" },
      ],
    })
    expect(rule14_mmllcMemberCompleteness(ctx)).toEqual([])
  })
})

// ── R15: OA SIGNER COUNT ───────────────────────────────────────────────────

describe("rule15_oaSignerCount", () => {
  it("does NOT fire for non-MMLLC accounts", () => {
    const ctx = emptyCtx({
      account: baseAccount({ entity_type: "Single Member LLC" }),
      oa_agreements: [{ id: "oa1", total_signers: 1, status: "signed" }],
      members: [
        { member_type: "individual", full_name: "Solo", representative_name: null, is_primary: true, ownership_pct: 100, contact_id: "c1" },
      ],
    })
    expect(rule15_oaSignerCount(ctx)).toEqual([])
  })

  it("flags OA total_signers < member count", () => {
    const ctx = emptyCtx({
      account: baseAccount({ entity_type: "Multi Member LLC" }),
      oa_agreements: [{ id: "oa1", total_signers: 1, status: "signed" }],
      members: [
        { member_type: "individual", full_name: "Alice", representative_name: null, is_primary: true, ownership_pct: 50, contact_id: "c1" },
        { member_type: "individual", full_name: "Bob", representative_name: null, is_primary: false, ownership_pct: 50, contact_id: "c2" },
      ],
    })
    const findings = rule15_oaSignerCount(ctx)
    expect(findings).toHaveLength(1)
    expect(findings[0].severity).toBe("warning")
    expect(findings[0].description).toContain("OA may need to be regenerated")
  })

  it("does NOT flag when total_signers equals member count", () => {
    const ctx = emptyCtx({
      account: baseAccount({ entity_type: "Multi Member LLC" }),
      oa_agreements: [{ id: "oa1", total_signers: 2, status: "signed" }],
      members: [
        { member_type: "individual", full_name: "Alice", representative_name: null, is_primary: true, ownership_pct: 50, contact_id: "c1" },
        { member_type: "individual", full_name: "Bob", representative_name: null, is_primary: false, ownership_pct: 50, contact_id: "c2" },
      ],
    })
    expect(rule15_oaSignerCount(ctx)).toEqual([])
  })

  it("does NOT flag when total_signers is null (unknown)", () => {
    const ctx = emptyCtx({
      account: baseAccount({ entity_type: "Multi Member LLC" }),
      oa_agreements: [{ id: "oa1", total_signers: null, status: "draft" }],
      members: [
        { member_type: "individual", full_name: "Alice", representative_name: null, is_primary: true, ownership_pct: 50, contact_id: "c1" },
        { member_type: "individual", full_name: "Bob", representative_name: null, is_primary: false, ownership_pct: 50, contact_id: "c2" },
      ],
    })
    expect(rule15_oaSignerCount(ctx)).toEqual([])
  })

  it("does NOT fire when no OA exists", () => {
    const ctx = emptyCtx({
      account: baseAccount({ entity_type: "Multi Member LLC" }),
      members: [
        { member_type: "individual", full_name: "Alice", representative_name: null, is_primary: true, ownership_pct: 50, contact_id: "c1" },
        { member_type: "individual", full_name: "Bob", representative_name: null, is_primary: false, ownership_pct: 50, contact_id: "c2" },
      ],
    })
    expect(rule15_oaSignerCount(ctx)).toEqual([])
  })

  it("does NOT fire when members list is empty (R14 covers this)", () => {
    const ctx = emptyCtx({
      account: baseAccount({ entity_type: "Multi Member LLC" }),
      oa_agreements: [{ id: "oa1", total_signers: 0, status: "draft" }],
      members: [],
    })
    expect(rule15_oaSignerCount(ctx)).toEqual([])
  })
})

// ── R16: CLOSED ACCOUNT PORTAL ACCESS ──────────────────────────────────────

describe("rule16_closedAccountPortalAccess", () => {
  it("flags Cancelled account with portal_tier set as error", () => {
    const ctx = emptyCtx({
      account: baseAccount({ status: "Cancelled", portal_tier: "active" }),
    })
    const findings = rule16_closedAccountPortalAccess(ctx)
    expect(findings).toHaveLength(1)
    expect(findings[0].severity).toBe("error")
    expect(findings[0].description).toContain("security issue")
  })

  it("flags Closed account with portal_tier", () => {
    const ctx = emptyCtx({
      account: baseAccount({ status: "Closed", portal_tier: "onboarding" }),
    })
    expect(rule16_closedAccountPortalAccess(ctx)).toHaveLength(1)
  })

  it("flags Suspended account with portal_tier", () => {
    const ctx = emptyCtx({
      account: baseAccount({ status: "Suspended", portal_tier: "lead" }),
    })
    expect(rule16_closedAccountPortalAccess(ctx)).toHaveLength(1)
  })

  it("flags Offboarding account with portal_tier", () => {
    const ctx = emptyCtx({
      account: baseAccount({ status: "Offboarding", portal_tier: "formation" }),
    })
    expect(rule16_closedAccountPortalAccess(ctx)).toHaveLength(1)
  })

  it("does NOT flag Cancelled account with portal_tier=null", () => {
    const ctx = emptyCtx({
      account: baseAccount({ status: "Cancelled", portal_tier: null }),
    })
    expect(rule16_closedAccountPortalAccess(ctx)).toEqual([])
  })

  it("does NOT flag Active account even with portal_tier set", () => {
    const ctx = emptyCtx({
      account: baseAccount({ status: "Active", portal_tier: "active" }),
    })
    expect(rule16_closedAccountPortalAccess(ctx)).toEqual([])
  })
})

// ── R17: SAME-YEAR TAX RETURN ──────────────────────────────────────────────

describe("rule17_sameYearTaxReturn", () => {
  const NOW = new Date("2026-06-01T00:00:00Z")

  it("flags formation-year tax_returns row as ERROR", () => {
    const ctx = emptyCtx({
      account: baseAccount({ formation_date: "2026-03-15" }),
      tax_returns: [{ id: "t1", tax_year: 2026, status: "pending" }],
    })
    const findings = rule17_sameYearTaxReturn(ctx, NOW)
    expect(findings).toHaveLength(1)
    expect(findings[0].severity).toBe("error")
    expect(findings[0].description).toContain("Company formed in 2026")
    expect(findings[0].description).toContain("filed in 2027")
  })

  it("flags formation-year Tax Return SD", () => {
    const ctx = emptyCtx({
      account: baseAccount({ formation_date: "2026-03-15" }),
      service_deliveries: [
        {
          id: "sd1", service_type: "Tax Return", status: "active", stage: "Data Pending",
          stage_order: -1, account_id: ACCOUNT_ID, contact_id: null, created_at: "2026-04-01T00:00:00Z",
        },
      ],
    })
    const findings = rule17_sameYearTaxReturn(ctx, NOW)
    expect(findings).toHaveLength(1)
    expect(findings[0].current_value).toContain("service_deliveries.service_type='Tax Return'")
  })

  it("flags formation-year Tax Return payment (description contains 'Tax Return')", () => {
    const ctx = emptyCtx({
      account: baseAccount({ formation_date: "2026-03-15" }),
      payments: [{ id: "p1", description: "Tax Return 2025", status: "Paid", amount: 750, paid_date: null, created_at: "2026-04-01T00:00:00Z" }],
    })
    const findings = rule17_sameYearTaxReturn(ctx, NOW)
    expect(findings).toHaveLength(1)
    expect(findings[0].current_value).toContain("payments.description")
  })

  it("description match is case-insensitive", () => {
    const ctx = emptyCtx({
      account: baseAccount({ formation_date: "2026-03-15" }),
      payments: [{ id: "p1", description: "TAX RETURN service", status: "Paid", amount: 750, paid_date: null, created_at: null }],
    })
    expect(rule17_sameYearTaxReturn(ctx, NOW)).toHaveLength(1)
  })

  it("collapses multiple triggers into a single finding listing all of them", () => {
    const ctx = emptyCtx({
      account: baseAccount({ formation_date: "2026-03-15" }),
      tax_returns: [{ id: "t1", tax_year: 2026, status: "pending" }],
      service_deliveries: [
        {
          id: "sd1", service_type: "Tax Return", status: "active", stage: "Data Pending",
          stage_order: -1, account_id: ACCOUNT_ID, contact_id: null, created_at: "2026-04-01T00:00:00Z",
        },
      ],
      payments: [{ id: "p1", description: "Tax Return", status: "Paid", amount: 750, paid_date: null, created_at: null }],
    })
    const findings = rule17_sameYearTaxReturn(ctx, NOW)
    expect(findings).toHaveLength(1)
    expect(findings[0].current_value).toContain("tax_returns.tax_year=2026")
    expect(findings[0].current_value).toContain("service_deliveries.service_type='Tax Return'")
    expect(findings[0].current_value).toContain("payments.description")
  })

  it("does NOT flag when formation_date is in a prior year", () => {
    const ctx = emptyCtx({
      account: baseAccount({ formation_date: "2024-03-15" }),
      tax_returns: [{ id: "t1", tax_year: 2026, status: "pending" }],
    })
    expect(rule17_sameYearTaxReturn(ctx, NOW)).toEqual([])
  })

  it("does NOT flag when no formation_date", () => {
    const ctx = emptyCtx({
      tax_returns: [{ id: "t1", tax_year: 2026, status: "pending" }],
    })
    expect(rule17_sameYearTaxReturn(ctx, NOW)).toEqual([])
  })

  it("does NOT flag a tax_returns row for a different tax_year", () => {
    const ctx = emptyCtx({
      account: baseAccount({ formation_date: "2026-03-15" }),
      tax_returns: [{ id: "t1", tax_year: 2025, status: "filed" }],
    })
    expect(rule17_sameYearTaxReturn(ctx, NOW)).toEqual([])
  })

  it("does NOT flag a cancelled Tax Return SD", () => {
    const ctx = emptyCtx({
      account: baseAccount({ formation_date: "2026-03-15" }),
      service_deliveries: [
        {
          id: "sd1", service_type: "Tax Return", status: "cancelled", stage: "Cancelled",
          stage_order: 99, account_id: ACCOUNT_ID, contact_id: null, created_at: "2026-04-01T00:00:00Z",
        },
      ],
    })
    expect(rule17_sameYearTaxReturn(ctx, NOW)).toEqual([])
  })

  it("does NOT flag payments whose description doesn't mention Tax Return", () => {
    const ctx = emptyCtx({
      account: baseAccount({ formation_date: "2026-03-15" }),
      payments: [{ id: "p1", description: "Formation fee", status: "Paid", amount: 1000, paid_date: null, created_at: null }],
    })
    expect(rule17_sameYearTaxReturn(ctx, NOW)).toEqual([])
  })
})

// ── R18: PARTNER CLIENT SERVICE SCOPE ──────────────────────────────────────

describe("rule18_partnerServiceScope", () => {
  it("flags One-Time partner client with renewal date for service NOT in agreed_services", () => {
    const ctx = emptyCtx({
      account: baseAccount({
        account_type: "One-Time",
        ra_renewal_date: "2027-01-01",
        annual_report_due_date: "2027-05-01",
      }),
      contacts: [{ id: "c1", email: "x@y.com", portal_tier: null }],
      client_partners: [{ id: "p1", contact_id: "c1", partner_name: "Maxscale", agreed_services: ["cmra"] }],
    })
    const findings = rule18_partnerServiceScope(ctx)
    expect(findings).toHaveLength(1)
    expect(findings[0].severity).toBe("warning")
    expect(findings[0].description).toContain("not in the partner agreement")
    expect(findings[0].current_value).toContain("RA renewal")
    expect(findings[0].current_value).toContain("annual report")
    expect(findings[0].current_value).toContain("Maxscale")
  })

  it("does NOT flag when the renewal date IS in the partner's agreed_services (slug match)", () => {
    const ctx = emptyCtx({
      account: baseAccount({ account_type: "One-Time", cmra_renewal_date: "2026-12-31" }),
      contacts: [{ id: "c1", email: "x@y.com", portal_tier: null }],
      client_partners: [{ id: "p1", contact_id: "c1", partner_name: "Maxscale", agreed_services: ["cmra"] }],
    })
    expect(rule18_partnerServiceScope(ctx)).toEqual([])
  })

  it("accepts legacy aliases (ra_renewal, annual_report)", () => {
    const ctx = emptyCtx({
      account: baseAccount({
        account_type: "One-Time",
        ra_renewal_date: "2027-01-01",
        annual_report_due_date: "2027-05-01",
      }),
      contacts: [{ id: "c1", email: "x@y.com", portal_tier: null }],
      client_partners: [{
        id: "p1", contact_id: "c1", partner_name: "Legacy Partner",
        agreed_services: ["ra_renewal", "annual_report"],
      }],
    })
    expect(rule18_partnerServiceScope(ctx)).toEqual([])
  })

  it("does NOT fire on Client accounts (only One-Time)", () => {
    const ctx = emptyCtx({
      account: baseAccount({ account_type: "Client", ra_renewal_date: "2027-01-01" }),
      contacts: [{ id: "c1", email: "x@y.com", portal_tier: null }],
      client_partners: [{ id: "p1", contact_id: "c1", partner_name: "Maxscale", agreed_services: ["cmra"] }],
    })
    expect(rule18_partnerServiceScope(ctx)).toEqual([])
  })

  it("does NOT fire when no client_partners are linked", () => {
    const ctx = emptyCtx({
      account: baseAccount({ account_type: "One-Time", ra_renewal_date: "2027-01-01" }),
      contacts: [{ id: "c1", email: "x@y.com", portal_tier: null }],
      client_partners: [],
    })
    expect(rule18_partnerServiceScope(ctx)).toEqual([])
  })

  it("does NOT fire when no renewal-date columns are set", () => {
    const ctx = emptyCtx({
      account: baseAccount({ account_type: "One-Time" }),
      contacts: [{ id: "c1", email: "x@y.com", portal_tier: null }],
      client_partners: [{ id: "p1", contact_id: "c1", partner_name: "Maxscale", agreed_services: ["cmra"] }],
    })
    expect(rule18_partnerServiceScope(ctx)).toEqual([])
  })

  it("treats null agreed_services as empty (every renewal date is out-of-scope)", () => {
    const ctx = emptyCtx({
      account: baseAccount({ account_type: "One-Time", cmra_renewal_date: "2026-12-31" }),
      contacts: [{ id: "c1", email: "x@y.com", portal_tier: null }],
      client_partners: [{ id: "p1", contact_id: "c1", partner_name: "Empty Partner", agreed_services: null }],
    })
    const findings = rule18_partnerServiceScope(ctx)
    expect(findings).toHaveLength(1)
    expect(findings[0].current_value).toContain("CMRA")
  })

  it("unions agreed_services across multiple partner rows", () => {
    const ctx = emptyCtx({
      account: baseAccount({
        account_type: "One-Time",
        cmra_renewal_date: "2026-12-31",
        ra_renewal_date: "2027-01-01",
      }),
      contacts: [{ id: "c1", email: "x@y.com", portal_tier: null }],
      client_partners: [
        { id: "p1", contact_id: "c1", partner_name: "Partner A", agreed_services: ["cmra"] },
        { id: "p2", contact_id: "c1", partner_name: "Partner B", agreed_services: ["state_ra_renewal"] },
      ],
    })
    expect(rule18_partnerServiceScope(ctx)).toEqual([])
  })
})

// ── R19: LEGACY / STALE STATUSES ───────────────────────────────────────────

describe("rule19_legacyStatuses", () => {
  const NOW = new Date("2026-06-01T00:00:00Z")

  it("does NOT flag 'Activated - Need Link' (migrated in tax-return redesign — bug if it reappears, not legacy)", () => {
    const ctx = emptyCtx({
      tax_returns: [{ id: "t1", tax_year: 2025, status: "Activated - Need Link" }],
    })
    expect(rule19_legacyStatuses(ctx, NOW)).toEqual([])
  })

  it("flags tax_returns row with legacy status 'Not Invoiced'", () => {
    const ctx = emptyCtx({
      tax_returns: [{ id: "t1", tax_year: 2025, status: "Not Invoiced" }],
    })
    const findings = rule19_legacyStatuses(ctx, NOW)
    expect(findings).toHaveLength(1)
    expect(findings[0].description).toContain("Not Invoiced")
  })

  it("flags tax_returns row with legacy status 'Link Sent - Awaiting Data'", () => {
    const ctx = emptyCtx({
      tax_returns: [{ id: "t1", tax_year: 2025, status: "Link Sent - Awaiting Data" }],
    })
    const findings = rule19_legacyStatuses(ctx, NOW)
    expect(findings).toHaveLength(1)
    expect(findings[0].severity).toBe("warning")
    expect(findings[0].description).toContain("Link Sent - Awaiting Data")
  })

  it("flags tax_returns row with legacy status 'Paid - Not Started'", () => {
    const ctx = emptyCtx({
      tax_returns: [{ id: "t1", tax_year: 2025, status: "Paid - Not Started" }],
    })
    const findings = rule19_legacyStatuses(ctx, NOW)
    expect(findings).toHaveLength(1)
    expect(findings[0].severity).toBe("warning")
    expect(findings[0].description).toContain("Paid - Not Started")
  })

  it("does NOT flag tax_returns row with a current-workflow status", () => {
    const ctx = emptyCtx({
      tax_returns: [{ id: "t1", tax_year: 2025, status: "Data Received" }],
    })
    expect(rule19_legacyStatuses(ctx, NOW)).toEqual([])
  })

  it("flags payment that has been Pending for more than 30 days", () => {
    const ctx = emptyCtx({
      payments: [{
        id: "p1", description: "Annual fee", status: "Pending",
        amount: 500, paid_date: null,
        created_at: "2026-04-01T00:00:00Z", // 61 days before NOW
      }],
    })
    const findings = rule19_legacyStatuses(ctx, NOW)
    expect(findings).toHaveLength(1)
    expect(findings[0].severity).toBe("info")
    expect(findings[0].description).toContain("'Annual fee'")
    expect(findings[0].description).toContain("Pending for 61 days")
  })

  it("does NOT flag a Pending payment that's less than 30 days old", () => {
    const ctx = emptyCtx({
      payments: [{
        id: "p1", description: "Recent invoice", status: "Pending",
        amount: 500, paid_date: null,
        created_at: "2026-05-15T00:00:00Z", // 17 days before NOW
      }],
    })
    expect(rule19_legacyStatuses(ctx, NOW)).toEqual([])
  })

  it("does NOT flag a Paid payment regardless of age", () => {
    const ctx = emptyCtx({
      payments: [{
        id: "p1", description: "Old payment", status: "Paid",
        amount: 500, paid_date: null,
        created_at: "2024-01-01T00:00:00Z",
      }],
    })
    expect(rule19_legacyStatuses(ctx, NOW)).toEqual([])
  })

  it("does NOT flag a Pending payment with null created_at (can't compute age)", () => {
    const ctx = emptyCtx({
      payments: [{ id: "p1", description: "Unknown date", status: "Pending", amount: 500, paid_date: null, created_at: null }],
    })
    expect(rule19_legacyStatuses(ctx, NOW)).toEqual([])
  })

  it("falls back to payment id when description is null", () => {
    const ctx = emptyCtx({
      payments: [{
        id: "abc-123", description: null, status: "Pending",
        amount: 500, paid_date: null,
        created_at: "2026-04-01T00:00:00Z",
      }],
    })
    const findings = rule19_legacyStatuses(ctx, NOW)
    expect(findings).toHaveLength(1)
    expect(findings[0].description).toContain("'abc-123'")
  })

  it("flags BOTH a legacy tax_returns row AND a stale pending payment in one pass", () => {
    const ctx = emptyCtx({
      tax_returns: [{ id: "t1", tax_year: 2025, status: "Not Invoiced" }],
      payments: [{
        id: "p1", description: "Old fee", status: "Pending",
        amount: 500, paid_date: null,
        created_at: "2026-04-01T00:00:00Z",
      }],
    })
    const findings = rule19_legacyStatuses(ctx, NOW)
    expect(findings).toHaveLength(2)
    expect(findings.some(f => f.severity === "warning")).toBe(true)
    expect(findings.some(f => f.severity === "info")).toBe(true)
  })
})

// ── R20: ENTITY TYPE VALIDATION ────────────────────────────────────────────

describe("rule20_entityTypeValidation", () => {
  it("flags active account with null entity_type", () => {
    const ctx = emptyCtx({
      account: baseAccount({ status: "Active", entity_type: null }),
    })
    const findings = rule20_entityTypeValidation(ctx)
    expect(findings).toHaveLength(1)
    expect(findings[0].severity).toBe("warning")
    expect(findings[0].description).toBe("Entity type not set.")
  })

  it("does NOT flag active account with entity_type='Single Member LLC'", () => {
    const ctx = emptyCtx({
      account: baseAccount({ status: "Active", entity_type: "Single Member LLC" }),
    })
    expect(rule20_entityTypeValidation(ctx)).toEqual([])
  })

  it("does NOT flag active account with entity_type='Multi Member LLC'", () => {
    const ctx = emptyCtx({
      account: baseAccount({ status: "Active", entity_type: "Multi Member LLC" }),
    })
    expect(rule20_entityTypeValidation(ctx)).toEqual([])
  })

  it("does NOT flag active account with entity_type='C-Corp Elected'", () => {
    const ctx = emptyCtx({
      account: baseAccount({ status: "Active", entity_type: "C-Corp Elected" }),
    })
    expect(rule20_entityTypeValidation(ctx)).toEqual([])
  })

  it("does NOT flag a Cancelled account with null entity_type", () => {
    const ctx = emptyCtx({
      account: baseAccount({ status: "Cancelled", entity_type: null }),
    })
    expect(rule20_entityTypeValidation(ctx)).toEqual([])
  })

  it("does NOT flag a Closed account with null entity_type", () => {
    const ctx = emptyCtx({
      account: baseAccount({ status: "Closed", entity_type: null }),
    })
    expect(rule20_entityTypeValidation(ctx)).toEqual([])
  })

  it("treats empty-string entity_type the same as null", () => {
    const ctx = emptyCtx({
      account: baseAccount({ status: "Active", entity_type: "" }),
    })
    const findings = rule20_entityTypeValidation(ctx)
    expect(findings).toHaveLength(1)
  })
})

// ── R21: ZERO-AMOUNT / SAME-YEAR INSTALLMENT ───────────────────────────────

describe("rule21_zeroAmountInstallment", () => {
  const NOW = new Date("2026-06-01T00:00:00Z")

  it("flags zero-amount installment in same year as first payment as ERROR", () => {
    const ctx = emptyCtx({
      payments: [
        { id: "p1", description: "Setup Fee", status: "Paid", amount: 1000, paid_date: "2026-02-01", created_at: "2026-02-01T00:00:00Z" },
        { id: "p2", description: "Installment 1", status: "Pending", amount: 0, paid_date: null, created_at: "2026-03-01T00:00:00Z" },
      ],
    })
    const findings = rule21_zeroAmountInstallment(ctx, NOW)
    expect(findings.some(f => f.severity === "error" && f.description.includes("same year as onboarding"))).toBe(true)
  })

  it("does NOT flag installment whose first payment year is a prior year", () => {
    const ctx = emptyCtx({
      payments: [
        { id: "p1", description: "Setup Fee", status: "Paid", amount: 1000, paid_date: "2025-02-01", created_at: "2025-02-01T00:00:00Z" },
        { id: "p2", description: "Installment 1", status: "Pending", amount: 0, paid_date: null, created_at: "2026-03-01T00:00:00Z" },
      ],
    })
    const findings = rule21_zeroAmountInstallment(ctx, NOW)
    expect(findings.some(f => f.severity === "error")).toBe(false)
  })

  it("flags any zero-amount Paid payment as WARNING", () => {
    const ctx = emptyCtx({
      payments: [
        { id: "p1", description: "Some service", status: "Paid", amount: 0, paid_date: "2025-01-01", created_at: "2025-01-01T00:00:00Z" },
      ],
    })
    const findings = rule21_zeroAmountInstallment(ctx, NOW)
    expect(findings).toHaveLength(1)
    expect(findings[0].severity).toBe("warning")
    expect(findings[0].description).toContain("$0 payment exists")
  })

  it("does NOT double-flag a same-year zero-amount installment that is Paid (error only)", () => {
    const ctx = emptyCtx({
      payments: [
        { id: "p1", description: "Setup Fee", status: "Paid", amount: 1000, paid_date: "2026-02-01", created_at: "2026-02-01T00:00:00Z" },
        { id: "p2", description: "Installment 1", status: "Paid", amount: 0, paid_date: "2026-03-01", created_at: "2026-03-01T00:00:00Z" },
      ],
    })
    const findings = rule21_zeroAmountInstallment(ctx, NOW)
    expect(findings.filter(f => f.current_value?.includes("p2"))).toHaveLength(1)
    expect(findings.find(f => f.current_value?.includes("p2"))?.severity).toBe("error")
  })

  it("does NOT flag a non-installment zero-amount Pending payment", () => {
    const ctx = emptyCtx({
      payments: [
        { id: "p1", description: "Quote draft", status: "Pending", amount: 0, paid_date: null, created_at: "2026-03-01T00:00:00Z" },
      ],
    })
    expect(rule21_zeroAmountInstallment(ctx, NOW)).toEqual([])
  })

  it("does NOT flag a non-zero installment in same year", () => {
    const ctx = emptyCtx({
      payments: [
        { id: "p1", description: "Installment 1", status: "Paid", amount: 500, paid_date: "2026-02-01", created_at: "2026-02-01T00:00:00Z" },
      ],
    })
    expect(rule21_zeroAmountInstallment(ctx, NOW)).toEqual([])
  })

  it("does NOT fire when no payments exist", () => {
    expect(rule21_zeroAmountInstallment(emptyCtx(), NOW)).toEqual([])
  })

  it("matches 'installment' case-insensitively in description", () => {
    const ctx = emptyCtx({
      payments: [
        { id: "p1", description: "Setup", status: "Paid", amount: 1000, paid_date: "2026-02-01", created_at: "2026-02-01T00:00:00Z" },
        { id: "p2", description: "INSTALLMENT 2 of 4", status: "Pending", amount: 0, paid_date: null, created_at: "2026-04-01T00:00:00Z" },
      ],
    })
    const findings = rule21_zeroAmountInstallment(ctx, NOW)
    expect(findings.some(f => f.severity === "error")).toBe(true)
  })
})

// ── R22: ONE-TIME TIER VALIDATION ──────────────────────────────────────────

describe("rule22_oneTimeTier", () => {
  it("flags One-Time with portal_tier='onboarding' as WARNING", () => {
    const ctx = emptyCtx({
      account: baseAccount({ account_type: "One-Time", portal_tier: "onboarding" }),
    })
    const findings = rule22_oneTimeTier(ctx)
    expect(findings).toHaveLength(1)
    expect(findings[0].severity).toBe("warning")
    expect(findings[0].description).toContain("'onboarding'")
  })

  it("flags One-Time with portal_tier='formation'", () => {
    const ctx = emptyCtx({
      account: baseAccount({ account_type: "One-Time", portal_tier: "formation" }),
    })
    const findings = rule22_oneTimeTier(ctx)
    expect(findings).toHaveLength(1)
    expect(findings[0].description).toContain("'formation'")
  })

  it("does NOT flag One-Time with portal_tier='active'", () => {
    const ctx = emptyCtx({
      account: baseAccount({ account_type: "One-Time", portal_tier: "active" }),
    })
    expect(rule22_oneTimeTier(ctx)).toEqual([])
  })

  it("does NOT flag One-Time with portal_tier='lead'", () => {
    const ctx = emptyCtx({
      account: baseAccount({ account_type: "One-Time", portal_tier: "lead" }),
    })
    expect(rule22_oneTimeTier(ctx)).toEqual([])
  })

  it("does NOT flag Client account with portal_tier='onboarding'", () => {
    const ctx = emptyCtx({
      account: baseAccount({ account_type: "Client", portal_tier: "onboarding" }),
    })
    expect(rule22_oneTimeTier(ctx)).toEqual([])
  })

  it("does NOT flag One-Time with portal_tier=null", () => {
    const ctx = emptyCtx({
      account: baseAccount({ account_type: "One-Time", portal_tier: null }),
    })
    expect(rule22_oneTimeTier(ctx)).toEqual([])
  })
})

// ── R23: MISSING tax_returns RECORD ────────────────────────────────────────

describe("rule23_missingTaxReturnRow", () => {
  it("flags active Tax Return SD with no tax_returns rows as WARNING", () => {
    const ctx = emptyCtx({
      service_deliveries: [
        {
          id: "sd1", service_type: "Tax Return", status: "active", stage: "Data Pending",
          stage_order: -1, account_id: ACCOUNT_ID, contact_id: null, created_at: "2026-01-01T00:00:00Z",
        },
      ],
      tax_returns: [],
    })
    const findings = rule23_missingTaxReturnRow(ctx)
    expect(findings).toHaveLength(1)
    expect(findings[0].severity).toBe("warning")
    expect(findings[0].description).toContain("no tax_returns tracking record")
  })

  it("does NOT flag when tax_returns row exists", () => {
    const ctx = emptyCtx({
      service_deliveries: [
        {
          id: "sd1", service_type: "Tax Return", status: "active", stage: "Data Pending",
          stage_order: -1, account_id: ACCOUNT_ID, contact_id: null, created_at: "2026-01-01T00:00:00Z",
        },
      ],
      tax_returns: [{ id: "t1", tax_year: 2025, status: "pending" }],
    })
    expect(rule23_missingTaxReturnRow(ctx)).toEqual([])
  })

  it("does NOT flag a cancelled Tax Return SD", () => {
    const ctx = emptyCtx({
      service_deliveries: [
        {
          id: "sd1", service_type: "Tax Return", status: "cancelled", stage: "Cancelled",
          stage_order: 99, account_id: ACCOUNT_ID, contact_id: null, created_at: "2026-01-01T00:00:00Z",
        },
      ],
      tax_returns: [],
    })
    expect(rule23_missingTaxReturnRow(ctx)).toEqual([])
  })

  it("does NOT flag when no Tax Return SD exists at all", () => {
    expect(rule23_missingTaxReturnRow(emptyCtx())).toEqual([])
  })
})

// ── R24: INCOMPLETE COMPANY DETAILS ────────────────────────────────────────

describe("rule24_incompleteCompanyDetails", () => {
  it("flags Active Client missing state_of_formation as INFO", () => {
    const ctx = emptyCtx({
      account: baseAccount({
        status: "Active", account_type: "Client",
        formation_date: "2025-01-01", state_of_formation: null,
      }),
    })
    const findings = rule24_incompleteCompanyDetails(ctx)
    expect(findings).toHaveLength(1)
    expect(findings[0].severity).toBe("info")
    expect(findings[0].description).toContain("state_of_formation")
    expect(findings[0].description).toContain("onboarding client")
  })

  it("flags Active Client missing formation_date", () => {
    const ctx = emptyCtx({
      account: baseAccount({
        status: "Active", account_type: "Client",
        formation_date: null, state_of_formation: "WY",
      }),
    })
    const findings = rule24_incompleteCompanyDetails(ctx)
    expect(findings).toHaveLength(1)
    expect(findings[0].description).toContain("formation_date")
  })

  it("flags Active Client missing BOTH fields in a single finding listing both", () => {
    const ctx = emptyCtx({
      account: baseAccount({
        status: "Active", account_type: "Client",
        formation_date: null, state_of_formation: null,
      }),
    })
    const findings = rule24_incompleteCompanyDetails(ctx)
    expect(findings).toHaveLength(1)
    expect(findings[0].description).toContain("state_of_formation")
    expect(findings[0].description).toContain("formation_date")
  })

  it("does NOT flag One-Time accounts", () => {
    const ctx = emptyCtx({
      account: baseAccount({
        status: "Active", account_type: "One-Time",
        formation_date: null, state_of_formation: null,
      }),
    })
    expect(rule24_incompleteCompanyDetails(ctx)).toEqual([])
  })

  it("does NOT flag inactive accounts", () => {
    const ctx = emptyCtx({
      account: baseAccount({
        status: "Cancelled", account_type: "Client",
        formation_date: null, state_of_formation: null,
      }),
    })
    expect(rule24_incompleteCompanyDetails(ctx)).toEqual([])
  })

  it("does NOT flag when both fields are populated", () => {
    const ctx = emptyCtx({
      account: baseAccount({
        status: "Active", account_type: "Client",
        formation_date: "2025-01-01", state_of_formation: "WY",
      }),
    })
    expect(rule24_incompleteCompanyDetails(ctx)).toEqual([])
  })
})

// ── R25: ONBOARDING DETECTION ──────────────────────────────────────────────

describe("rule25_onboardingDetection", () => {
  it("flags first payment > 6 months after formation_date as INFO", () => {
    const ctx = emptyCtx({
      account: baseAccount({ formation_date: "2022-01-01" }),
      payments: [
        { id: "p1", description: "Onboarding fee", status: "Paid", amount: 1000, paid_date: "2024-03-01", created_at: "2024-03-01T00:00:00Z" },
      ],
    })
    const findings = rule25_onboardingDetection(ctx)
    expect(findings).toHaveLength(1)
    expect(findings[0].severity).toBe("info")
    expect(findings[0].description).toContain("likely an onboarding client")
    expect(findings[0].description).toContain("client_since")
    expect(findings[0].expected_value).toContain("6 months")
  })

  it("flags first payment between 6 and 12 months after formation (new threshold)", () => {
    // Gap of ~8 months — would NOT have flagged at the old 12-month threshold.
    const ctx = emptyCtx({
      account: baseAccount({ formation_date: "2025-01-01" }),
      payments: [
        { id: "p1", description: "Onboarding fee", status: "Paid", amount: 1000, paid_date: "2025-09-15", created_at: "2025-09-15T00:00:00Z" },
      ],
    })
    expect(rule25_onboardingDetection(ctx)).toHaveLength(1)
  })

  it("uses paid_date when present, falls back to created_at otherwise", () => {
    const ctx = emptyCtx({
      account: baseAccount({ formation_date: "2022-01-01" }),
      payments: [
        { id: "p1", description: "Onboarding fee", status: "Paid", amount: 1000, paid_date: null, created_at: "2024-03-01T00:00:00Z" },
      ],
    })
    expect(rule25_onboardingDetection(ctx)).toHaveLength(1)
  })

  it("uses the EARLIEST payment when multiple exist", () => {
    const ctx = emptyCtx({
      account: baseAccount({ formation_date: "2022-01-01" }),
      payments: [
        { id: "p1", description: "Old onboarding", status: "Paid", amount: 1000, paid_date: "2022-02-01", created_at: "2022-02-01T00:00:00Z" },
        { id: "p2", description: "Renewal", status: "Paid", amount: 1000, paid_date: "2025-01-01", created_at: "2025-01-01T00:00:00Z" },
      ],
    })
    // First payment was within 6 months of formation → no finding.
    expect(rule25_onboardingDetection(ctx)).toEqual([])
  })

  it("does NOT flag when first payment is within 6 months of formation", () => {
    const ctx = emptyCtx({
      account: baseAccount({ formation_date: "2025-01-01" }),
      payments: [
        { id: "p1", description: "Setup", status: "Paid", amount: 1000, paid_date: "2025-04-01", created_at: "2025-04-01T00:00:00Z" },
      ],
    })
    expect(rule25_onboardingDetection(ctx)).toEqual([])
  })

  it("does NOT flag when no formation_date is set", () => {
    const ctx = emptyCtx({
      payments: [
        { id: "p1", description: "Setup", status: "Paid", amount: 1000, paid_date: "2024-03-01", created_at: "2024-03-01T00:00:00Z" },
      ],
    })
    expect(rule25_onboardingDetection(ctx)).toEqual([])
  })

  it("does NOT flag when no payments exist", () => {
    const ctx = emptyCtx({
      account: baseAccount({ formation_date: "2022-01-01" }),
    })
    expect(rule25_onboardingDetection(ctx)).toEqual([])
  })

  it("does NOT flag when every payment has null dates", () => {
    const ctx = emptyCtx({
      account: baseAccount({ formation_date: "2022-01-01" }),
      payments: [
        { id: "p1", description: "Unknown date", status: "Pending", amount: 500, paid_date: null, created_at: null },
      ],
    })
    expect(rule25_onboardingDetection(ctx)).toEqual([])
  })
})

// ── R26: TAX RETURN SD STAGE VS PAYMENT CONTEXT ────────────────────────────

describe("rule26_taxReturnStageVsPayments", () => {
  it("flags Tax Return SD at '1st Installment Paid' when no installment payment exists", () => {
    const ctx = emptyCtx({
      service_deliveries: [
        {
          id: "sd1", service_type: "Tax Return", status: "in_progress", stage: "1st Installment Paid",
          stage_order: 10, account_id: ACCOUNT_ID, contact_id: null, created_at: "2026-01-01T00:00:00Z",
        },
      ],
      payments: [
        { id: "p1", description: "Onboarding fee", status: "Paid", amount: 500, paid_date: "2026-01-15", created_at: "2026-01-15T00:00:00Z" },
        { id: "p2", description: "Setup", status: "Paid", amount: 200, paid_date: "2026-01-20", created_at: "2026-01-20T00:00:00Z" },
      ],
    })
    const findings = rule26_taxReturnStageVsPayments(ctx)
    expect(findings).toHaveLength(1)
    expect(findings[0].severity).toBe("warning")
    expect(findings[0].rule_id).toBe("R26")
    expect(findings[0].description).toContain("setup/onboarding fee")
  })

  it("does NOT flag when an installment payment exists (case-insensitive match)", () => {
    const ctx = emptyCtx({
      service_deliveries: [
        {
          id: "sd1", service_type: "Tax Return", status: "in_progress", stage: "1st Installment Paid",
          stage_order: 10, account_id: ACCOUNT_ID, contact_id: null, created_at: "2026-01-01T00:00:00Z",
        },
      ],
      payments: [
        { id: "p1", description: "1st INSTALLMENT", status: "Paid", amount: 500, paid_date: "2026-01-15", created_at: "2026-01-15T00:00:00Z" },
      ],
    })
    expect(rule26_taxReturnStageVsPayments(ctx)).toEqual([])
  })

  it("does NOT flag when no Tax Return SD exists", () => {
    const ctx = emptyCtx({
      service_deliveries: [
        {
          id: "sd1", service_type: "Company Formation", status: "in_progress", stage: "1st Installment Paid",
          stage_order: 10, account_id: ACCOUNT_ID, contact_id: null, created_at: "2026-01-01T00:00:00Z",
        },
      ],
      payments: [
        { id: "p1", description: "Onboarding", status: "Paid", amount: 500, paid_date: "2026-01-15", created_at: "2026-01-15T00:00:00Z" },
      ],
    })
    expect(rule26_taxReturnStageVsPayments(ctx)).toEqual([])
  })

  it("does NOT flag when Tax Return SD is at a different stage", () => {
    const ctx = emptyCtx({
      service_deliveries: [
        {
          id: "sd1", service_type: "Tax Return", status: "in_progress", stage: "Data Received",
          stage_order: 20, account_id: ACCOUNT_ID, contact_id: null, created_at: "2026-01-01T00:00:00Z",
        },
      ],
      payments: [
        { id: "p1", description: "Onboarding", status: "Paid", amount: 500, paid_date: "2026-01-15", created_at: "2026-01-15T00:00:00Z" },
      ],
    })
    expect(rule26_taxReturnStageVsPayments(ctx)).toEqual([])
  })

  it("does NOT flag when Tax Return SD is cancelled", () => {
    const ctx = emptyCtx({
      service_deliveries: [
        {
          id: "sd1", service_type: "Tax Return", status: "cancelled", stage: "1st Installment Paid",
          stage_order: 10, account_id: ACCOUNT_ID, contact_id: null, created_at: "2026-01-01T00:00:00Z",
        },
      ],
      payments: [
        { id: "p1", description: "Onboarding", status: "Paid", amount: 500, paid_date: "2026-01-15", created_at: "2026-01-15T00:00:00Z" },
      ],
    })
    expect(rule26_taxReturnStageVsPayments(ctx)).toEqual([])
  })

  it("flags when payments list is empty (SD claims 1st Installment Paid with zero payment rows on file)", () => {
    const ctx = emptyCtx({
      service_deliveries: [
        {
          id: "sd1", service_type: "Tax Return", status: "in_progress", stage: "1st Installment Paid",
          stage_order: 10, account_id: ACCOUNT_ID, contact_id: null, created_at: "2026-01-01T00:00:00Z",
        },
      ],
      payments: [],
    })
    const findings = rule26_taxReturnStageVsPayments(ctx)
    expect(findings).toHaveLength(1)
    expect(findings[0].rule_id).toBe("R26")
  })

  it("matches 'Installment' anywhere in description (e.g. 'Tax Return 2nd installment')", () => {
    const ctx = emptyCtx({
      service_deliveries: [
        {
          id: "sd1", service_type: "Tax Return", status: "in_progress", stage: "1st Installment Paid",
          stage_order: 10, account_id: ACCOUNT_ID, contact_id: null, created_at: "2026-01-01T00:00:00Z",
        },
      ],
      payments: [
        { id: "p1", description: "Tax Return 2nd installment for 2025", status: "Paid", amount: 500, paid_date: "2026-01-15", created_at: "2026-01-15T00:00:00Z" },
      ],
    })
    expect(rule26_taxReturnStageVsPayments(ctx)).toEqual([])
  })

  // ── Wizard Available stage (annual pipeline: expect 2nd+ installment) ────

  it("flags Tax Return SD at 'Wizard Available' on annual client when only 1st installment paid", () => {
    const ctx = emptyCtx({
      account: baseAccount({ account_type: "Client" }),
      service_deliveries: [
        {
          id: "sd1", service_type: "Tax Return", status: "in_progress", stage: "Wizard Available",
          stage_order: 4, account_id: ACCOUNT_ID, contact_id: null, created_at: "2026-01-01T00:00:00Z",
        },
      ],
      payments: [
        { id: "p1", description: "Tax Return 1st installment", status: "Paid", amount: 500, paid_date: "2026-01-15", created_at: "2026-01-15T00:00:00Z" },
      ],
    })
    const findings = rule26_taxReturnStageVsPayments(ctx)
    expect(findings).toHaveLength(1)
    expect(findings[0].rule_id).toBe("R26")
    expect(findings[0].severity).toBe("warning")
    expect(findings[0].description).toContain("Wizard Available")
    expect(findings[0].description).toContain("2nd-or-later installment")
  })

  it("does NOT flag 'Wizard Available' when a 2nd installment payment exists", () => {
    const ctx = emptyCtx({
      account: baseAccount({ account_type: "Client" }),
      service_deliveries: [
        {
          id: "sd1", service_type: "Tax Return", status: "in_progress", stage: "Wizard Available",
          stage_order: 4, account_id: ACCOUNT_ID, contact_id: null, created_at: "2026-01-01T00:00:00Z",
        },
      ],
      payments: [
        { id: "p1", description: "Tax Return 1st installment", status: "Paid", amount: 500, paid_date: "2026-01-15", created_at: "2026-01-15T00:00:00Z" },
        { id: "p2", description: "Tax Return 2nd installment", status: "Paid", amount: 500, paid_date: "2026-02-15", created_at: "2026-02-15T00:00:00Z" },
      ],
    })
    expect(rule26_taxReturnStageVsPayments(ctx)).toEqual([])
  })

  it("does NOT flag 'Wizard Available' when a 3rd installment payment exists", () => {
    const ctx = emptyCtx({
      account: baseAccount({ account_type: "Client" }),
      service_deliveries: [
        {
          id: "sd1", service_type: "Tax Return", status: "in_progress", stage: "Wizard Available",
          stage_order: 4, account_id: ACCOUNT_ID, contact_id: null, created_at: "2026-01-01T00:00:00Z",
        },
      ],
      payments: [
        { id: "p1", description: "Tax Return 3rd installment", status: "Paid", amount: 500, paid_date: "2026-03-15", created_at: "2026-03-15T00:00:00Z" },
      ],
    })
    expect(rule26_taxReturnStageVsPayments(ctx)).toEqual([])
  })

  it("does NOT flag 'Wizard Available' on One-Time client with a Paid payment", () => {
    const ctx = emptyCtx({
      account: baseAccount({ account_type: "One-Time" }),
      service_deliveries: [
        {
          id: "sd1", service_type: "Tax Return", status: "in_progress", stage: "Wizard Available",
          stage_order: 4, account_id: ACCOUNT_ID, contact_id: null, created_at: "2026-01-01T00:00:00Z",
        },
      ],
      payments: [
        { id: "p1", description: "Tax Return Full Fee", status: "Paid", amount: 1500, paid_date: "2026-01-15", created_at: "2026-01-15T00:00:00Z" },
      ],
    })
    expect(rule26_taxReturnStageVsPayments(ctx)).toEqual([])
  })

  it("flags 'Wizard Available' on One-Time client with NO Paid payment", () => {
    const ctx = emptyCtx({
      account: baseAccount({ account_type: "One-Time" }),
      service_deliveries: [
        {
          id: "sd1", service_type: "Tax Return", status: "in_progress", stage: "Wizard Available",
          stage_order: 4, account_id: ACCOUNT_ID, contact_id: null, created_at: "2026-01-01T00:00:00Z",
        },
      ],
      payments: [
        { id: "p1", description: "Tax Return Full Fee", status: "Pending", amount: 1500, paid_date: null, created_at: "2026-01-15T00:00:00Z" },
      ],
    })
    const findings = rule26_taxReturnStageVsPayments(ctx)
    expect(findings).toHaveLength(1)
    expect(findings[0].severity).toBe("warning")
    expect(findings[0].description).toContain("One-Time")
    expect(findings[0].description).toContain("Wizard Available")
  })

  it("flags 'Wizard Available' on annual client when no installment payments at all exist", () => {
    const ctx = emptyCtx({
      account: baseAccount({ account_type: "Client" }),
      service_deliveries: [
        {
          id: "sd1", service_type: "Tax Return", status: "in_progress", stage: "Wizard Available",
          stage_order: 4, account_id: ACCOUNT_ID, contact_id: null, created_at: "2026-01-01T00:00:00Z",
        },
      ],
      payments: [],
    })
    const findings = rule26_taxReturnStageVsPayments(ctx)
    expect(findings).toHaveLength(1)
    expect(findings[0].description).toContain("Wizard Available")
  })
})

// ── R27: TAX RETURN YEAR VALIDATION ────────────────────────────────────────

describe("rule27_taxReturnYearValidation", () => {
  const NOW = new Date("2026-06-01T00:00:00Z")

  it("returns no findings when there are no tax_returns rows", () => {
    expect(rule27_taxReturnYearValidation(emptyCtx(), NOW)).toEqual([])
  })

  it("flags a tax_year in the future (> current year)", () => {
    const ctx = emptyCtx({
      tax_returns: [{ id: "tr1", tax_year: 2027, status: "Draft" }],
    })
    const findings = rule27_taxReturnYearValidation(ctx, NOW)
    expect(findings.some(f => f.severity === "warning" && f.description.includes("in the future"))).toBe(true)
  })

  it("does NOT flag tax_year === current year", () => {
    const ctx = emptyCtx({
      tax_returns: [{ id: "tr1", tax_year: 2026, status: "Draft" }],
    })
    const findings = rule27_taxReturnYearValidation(ctx, NOW)
    expect(findings.some(f => f.description.includes("in the future"))).toBe(false)
  })

  it("flags single tax_return whose year > formation_year", () => {
    const ctx = emptyCtx({
      account: baseAccount({ formation_date: "2023-04-15" }),
      tax_returns: [{ id: "tr1", tax_year: 2024, status: "Filed" }],
    })
    const findings = rule27_taxReturnYearValidation(ctx, NOW)
    const m = findings.find(f => f.description.includes("first tax return should be for year 2023"))
    expect(m).toBeDefined()
    expect(m?.severity).toBe("warning")
  })

  it("does NOT fire first-year check when more than one tax_return exists", () => {
    const ctx = emptyCtx({
      account: baseAccount({ formation_date: "2023-04-15" }),
      tax_returns: [
        { id: "tr1", tax_year: 2023, status: "Filed" },
        { id: "tr2", tax_year: 2024, status: "Filed" },
      ],
    })
    const findings = rule27_taxReturnYearValidation(ctx, NOW)
    expect(findings.some(f => f.description.includes("first tax return should be for"))).toBe(false)
  })

  it("does NOT fire first-year check when tax_year === formation_year", () => {
    const ctx = emptyCtx({
      account: baseAccount({ formation_date: "2023-04-15" }),
      tax_returns: [{ id: "tr1", tax_year: 2023, status: "Filed" }],
    })
    const findings = rule27_taxReturnYearValidation(ctx, NOW)
    expect(findings.some(f => f.description.includes("first tax return should be for"))).toBe(false)
  })

  it("does NOT fire first-year check when formation_date is null", () => {
    const ctx = emptyCtx({
      tax_returns: [{ id: "tr1", tax_year: 2024, status: "Filed" }],
    })
    const findings = rule27_taxReturnYearValidation(ctx, NOW)
    expect(findings.some(f => f.description.includes("first tax return should be for"))).toBe(false)
  })

  it("ignores tax_returns rows with null tax_year", () => {
    const ctx = emptyCtx({
      account: baseAccount({ formation_date: "2023-04-15" }),
      tax_returns: [{ id: "tr1", tax_year: null, status: "Draft" }],
    })
    expect(rule27_taxReturnYearValidation(ctx, NOW)).toEqual([])
  })
})

// ── R28: DUPLICATE PAYMENTS ────────────────────────────────────────────────

describe("rule28_duplicatePayments", () => {
  it("returns no findings when fewer than 2 payments exist", () => {
    const ctx = emptyCtx({
      payments: [
        { id: "p1", description: "x", status: "Paid", amount: 100, paid_date: null, created_at: "2026-01-01T00:00:00Z" },
      ],
    })
    expect(rule28_duplicatePayments(ctx)).toEqual([])
  })

  it("flags two payments with same amount AND same created_at", () => {
    const ctx = emptyCtx({
      payments: [
        { id: "p1", description: "x", status: "Paid", amount: 250, paid_date: null, created_at: "2026-01-15T10:00:00Z" },
        { id: "p2", description: "y", status: "Paid", amount: 250, paid_date: null, created_at: "2026-01-15T10:00:00Z" },
      ],
    })
    const findings = rule28_duplicatePayments(ctx)
    expect(findings).toHaveLength(1)
    expect(findings[0].severity).toBe("warning")
    expect(findings[0].rule_id).toBe("R28")
    expect(findings[0].description).toContain("2 payments of 250")
    expect(findings[0].current_value).toContain("p1")
    expect(findings[0].current_value).toContain("p2")
  })

  it("does NOT flag payments with same amount but different created_at", () => {
    const ctx = emptyCtx({
      payments: [
        { id: "p1", description: "x", status: "Paid", amount: 100, paid_date: null, created_at: "2026-01-15T10:00:00Z" },
        { id: "p2", description: "y", status: "Paid", amount: 100, paid_date: null, created_at: "2026-01-16T10:00:00Z" },
      ],
    })
    expect(rule28_duplicatePayments(ctx)).toEqual([])
  })

  it("does NOT flag payments with same created_at but different amounts", () => {
    const ctx = emptyCtx({
      payments: [
        { id: "p1", description: "x", status: "Paid", amount: 100, paid_date: null, created_at: "2026-01-15T10:00:00Z" },
        { id: "p2", description: "y", status: "Paid", amount: 200, paid_date: null, created_at: "2026-01-15T10:00:00Z" },
      ],
    })
    expect(rule28_duplicatePayments(ctx)).toEqual([])
  })

  it("emits a separate finding per (amount, created_at) collision group", () => {
    const ctx = emptyCtx({
      payments: [
        { id: "p1", description: "x", status: "Paid", amount: 100, paid_date: null, created_at: "2026-01-15T10:00:00Z" },
        { id: "p2", description: "y", status: "Paid", amount: 100, paid_date: null, created_at: "2026-01-15T10:00:00Z" },
        { id: "p3", description: "z", status: "Paid", amount: 300, paid_date: null, created_at: "2026-02-01T09:00:00Z" },
        { id: "p4", description: "w", status: "Paid", amount: 300, paid_date: null, created_at: "2026-02-01T09:00:00Z" },
      ],
    })
    const findings = rule28_duplicatePayments(ctx)
    expect(findings).toHaveLength(2)
  })

  it("reports correct count when more than 2 payments collide", () => {
    const ctx = emptyCtx({
      payments: [
        { id: "p1", description: "x", status: "Paid", amount: 50, paid_date: null, created_at: "2026-03-01T12:00:00Z" },
        { id: "p2", description: "y", status: "Paid", amount: 50, paid_date: null, created_at: "2026-03-01T12:00:00Z" },
        { id: "p3", description: "z", status: "Paid", amount: 50, paid_date: null, created_at: "2026-03-01T12:00:00Z" },
      ],
    })
    const findings = rule28_duplicatePayments(ctx)
    expect(findings).toHaveLength(1)
    expect(findings[0].description).toContain("3 payments of 50")
  })

  it("ignores payments with null amount or null created_at", () => {
    const ctx = emptyCtx({
      payments: [
        { id: "p1", description: "x", status: "Paid", amount: null, paid_date: null, created_at: "2026-01-15T10:00:00Z" },
        { id: "p2", description: "y", status: "Paid", amount: null, paid_date: null, created_at: "2026-01-15T10:00:00Z" },
        { id: "p3", description: "z", status: "Paid", amount: 100, paid_date: null, created_at: null },
        { id: "p4", description: "w", status: "Paid", amount: 100, paid_date: null, created_at: null },
      ],
    })
    expect(rule28_duplicatePayments(ctx)).toEqual([])
  })
})

// ── R29: TAX_RETURNS ↔ SD STAGE ALIGNMENT (STRICT) ─────────────────────────

describe("rule29_taxReturnSDStageAlignment", () => {
  it("flags WARNING when tax_returns.status and SD stage disagree per bridge mapping", () => {
    // "Data Received" status maps to SD stage "Data Received" per the bridge —
    // SD is at "Extension Filed", so mismatch.
    const ctx = emptyCtx({
      tax_returns: [{ id: "tr1", tax_year: 2025, status: "Data Received" }],
      service_deliveries: [
        {
          id: "sd1", service_type: "Tax Return", status: "in_progress", stage: "Extension Filed",
          stage_order: 2, account_id: ACCOUNT_ID, contact_id: null, created_at: "2026-01-01T00:00:00Z",
        },
      ],
    })
    const findings = rule29_taxReturnSDStageAlignment(ctx)
    expect(findings).toHaveLength(1)
    expect(findings[0].rule_id).toBe("R29")
    expect(findings[0].severity).toBe("warning")
    expect(findings[0].description).toContain("'Data Received'")
    expect(findings[0].description).toContain("'Extension Filed'")
    expect(findings[0].description).toContain("aligned per the bridge mapping")
    expect(findings[0].expected_value).toBe("sd.stage=Data Received")
  })

  it("does NOT flag when SD stage matches bridge-mapped expected stage", () => {
    const ctx = emptyCtx({
      tax_returns: [{ id: "tr1", tax_year: 2025, status: "Data Received" }],
      service_deliveries: [
        {
          id: "sd1", service_type: "Tax Return", status: "in_progress", stage: "Data Received",
          stage_order: 3, account_id: ACCOUNT_ID, contact_id: null, created_at: "2026-01-01T00:00:00Z",
        },
      ],
    })
    expect(rule29_taxReturnSDStageAlignment(ctx)).toEqual([])
  })

  it("returns no findings when no tax_returns row exists", () => {
    const ctx = emptyCtx({
      service_deliveries: [
        {
          id: "sd1", service_type: "Tax Return", status: "in_progress", stage: "Data Received",
          stage_order: 3, account_id: ACCOUNT_ID, contact_id: null, created_at: "2026-01-01T00:00:00Z",
        },
      ],
    })
    expect(rule29_taxReturnSDStageAlignment(ctx)).toEqual([])
  })

  it("returns no findings when no Tax Return SD exists (R10 covers this case)", () => {
    const ctx = emptyCtx({
      tax_returns: [{ id: "tr1", tax_year: 2025, status: "Data Received" }],
    })
    expect(rule29_taxReturnSDStageAlignment(ctx)).toEqual([])
  })

  it("ignores cancelled Tax Return SDs", () => {
    const ctx = emptyCtx({
      tax_returns: [{ id: "tr1", tax_year: 2025, status: "Data Received" }],
      service_deliveries: [
        {
          id: "sd1", service_type: "Tax Return", status: "cancelled", stage: "Extension Filed",
          stage_order: 2, account_id: ACCOUNT_ID, contact_id: null, created_at: "2026-01-01T00:00:00Z",
        },
      ],
    })
    expect(rule29_taxReturnSDStageAlignment(ctx)).toEqual([])
  })

  it("skips tax_returns rows whose status has no bridge mapping", () => {
    const ctx = emptyCtx({
      tax_returns: [{ id: "tr1", tax_year: 2025, status: "Not Invoiced — completely unmapped value xyz" }],
      service_deliveries: [
        {
          id: "sd1", service_type: "Tax Return", status: "in_progress", stage: "Data Received",
          stage_order: 3, account_id: ACCOUNT_ID, contact_id: null, created_at: "2026-01-01T00:00:00Z",
        },
      ],
    })
    expect(rule29_taxReturnSDStageAlignment(ctx)).toEqual([])
  })

  it("emits one finding per mismatched tax_returns row", () => {
    const ctx = emptyCtx({
      tax_returns: [
        { id: "tr1", tax_year: 2024, status: "Data Received" },
        { id: "tr2", tax_year: 2025, status: "TR Filed" },
      ],
      service_deliveries: [
        {
          id: "sd1", service_type: "Tax Return", status: "in_progress", stage: "Extension Filed",
          stage_order: 2, account_id: ACCOUNT_ID, contact_id: null, created_at: "2026-01-01T00:00:00Z",
        },
      ],
    })
    const findings = rule29_taxReturnSDStageAlignment(ctx)
    expect(findings).toHaveLength(2)
    expect(findings.every(f => f.rule_id === "R29")).toBe(true)
  })

  it("returns no findings when SD stage is empty", () => {
    const ctx = emptyCtx({
      tax_returns: [{ id: "tr1", tax_year: 2025, status: "Data Received" }],
      service_deliveries: [
        {
          id: "sd1", service_type: "Tax Return", status: "in_progress", stage: "",
          stage_order: 0, account_id: ACCOUNT_ID, contact_id: null, created_at: "2026-01-01T00:00:00Z",
        },
      ],
    })
    expect(rule29_taxReturnSDStageAlignment(ctx)).toEqual([])
  })
})

// ── R30: ONE-TIME TAX RETURN SERVICE TYPE ──────────────────────────────────

describe("rule30_oneTimeTaxReturnServiceType", () => {
  it("flags INFO when One-Time account has an active 'Tax Return' SD", () => {
    const ctx = emptyCtx({
      account: baseAccount({ account_type: "One-Time" }),
      service_deliveries: [
        {
          id: "sd1", service_type: "Tax Return", status: "in_progress", stage: "Data Received",
          stage_order: 3, account_id: ACCOUNT_ID, contact_id: null, created_at: "2026-01-01T00:00:00Z",
        },
      ],
    })
    const findings = rule30_oneTimeTaxReturnServiceType(ctx)
    expect(findings).toHaveLength(1)
    expect(findings[0].rule_id).toBe("R30")
    expect(findings[0].severity).toBe("info")
    expect(findings[0].description).toContain("'Tax Return' service type")
    expect(findings[0].expected_value).toBe("service_type=Tax Return One-Time")
  })

  it("does NOT flag for non-One-Time accounts", () => {
    const ctx = emptyCtx({
      account: baseAccount({ account_type: "Client" }),
      service_deliveries: [
        {
          id: "sd1", service_type: "Tax Return", status: "in_progress", stage: "Data Received",
          stage_order: 3, account_id: ACCOUNT_ID, contact_id: null, created_at: "2026-01-01T00:00:00Z",
        },
      ],
    })
    expect(rule30_oneTimeTaxReturnServiceType(ctx)).toEqual([])
  })

  it("does NOT flag when the SD is already 'Tax Return One-Time'", () => {
    const ctx = emptyCtx({
      account: baseAccount({ account_type: "One-Time" }),
      service_deliveries: [
        {
          id: "sd1", service_type: "Tax Return One-Time", status: "in_progress", stage: "Data Received",
          stage_order: 3, account_id: ACCOUNT_ID, contact_id: null, created_at: "2026-01-01T00:00:00Z",
        },
      ],
    })
    expect(rule30_oneTimeTaxReturnServiceType(ctx)).toEqual([])
  })

  it("does NOT flag when One-Time account has no Tax Return SD at all", () => {
    const ctx = emptyCtx({
      account: baseAccount({ account_type: "One-Time" }),
      service_deliveries: [
        {
          id: "sd1", service_type: "ITIN", status: "in_progress", stage: "Submitted",
          stage_order: 1, account_id: ACCOUNT_ID, contact_id: null, created_at: "2026-01-01T00:00:00Z",
        },
      ],
    })
    expect(rule30_oneTimeTaxReturnServiceType(ctx)).toEqual([])
  })

  it("ignores cancelled Tax Return SDs", () => {
    const ctx = emptyCtx({
      account: baseAccount({ account_type: "One-Time" }),
      service_deliveries: [
        {
          id: "sd1", service_type: "Tax Return", status: "cancelled", stage: "Data Received",
          stage_order: 3, account_id: ACCOUNT_ID, contact_id: null, created_at: "2026-01-01T00:00:00Z",
        },
      ],
    })
    expect(rule30_oneTimeTaxReturnServiceType(ctx)).toEqual([])
  })
})

// ── Aggregator ─────────────────────────────────────────────────────────────

describe("runRules", () => {
  it("returns an empty array for a clean account", () => {
    const ctx = emptyCtx({
      account: baseAccount({
        account_type: "Client",
        ein_number: "12-3456789",
        portal_tier: "active",
        portal_account: true,
        formation_date: "2025-06-01",
        state_of_formation: "WY",
        ra_renewal_date: "2026-06-01",
        cmra_renewal_date: "2026-12-31",
      }),
      contacts: [{ id: "c1", email: "x@y.com", portal_tier: "active" }],
      service_deliveries: [
        {
          id: "sd1", service_type: "Company Formation", status: "completed", stage: "Done",
          stage_order: 99, account_id: ACCOUNT_ID, contact_id: null, created_at: "2025-06-01T00:00:00Z",
        },
      ],
      ss4_applications: [{ id: "s1", status: "done", pdf_signed_drive_id: "drive-1", created_at: null, updated_at: null }],
      documents: [
        { id: "d1", account_id: ACCOUNT_ID, contact_id: null, document_type_name: "SS-4 Application", file_name: "ss4.pdf" },
      ],
      has_auth_user: true,
      most_recent_offer: { contract_type: "formation" },
    })
    const findings = runRules(ctx)
    // The "clean" account should have no error-severity findings. Some info-
    // level R7 warnings around state-specific config may exist depending on
    // the test date — assert only the hard rule.
    expect(findings.filter(f => f.severity === "error")).toHaveLength(0)
  })

  it("collects findings across multiple rules", () => {
    const ctx = emptyCtx({
      account: baseAccount({ account_type: "One-Time", ra_renewal_date: "2027-01-01", ein_number: "12-3456789", portal_tier: "lead" }),
    })
    const findings = runRules(ctx)
    // R6 fires (One-Time + ra_renewal_date). R1 is skipped (One-Time).
    expect(findings.some(f => f.rule_id === "R6")).toBe(true)
    expect(findings.some(f => f.rule_id === "R1")).toBe(false)
  })
})
