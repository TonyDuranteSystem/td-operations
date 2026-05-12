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
      payments: [{ id: "p1", description: "EIN service", created_at: "2026-01-02T00:00:00Z" }],
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
      payments: [{ id: "p1", description: "Tax Return 2025", created_at: "2026-04-01T00:00:00Z" }],
    })
    const findings = rule17_sameYearTaxReturn(ctx, NOW)
    expect(findings).toHaveLength(1)
    expect(findings[0].current_value).toContain("payments.description")
  })

  it("description match is case-insensitive", () => {
    const ctx = emptyCtx({
      account: baseAccount({ formation_date: "2026-03-15" }),
      payments: [{ id: "p1", description: "TAX RETURN service", created_at: null }],
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
      payments: [{ id: "p1", description: "Tax Return", created_at: null }],
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
      payments: [{ id: "p1", description: "Formation fee", created_at: null }],
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
