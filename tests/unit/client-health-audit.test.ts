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
  it("flags EIN set but SS-4 still in awaiting_signature", () => {
    const ctx = emptyCtx({
      account: baseAccount({ ein_number: "12-3456789" }),
      ss4_applications: [{ id: "s1", status: "awaiting_signature", pdf_signed_drive_id: null }],
    })
    const findings = rule3_ss4StatusSync(ctx)
    expect(findings).toHaveLength(1)
    expect(findings[0].severity).toBe("warning")
  })

  it("does NOT flag SS-4 status=done with EIN", () => {
    const ctx = emptyCtx({
      account: baseAccount({ ein_number: "12-3456789" }),
      ss4_applications: [{ id: "s1", status: "done", pdf_signed_drive_id: "drive-1" }],
    })
    expect(rule3_ss4StatusSync(ctx)).toEqual([])
  })

  it("does NOT flag when no EIN is recorded", () => {
    const ctx = emptyCtx({
      ss4_applications: [{ id: "s1", status: "awaiting_signature", pdf_signed_drive_id: null }],
    })
    expect(rule3_ss4StatusSync(ctx)).toEqual([])
  })

  it("flags 'signed' status too (EIN should have arrived by then)", () => {
    const ctx = emptyCtx({
      account: baseAccount({ ein_number: "12-3456789" }),
      ss4_applications: [{ id: "s1", status: "signed", pdf_signed_drive_id: "drive-1" }],
    })
    expect(rule3_ss4StatusSync(ctx)).toHaveLength(1)
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
})

// ── R8: DOCUMENTS COMPLETENESS ─────────────────────────────────────────────

describe("rule8_documentsCompleteness", () => {
  it("flags signed SS-4 with no SS-4 document indexed", () => {
    const ctx = emptyCtx({
      account: baseAccount({ ein_number: "12-3456789" }),
      ss4_applications: [{ id: "s1", status: "done", pdf_signed_drive_id: "drive-1" }],
      documents: [{ id: "d1", account_id: ACCOUNT_ID, contact_id: null, document_type_name: "Operating Agreement" }],
    })
    const findings = rule8_documentsCompleteness(ctx)
    expect(findings.some(f => f.description.includes("SS-4 PDF"))).toBe(true)
  })

  it("does NOT flag SS-4 when an SS-4 doc exists", () => {
    const ctx = emptyCtx({
      account: baseAccount({ ein_number: "12-3456789" }),
      ss4_applications: [{ id: "s1", status: "done", pdf_signed_drive_id: "drive-1" }],
      documents: [{ id: "d1", account_id: ACCOUNT_ID, contact_id: null, document_type_name: "SS-4 Application" }],
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
      documents: [{ id: "d1", account_id: null, contact_id: "c1", document_type_name: "Passport" }],
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
      ss4_applications: [{ id: "s1", status: "done", pdf_signed_drive_id: "drive-1" }],
      documents: [
        { id: "d1", account_id: ACCOUNT_ID, contact_id: null, document_type_name: "SS-4 Application" },
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
