/**
 * Client Health Audit
 *
 * Pure-data audit over a single account, derived from rules learned while
 * reviewing real clients with Antonio (May 2026). Each rule is an
 * independent pure function from `HealthContext` to zero-or-more findings.
 *
 * The shape of a finding is intentionally narrow and machine-friendly so the
 * MCP tool, the CRM page, and future automations can consume the same output
 * without parsing prose.
 *
 * Separation of concerns:
 *   - `runRules(ctx)` is pure → unit-testable with fixtures.
 *   - `auditClientHealth(accountId)` fetches data, builds the context, runs
 *     the rules.
 *
 * Distinct from `app/api/crm/admin-actions/diagnose-account` (which is a
 * 7-category sweep with one-click fix actions). The health audit returns
 * findings only — fixes happen elsewhere.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import { findAuthUserByEmail } from "@/lib/auth-admin-helpers"
import { mapTaxReturnStatusToSDStage } from "@/lib/operations/tax-return-sd-bridge"

// ── Types ──────────────────────────────────────────────────────────────────

export type Severity = "error" | "warning" | "info"

export interface Finding {
  rule_id: string
  rule_title: string
  severity: Severity
  description: string
  current_value: string | null
  expected_value: string | null
}

export interface AuditResult {
  account_id: string
  company_name: string | null
  generated_at: string
  findings: Finding[]
  summary: { error: number; warning: number; info: number; total: number }
}

// Narrowed row shapes (only the fields each rule actually reads).
export interface AccountRow {
  id: string
  company_name: string | null
  account_type: string | null
  status: string | null
  entity_type: string | null
  ein_number: string | null
  formation_date: string | null
  state_of_formation: string | null
  portal_tier: string | null
  portal_account: boolean | null
  ra_renewal_date: string | null
  cmra_renewal_date: string | null
  annual_report_due_date: string | null
}

export interface ContactRow {
  id: string
  email: string | null
  portal_tier: string | null
}

export interface SDRow {
  id: string
  service_type: string
  status: string | null
  stage: string | null
  stage_order: number | null
  account_id: string | null
  contact_id: string | null
  created_at: string | null
}

export interface SS4Row {
  id: string
  status: string | null
  pdf_signed_drive_id: string | null
  created_at: string | null
  updated_at: string | null
}

export interface LeaseRow {
  id: string
  status: string | null
  signed_at: string | null
}

export interface LeadRow {
  id: string
  email: string | null
  status: string | null
  converted_to_contact_id: string | null
  converted_to_account_id: string | null
}

export interface DocumentRow {
  id: string
  account_id: string | null
  contact_id: string | null
  document_type_name: string | null
  file_name: string | null
}

export interface MemberRow {
  member_type: string
  full_name: string | null
  representative_name: string | null
  is_primary: boolean | null
  ownership_pct: number | null
  contact_id: string | null
}

export interface OARow {
  id: string
  total_signers: number | null
  status: string | null
}

export interface TaxReturnRow {
  id: string
  tax_year: number | null
  status: string | null
}

export interface OfferRow {
  contract_type: string | null
}

export interface PaymentRow {
  id: string
  description: string | null
  status: string | null
  amount: number | null
  paid_date: string | null
  created_at: string | null
}

export interface PartnerRow {
  id: string
  contact_id: string
  partner_name: string
  agreed_services: string[] | null
}

export interface HealthContext {
  account: AccountRow
  contacts: ContactRow[]
  service_deliveries: SDRow[]
  ss4_applications: SS4Row[]
  lease_agreements: LeaseRow[]
  documents: DocumentRow[]
  tax_returns: TaxReturnRow[]
  most_recent_offer: OfferRow | null
  /** Leads linked to any contact on this account by email match. */
  leads: LeadRow[]
  /** Members rows linked to this account (populated for MMLLCs). */
  members: MemberRow[]
  /** OA agreement rows linked to this account. */
  oa_agreements: OARow[]
  /** Payments linked to this account (any status). */
  payments: PaymentRow[]
  /** Partner registry rows linked to any contact on this account. */
  client_partners: PartnerRow[]
  /** True iff any offer on this account has contract_type='renewal'. */
  has_renewal_offer: boolean
  /** True iff at least one linked contact has an auth.users row. */
  has_auth_user: boolean
}

// ── State annual-report configuration ──────────────────────────────────────
//
// Derived from `lib/service-delivery.ts:457-461` (the existing canonical place
// where state filing rules live). Centralised here so Rule 7 stays data-
// driven rather than hardcoded inside the rule body. `null` means "no annual
// report requirement — do not flag a missing due date".

export interface AnnualReportPolicy {
  /** Fixed due-month/day each year ('MM-DD'). `null` = anniversary-of-formation. */
  fixed_mmdd: string | null
  /** If true, no annual report is filed for this state. */
  none: boolean
}

export const STATE_ANNUAL_REPORT_POLICY: Record<string, AnnualReportPolicy> = {
  FL: { fixed_mmdd: "05-01", none: false },
  DE: { fixed_mmdd: "06-01", none: false },
  WY: { fixed_mmdd: null, none: false }, // anniversary month
  NM: { fixed_mmdd: null, none: true },  // no annual report
}

// ── Helpers ────────────────────────────────────────────────────────────────

const ONE_TIME = "One-Time"

function isOneTime(a: AccountRow): boolean {
  return (a.account_type || "").trim() === ONE_TIME
}

function isClient(a: AccountRow): boolean {
  // "Client" is the canonical recurring type per lib/installment-handler.ts:53.
  return (a.account_type || "").trim() === "Client"
}

function daysBetween(a: string, b: string): number {
  const ms = Math.abs(new Date(a).getTime() - new Date(b).getTime())
  return Math.round(ms / (1000 * 60 * 60 * 24))
}

function addYears(iso: string, years: number): string {
  const d = new Date(iso)
  d.setUTCFullYear(d.getUTCFullYear() + years)
  return d.toISOString().slice(0, 10)
}

function currentYear(now: Date = new Date()): number {
  return now.getUTCFullYear()
}

// Onboarding threshold: when first payment is more than 6 months after the
// company's formation_date, the relationship started long after the company
// was formed. Used by Rules 7 and 25.
const ONBOARDING_GAP_DAYS = 182

function earliestPaymentMs(ctx: HealthContext): number | null {
  return ctx.payments
    .map(p => {
      const ts = p.paid_date || p.created_at
      return ts ? new Date(ts).getTime() : null
    })
    .filter((t): t is number => t !== null && Number.isFinite(t))
    .reduce<number | null>((min, t) => (min === null || t < min ? t : min), null)
}

/**
 * True when the client is an onboarding (not formation) relationship. Two
 * signals trigger it:
 *   - most-recent offer carries contract_type='onboarding'; OR
 *   - the R25 heuristic — first payment > 6 months after formation_date.
 */
function isOnboardingClient(ctx: HealthContext): boolean {
  const offerType = (ctx.most_recent_offer?.contract_type || "").toLowerCase()
  if (offerType === "onboarding") return true

  const a = ctx.account
  if (!a.formation_date) return false
  const formationMs = new Date(a.formation_date).getTime()
  if (!Number.isFinite(formationMs)) return false

  const firstPaymentMs = earliestPaymentMs(ctx)
  if (firstPaymentMs === null) return false

  const gapDays = (firstPaymentMs - formationMs) / (1000 * 60 * 60 * 24)
  return gapDays > ONBOARDING_GAP_DAYS
}

// ── Rule 1: TIER CONSISTENCY ───────────────────────────────────────────────

export function rule1_tierConsistency(ctx: HealthContext): Finding[] {
  const a = ctx.account
  // One-Time accounts are exempt per spec.
  if (isOneTime(a)) return []

  const findings: Finding[] = []
  const accountTier = (a.portal_tier || "").trim() || null

  // Account-level expectation.
  if (a.ein_number) {
    if (accountTier !== "active") {
      findings.push({
        rule_id: "R1",
        rule_title: "Tier consistency",
        severity: "error",
        description: "Account has an EIN but portal_tier is not 'active'.",
        current_value: `account.portal_tier=${accountTier ?? "null"}`,
        expected_value: "active",
      })
    }
  } else if (a.formation_date && (ctx.most_recent_offer?.contract_type === "formation" || ctx.most_recent_offer === null)) {
    // Formation in flight: tier should be 'formation' before EIN arrives.
    if (accountTier !== "formation" && accountTier !== "active") {
      findings.push({
        rule_id: "R1",
        rule_title: "Tier consistency",
        severity: "warning",
        description:
          "Account has a formation_date but no EIN yet — portal_tier should be 'formation' until EIN is recorded.",
        current_value: `account.portal_tier=${accountTier ?? "null"}`,
        expected_value: "formation",
      })
    }
  }

  // Contact-level expectation: tier should match or exceed account tier.
  // The ordering used elsewhere in the codebase is lead < formation < onboarding < active.
  const TIER_ORDER: Record<string, number> = { lead: 0, formation: 1, onboarding: 2, active: 3 }
  if (accountTier && TIER_ORDER[accountTier] !== undefined) {
    for (const c of ctx.contacts) {
      const ct = (c.portal_tier || "").trim() || null
      const accLevel = TIER_ORDER[accountTier]
      const ctLevel = ct && TIER_ORDER[ct] !== undefined ? TIER_ORDER[ct] : -1
      if (ctLevel < accLevel) {
        findings.push({
          rule_id: "R1",
          rule_title: "Tier consistency",
          severity: "warning",
          description: `Contact ${c.email ?? c.id} tier is below account tier.`,
          current_value: `contact.portal_tier=${ct ?? "null"}`,
          expected_value: `>= ${accountTier}`,
        })
      }
    }
  }

  return findings
}

// ── Rule 2: PORTAL ACCESS ──────────────────────────────────────────────────

export function rule2_portalAccess(ctx: HealthContext): Finding[] {
  const a = ctx.account
  // Only flag accounts where the portal was clearly intended:
  //   - portal_tier is set (any of lead/formation/onboarding/active), AND
  //   - at least one contact has an auth user.
  if (!a.portal_tier) return []
  if (!ctx.has_auth_user) return []
  if (a.portal_account === true) return []
  return [{
    rule_id: "R2",
    rule_title: "Portal access",
    severity: "warning",
    description:
      "Auth user exists and portal_tier is set, but accounts.portal_account is not true. Portal may be half-configured.",
    current_value: `portal_account=${a.portal_account ?? "null"}`,
    expected_value: "true",
  }]
}

// ── Rule 3: SS-4 STATUS SYNC ───────────────────────────────────────────────
//
// Valid SS4 statuses (lib/constants.ts:46): draft, awaiting_signature, signed,
// submitted, done, fax_failed.
// `lib/operations/ein-received.ts` does NOT touch ss4_applications — confirmed
// by grep returning zero matches. That means EIN-arrival never advances the
// SS-4 record automatically; this rule is the safety net.

export function rule3_ss4StatusSync(ctx: HealthContext, now: Date = new Date()): Finding[] {
  if (ctx.ss4_applications.length === 0) return []

  const a = ctx.account
  const findings: Finding[] = []

  for (const ss4 of ctx.ss4_applications) {
    const status = (ss4.status || "").trim().toLowerCase()
    if (!status) continue

    // 1. EIN exists but SS4 is not 'done'.
    if (a.ein_number && status !== "done") {
      findings.push({
        rule_id: "R3",
        rule_title: "SS-4 status sync",
        severity: "error",
        description:
          "EIN received but SS-4 not marked done — ein-received handler doesn't update SS-4 status.",
        current_value: `ss4.status=${status}`,
        expected_value: "done",
      })
    }

    // 2. Signed PDF exists but status is still 'awaiting_signature'.
    if (ss4.pdf_signed_drive_id && status === "awaiting_signature") {
      findings.push({
        rule_id: "R3",
        rule_title: "SS-4 status sync",
        severity: "warning",
        description: "SS-4 was signed (pdf_signed_drive_id present) but status not updated.",
        current_value: `ss4.status=${status}, pdf_signed_drive_id present`,
        expected_value: "signed | submitted | done",
      })
    }

    // 3. SS-4 stale: created > 21 days ago AND status unchanged since creation.
    if (ss4.created_at && ss4.updated_at) {
      const created = new Date(ss4.created_at).getTime()
      const updated = new Date(ss4.updated_at).getTime()
      const ageDays = (now.getTime() - created) / (1000 * 60 * 60 * 24)
      // Allow 1-second tolerance: timestamps can differ by ms even when status
      // hasn't changed.
      const unchanged = Math.abs(updated - created) < 1000
      if (ageDays > 21 && unchanged) {
        findings.push({
          rule_id: "R3",
          rule_title: "SS-4 status sync",
          severity: "warning",
          description: `SS-4 status unchanged for 3+ weeks (${Math.round(ageDays)} days) — may be stale.`,
          current_value: `ss4.status=${status}, age=${Math.round(ageDays)}d`,
          expected_value: "status progression",
        })
      }
    }
  }

  return findings
}

// ── Rule 4: CMRA SD ADVANCE AFTER LEASE SIGNED ─────────────────────────────

export function rule4_cmraAfterLease(ctx: HealthContext, now: Date = new Date()): Finding[] {
  const signedLease = ctx.lease_agreements.find(l => (l.status || "").toLowerCase() === "signed")
  if (!signedLease) return []

  // Year-1 formation exemption. LLC_MANAGEMENT_BUNDLE_TYPES (CMRA, RA Renewal,
  // Annual Report, Tax Return) are year 2+ services created at renewal. In
  // year 1, CMRA is managed as a DOCUMENT (lease agreement in Generate
  // Documents) — not as a separate SD. So if formation_date is in the current
  // year and no renewal offer has been issued, the absence/stagnation of a
  // CMRA SD is expected, not a defect.
  const a = ctx.account
  if (a.formation_date && !ctx.has_renewal_offer) {
    const formationYear = new Date(a.formation_date).getUTCFullYear()
    if (formationYear === now.getUTCFullYear()) {
      return [{
        rule_id: "R4",
        rule_title: "CMRA SD advance after lease",
        severity: "info",
        description: "Year-1 formation client — CMRA is managed as a document, not a service delivery.",
        current_value: `formation_date=${a.formation_date}, has_renewal_offer=false`,
        expected_value: "no CMRA SD expected until renewal",
      }]
    }
  }

  const cmraSD = ctx.service_deliveries.find(
    sd => sd.service_type === "CMRA Mailing Address" && (sd.status || "").toLowerCase() !== "cancelled",
  )
  if (!cmraSD) return []

  const stageName = (cmraSD.stage || "").trim().toLowerCase()
  if (stageName !== "lease created") return []

  // Root-cause note: was the lease signed before the SD existed?
  let timing = ""
  if (signedLease.signed_at && cmraSD.created_at) {
    if (new Date(signedLease.signed_at).getTime() < new Date(cmraSD.created_at).getTime()) {
      timing =
        " Lease was signed before the CMRA SD was created — SD likely landed in 'Lease Created' by default and was never advanced."
    }
  }

  return [{
    rule_id: "R4",
    rule_title: "CMRA SD advance after lease",
    severity: "warning",
    description: `Lease is signed but CMRA SD is still at stage 'Lease Created'.${timing}`,
    current_value: `cmra.stage=${cmraSD.stage}`,
    expected_value: "advance past 'Lease Created'",
  }]
}

// ── Rule 5: FORMATION SD CONTINUITY ────────────────────────────────────────

export function rule5_formationSDContinuity(ctx: HealthContext): Finding[] {
  const a = ctx.account
  if (!a.formation_date) return []
  if (isOneTime(a)) return []

  const formationSDs = ctx.service_deliveries.filter(sd => sd.service_type === "Company Formation")
  const liveOnAccount = formationSDs.find(
    sd => sd.account_id === a.id && (sd.status || "").toLowerCase() !== "cancelled",
  )
  if (liveOnAccount) return []

  const onlyCancelledContactOnly = formationSDs.length > 0 && formationSDs.every(
    sd => sd.account_id === null && (sd.status || "").toLowerCase() === "cancelled",
  )

  if (onlyCancelledContactOnly) {
    return [{
      rule_id: "R5",
      rule_title: "Formation SD continuity",
      severity: "error",
      description:
        "Formation SD was created on the contact and cancelled — no active or completed Formation SD on the account.",
      current_value: `formation_sds=${formationSDs.length} (all cancelled, contact-only)`,
      expected_value: "active or completed Formation SD linked to account",
    }]
  }

  return [{
    rule_id: "R5",
    rule_title: "Formation SD continuity",
    severity: "warning",
    description: "Account has a formation_date but no Formation SD is linked to the account.",
    current_value: `formation_sds_on_account=0`,
    expected_value: ">= 1 active or completed",
  }]
}

// ── Rule 6: ONE-TIME SCOPE ─────────────────────────────────────────────────

export function rule6_oneTimeScope(ctx: HealthContext): Finding[] {
  const a = ctx.account
  if (!isOneTime(a)) return []

  const findings: Finding[] = []
  if (a.ra_renewal_date) {
    findings.push({
      rule_id: "R6",
      rule_title: "One-Time scope",
      severity: "warning",
      description: "One-Time account has ra_renewal_date set — TD does not manage renewals for One-Time clients.",
      current_value: `ra_renewal_date=${a.ra_renewal_date}`,
      expected_value: "null",
    })
  }
  if (a.cmra_renewal_date) {
    findings.push({
      rule_id: "R6",
      rule_title: "One-Time scope",
      severity: "warning",
      description: "One-Time account has cmra_renewal_date set.",
      current_value: `cmra_renewal_date=${a.cmra_renewal_date}`,
      expected_value: "null",
    })
  }
  if (a.annual_report_due_date) {
    findings.push({
      rule_id: "R6",
      rule_title: "One-Time scope",
      severity: "warning",
      description: "One-Time account has annual_report_due_date set.",
      current_value: `annual_report_due_date=${a.annual_report_due_date}`,
      expected_value: "null",
    })
  }

  // Active SDs without a single payment record on a One-Time = bookkeeping
  // gap. One-Time work should always be paid up front, so the absence of any
  // payment row alongside live SDs suggests the invoice was never created.
  const activeSDs = ctx.service_deliveries.filter(sd => {
    const s = (sd.status || "").toLowerCase()
    return s !== "cancelled" && s !== "completed" && s !== "done"
  })
  if (activeSDs.length > 0 && ctx.payments.length === 0) {
    findings.push({
      rule_id: "R6",
      rule_title: "One-Time scope",
      severity: "info",
      description: "One-Time account has active services but no payment records.",
      current_value: `active_sds=${activeSDs.length}, payments=0`,
      expected_value: ">= 1 payment per active SD",
    })
  }

  return findings
}

// ── Rule 7: RENEWAL DATES ──────────────────────────────────────────────────

export function rule7_renewalDates(ctx: HealthContext, now: Date = new Date()): Finding[] {
  const a = ctx.account
  if (!a.formation_date) return []
  if (!isClient(a)) return [] // only applies to Client account_type
  const findings: Finding[] = []

  // RA renewal: for FORMATION clients we expect formation_date + 1 year
  // (±60 days). For ONBOARDING clients the RA renewal date reflects WHEN TD
  // took over as registered agent — it has no relationship to formation_date,
  // so do not compare it.
  const onboarding = isOnboardingClient(ctx)
  if (a.ra_renewal_date) {
    if (!onboarding) {
      if (a.ra_renewal_date === a.formation_date) {
        findings.push({
          rule_id: "R7",
          rule_title: "Renewal dates",
          severity: "error",
          description: "ra_renewal_date equals formation_date (known bug — never seeded forward).",
          current_value: `ra_renewal_date=${a.ra_renewal_date}`,
          expected_value: `formation_date + 1 year (≈ ${addYears(a.formation_date, 1)})`,
        })
      } else {
        const expected = addYears(a.formation_date, 1)
        const drift = daysBetween(a.ra_renewal_date, expected)
        if (drift > 60) {
          findings.push({
            rule_id: "R7",
            rule_title: "Renewal dates",
            severity: "warning",
            description: `ra_renewal_date is ${drift} days off from formation_date + 1 year (tolerance: ±60 days).`,
            current_value: `ra_renewal_date=${a.ra_renewal_date}`,
            expected_value: `≈ ${expected}`,
          })
        }
      }
    }
  } else if (onboarding) {
    findings.push({
      rule_id: "R7",
      rule_title: "Renewal dates",
      severity: "warning",
      description: "Onboarding client — RA renewal date should be set to the date we switched the registered agent.",
      current_value: "null",
      expected_value: "date we switched RA to our vendor",
    })
  } else {
    findings.push({
      rule_id: "R7",
      rule_title: "Renewal dates",
      severity: "warning",
      description: "Client account missing ra_renewal_date.",
      current_value: "null",
      expected_value: `≈ ${addYears(a.formation_date, 1)}`,
    })
  }

  // CMRA renewal: current year Dec 31.
  const cmraExpected = `${currentYear(now)}-12-31`
  if (a.cmra_renewal_date && a.cmra_renewal_date !== cmraExpected) {
    findings.push({
      rule_id: "R7",
      rule_title: "Renewal dates",
      severity: "info",
      description: "cmra_renewal_date is not set to the current-year Dec 31.",
      current_value: `cmra_renewal_date=${a.cmra_renewal_date}`,
      expected_value: cmraExpected,
    })
  }

  // Annual report due date — state-driven.
  if (a.state_of_formation) {
    const policy = STATE_ANNUAL_REPORT_POLICY[a.state_of_formation.toUpperCase()]
    if (policy) {
      if (policy.none) {
        if (a.annual_report_due_date) {
          findings.push({
            rule_id: "R7",
            rule_title: "Renewal dates",
            severity: "info",
            description: `State ${a.state_of_formation} has no annual report requirement — due date should be null.`,
            current_value: `annual_report_due_date=${a.annual_report_due_date}`,
            expected_value: "null",
          })
        }
      } else if (!a.annual_report_due_date) {
        findings.push({
          rule_id: "R7",
          rule_title: "Renewal dates",
          severity: "warning",
          description: `State ${a.state_of_formation} requires an annual report due date.`,
          current_value: "null",
          expected_value: policy.fixed_mmdd ? `next ${policy.fixed_mmdd}` : "anniversary of formation",
        })
      }
    } else {
      // Unknown state — codebase (lib/service-delivery.ts:457-461) only
      // hard-codes FL/DE/WY/NM. Surface an info finding so staff verify
      // annual-report handling manually for outliers.
      findings.push({
        rule_id: "R7",
        rule_title: "Renewal dates",
        severity: "info",
        description: `State ${a.state_of_formation} is not in the annual report policy table — manual verification needed.`,
        current_value: `state_of_formation=${a.state_of_formation}`,
        expected_value: "policy entry in STATE_ANNUAL_REPORT_POLICY",
      })
    }
  }

  return findings
}

// ── Rule 8: DOCUMENTS COMPLETENESS ─────────────────────────────────────────

export function rule8_documentsCompleteness(ctx: HealthContext): Finding[] {
  const a = ctx.account
  const findings: Finding[] = []

  const accountDocs = ctx.documents.filter(d => d.account_id === a.id)
  const contactIds = new Set(ctx.contacts.map(c => c.id))
  const contactDocs = ctx.documents.filter(d => d.contact_id && contactIds.has(d.contact_id))
  const totalDocs = accountDocs.length + contactDocs.length

  // SS-4 signed but no SS-4 document indexed.
  const signedSS4 = ctx.ss4_applications.find(s => s.pdf_signed_drive_id)
  if (signedSS4) {
    const hasSS4Doc = [...accountDocs, ...contactDocs].some(d => {
      const t = (d.document_type_name || "").toLowerCase()
      return t.includes("ss-4") || t.includes("ss4")
    })
    if (!hasSS4Doc) {
      findings.push({
        rule_id: "R8",
        rule_title: "Documents completeness",
        severity: "warning",
        description: "Signed SS-4 PDF exists in Drive but no SS-4 row found in documents table.",
        current_value: "documents.ss-4=0",
        expected_value: ">= 1 SS-4 document",
      })
    }
  }

  // Zero docs on an active EIN-bearing account is suspicious.
  if (a.ein_number && totalDocs === 0 && !isOneTime(a)) {
    findings.push({
      rule_id: "R8",
      rule_title: "Documents completeness",
      severity: "warning",
      description: "Active account with EIN has zero documents linked (by account_id or contact_id).",
      current_value: "documents=0",
      expected_value: ">= 1",
    })
  }

  return findings
}

// ── Rule 9: ONBOARDING VS FORMATION CONTEXT ────────────────────────────────

export function rule9_onboardingVsFormation(ctx: HealthContext): Finding[] {
  if (!ctx.most_recent_offer) {
    // Cannot decide from data alone — emit info so staff can resolve manually
    // for accounts where contract_type matters (those with EIN + no formation
    // process visible).
    if (ctx.account.ein_number && !ctx.account.formation_date) {
      return [{
        rule_id: "R9",
        rule_title: "Onboarding vs Formation context",
        severity: "info",
        description:
          "Account has an EIN but no formation_date and no offer record to infer whether this was formation or onboarding.",
        current_value: "offer=null",
        expected_value: "offer present with contract_type",
      }]
    }
    return []
  }

  const ct = (ctx.most_recent_offer.contract_type || "").toLowerCase()
  if (ct === "onboarding" && ctx.account.formation_date) {
    return [{
      rule_id: "R9",
      rule_title: "Onboarding vs Formation context",
      severity: "info",
      description:
        "Most-recent offer is contract_type=onboarding but the account has a formation_date. For onboarding clients EIN is pre-existing; do not apply formation-process expectations.",
      current_value: `offer.contract_type=onboarding, formation_date=${ctx.account.formation_date}`,
      expected_value: "formation_date may be informational only",
    }]
  }

  return []
}

// ── Rule 10: TAX RETURN DUAL TRACKING ──────────────────────────────────────

export function rule10_taxReturnDualTracking(ctx: HealthContext): Finding[] {
  if (ctx.tax_returns.length === 0) return []

  const taxReturnSD = ctx.service_deliveries.find(sd => sd.service_type === "Tax Return")
  if (!taxReturnSD) {
    return [{
      rule_id: "R10",
      rule_title: "Tax Return dual tracking",
      severity: "warning",
      description:
        "Tax return record exists but no Tax Return SD found. The two track different things — the SD covers payment lifecycle and should exist alongside the tax_returns row.",
      current_value: "service_deliveries.tax_return=0",
      expected_value: ">= 1 Tax Return SD",
    }]
  }

  // Both rows exist — compare SD stage to the stage mapped from TR status via
  // the Phase 3 bridge. Differences are info, not errors: the two systems
  // track different aspects (SD = payment lifecycle, tax_returns = filing
  // status) and the bridge keeps them aligned going forward.
  const findings: Finding[] = []
  const currentStage = (taxReturnSD.stage || "").trim()

  for (const tr of ctx.tax_returns) {
    const mapped = mapTaxReturnStatusToSDStage(tr.status)
    if (!mapped) continue

    if (currentStage === mapped.stage_name) {
      findings.push({
        rule_id: "R10",
        rule_title: "Tax Return dual tracking",
        severity: "info",
        description: "Tax Return SD and tax_returns are in sync.",
        current_value: `sd.stage=${currentStage}, tax_returns.status=${tr.status}`,
        expected_value: `synced (${mapped.stage_name})`,
      })
    } else {
      findings.push({
        rule_id: "R10",
        rule_title: "Tax Return dual tracking",
        severity: "info",
        description:
          `Tax Return SD at '${currentStage}' while tax_returns at '${tr.status}'. Note: these track different aspects (SD = payment lifecycle, tax_returns = filing status). Phase 3 bridge syncs going forward.`,
        current_value: `sd.stage=${currentStage}, tax_returns.status=${tr.status}`,
        expected_value: `sd.stage=${mapped.stage_name}`,
      })
    }
  }

  return findings
}

// ── Rule 11: OFFER TYPE CONSISTENCY ────────────────────────────────────────
//
// Per `app/api/workflows/activate-service/route.ts`, valid initial contract
// types are `formation` and `onboarding`; `renewal` is for year-2+ clients and
// is refused by activate-service (handled by agreement-signed instead). A
// renewal offer on a recently formed company is therefore suspect — either
// the wrong contract_type was selected or the formation_date is wrong.

export function rule11_offerTypeConsistency(ctx: HealthContext, now: Date = new Date()): Finding[] {
  const a = ctx.account
  if (!a.formation_date) return []
  if (!ctx.most_recent_offer) return []
  if ((ctx.most_recent_offer.contract_type || "").toLowerCase() !== "renewal") return []

  // "Recently formed" = within the last 12 months.
  const formedMs = new Date(a.formation_date).getTime()
  const ageDays = (now.getTime() - formedMs) / (1000 * 60 * 60 * 24)
  if (ageDays > 365) return []

  return [{
    rule_id: "R11",
    rule_title: "Offer type consistency",
    severity: "warning",
    description: "Renewal offer on a recently formed company — verify this is correct.",
    current_value: `most_recent_offer.contract_type=renewal, formation_date=${a.formation_date}`,
    expected_value: "formation | onboarding for new companies",
  }]
}

// ── Rule 12: LEAD LINKAGE ──────────────────────────────────────────────────
//
// `app/api/webhooks/offer-signed/route.ts:214` sets `leads.converted_to_contact_id`
// at offer-sign time. `lib/portal/auto-create.ts:494-497` sets
// `leads.converted_to_account_id` when the account is created via the wizard.
// A lead with status='Converted' that's missing either pointer means a step
// in the conversion chain didn't fire — worth surfacing.

export function rule12_leadLinkage(ctx: HealthContext): Finding[] {
  const findings: Finding[] = []

  for (const lead of ctx.leads) {
    if ((lead.status || "").trim() !== "Converted") continue

    if (!lead.converted_to_contact_id) {
      findings.push({
        rule_id: "R12",
        rule_title: "Lead linkage",
        severity: "warning",
        description: `Lead ${lead.email ?? lead.id} is 'Converted' but converted_to_contact_id is not set (offer-signed should have linked it).`,
        current_value: "converted_to_contact_id=null",
        expected_value: "contact_id linked at offer-sign",
      })
    }

    // Per spec: only flag converted_to_account_id=null when an account exists.
    // The audited account exists by definition (audit is per-account), so flag
    // the lead if the pointer is null. auto-create.ts sets this when the
    // wizard creates the account; null means the wizard step didn't run.
    if (!lead.converted_to_account_id) {
      findings.push({
        rule_id: "R12",
        rule_title: "Lead linkage",
        severity: "warning",
        description: `Lead ${lead.email ?? lead.id} is 'Converted' and account ${ctx.account.id} exists, but converted_to_account_id is not set.`,
        current_value: "converted_to_account_id=null",
        expected_value: ctx.account.id,
      })
    }
  }

  return findings
}

// ── Rule 13: DBA TRACKING ──────────────────────────────────────────────────
//
// Learned from reviewing Everboost and Fiscalot: clients sometimes operate
// under a DBA (Doing Business As) / Trade Name / Fictitious Name, but the
// system has no first-class column for it. The signal we DO have is a
// document filed under that label. Surfacing the document tells staff to
// capture the DBA structurally somewhere.

const DBA_KEYWORDS = ["dba", "trade name", "fictitious name"]

function matchesDBA(value: string | null): boolean {
  if (!value) return false
  const v = value.toLowerCase()
  return DBA_KEYWORDS.some(k => v.includes(k))
}

export function rule13_dbaTracking(ctx: HealthContext): Finding[] {
  const a = ctx.account
  const accountDocs = ctx.documents.filter(d => d.account_id === a.id)
  const contactIds = new Set(ctx.contacts.map(c => c.id))
  const contactDocs = ctx.documents.filter(d => d.contact_id && contactIds.has(d.contact_id))
  const allDocs = [...accountDocs, ...contactDocs]

  const dbaDoc = allDocs.find(d => matchesDBA(d.document_type_name) || matchesDBA(d.file_name))
  if (!dbaDoc) return []

  const label = dbaDoc.document_type_name || dbaDoc.file_name || "unknown"
  return [{
    rule_id: "R13",
    rule_title: "DBA tracking",
    severity: "info",
    description: "DBA document found but no DBA tracking in the system.",
    current_value: `document=${label}`,
    expected_value: "first-class DBA field on account",
  }]
}

// ── Rule 14: MMLLC MEMBER COMPLETENESS ─────────────────────────────────────
//
// Learned from reviewing B&P International and Azarexa: MMLLCs require
// structured member rows for OA generation, signature collection, and
// downstream filings. If the `members` table for the account is incomplete,
// the member-info form should be sent so the client fills the gaps. The rule
// only fires when `entity_type` indicates a multi-member entity.

function isMultiMember(a: AccountRow): boolean {
  return (a.entity_type || "").toLowerCase().includes("multi member")
}

export function rule14_mmllcMemberCompleteness(ctx: HealthContext): Finding[] {
  if (!isMultiMember(ctx.account)) return []
  const findings: Finding[] = []
  const members = ctx.members

  if (members.length < 2) {
    findings.push({
      rule_id: "R14",
      rule_title: "MMLLC member completeness",
      severity: "warning",
      description: "MMLLC member info incomplete — member info form should be sent (fewer than 2 members on file).",
      current_value: `members=${members.length}`,
      expected_value: ">= 2",
    })
  }

  if (members.length > 0 && !members.some(m => m.is_primary === true)) {
    findings.push({
      rule_id: "R14",
      rule_title: "MMLLC member completeness",
      severity: "warning",
      description: "MMLLC member info incomplete — no primary member flagged (is_primary=true).",
      current_value: "is_primary=true count=0",
      expected_value: ">= 1 primary member",
    })
  }

  for (const m of members) {
    if (m.member_type === "company" && !m.representative_name) {
      findings.push({
        rule_id: "R14",
        rule_title: "MMLLC member completeness",
        severity: "warning",
        description: `MMLLC member info incomplete — company-type member (${m.full_name ?? "unnamed"}) missing representative_name.`,
        current_value: "representative_name=null",
        expected_value: "non-null representative_name",
      })
    }
  }

  for (const m of members) {
    if (!m.contact_id) {
      findings.push({
        rule_id: "R14",
        rule_title: "MMLLC member completeness",
        severity: "warning",
        description: `MMLLC member info incomplete — member (${m.full_name ?? "unnamed"}) not linked to a contact (contact_id=null).`,
        current_value: "contact_id=null",
        expected_value: "linked contact row",
      })
    }
  }

  return findings
}

// ── Rule 15: OA SIGNER COUNT ───────────────────────────────────────────────
//
// Learned from reviewing B&P International and Azarexa: when an MMLLC has an
// OA on file, the OA's `total_signers` should match the number of members in
// the `members` table. A mismatch usually means the OA was generated before
// all members were captured, so it needs to be regenerated to collect all
// required signatures.

export function rule15_oaSignerCount(ctx: HealthContext): Finding[] {
  if (!isMultiMember(ctx.account)) return []
  if (ctx.oa_agreements.length === 0) return []

  const memberCount = ctx.members.length
  if (memberCount === 0) return [] // R14 already covers "no members on MMLLC"

  const findings: Finding[] = []
  for (const oa of ctx.oa_agreements) {
    if (oa.total_signers == null) continue
    if (oa.total_signers < memberCount) {
      findings.push({
        rule_id: "R15",
        rule_title: "OA signer count",
        severity: "warning",
        description: "OA total_signers doesn't match member count — OA may need to be regenerated.",
        current_value: `oa.total_signers=${oa.total_signers}, members=${memberCount}`,
        expected_value: `total_signers >= ${memberCount}`,
      })
    }
  }
  return findings
}

// ── Rule 16: CANCELLED/CLOSED PORTAL ACCESS ────────────────────────────────
//
// Learned from reviewing Amtor LLC: when an account has been cancelled or
// closed, portal access should be revoked. Leaving `portal_tier` set on a
// closed account means the former client could still log in and see data —
// a security issue. Statuses that should trigger revocation: Cancelled,
// Closed, Suspended, Offboarding (plus "Inactive" defensively, even though
// it is not currently in the `account_status` enum).

const CLOSED_STATUSES = new Set(["Cancelled", "Closed", "Inactive", "Suspended", "Offboarding"])

export function rule16_closedAccountPortalAccess(ctx: HealthContext): Finding[] {
  const a = ctx.account
  if (!a.status || !CLOSED_STATUSES.has(a.status)) return []
  const tier = (a.portal_tier || "").trim()
  if (!tier) return []
  return [{
    rule_id: "R16",
    rule_title: "Closed account portal access",
    severity: "error",
    description: "Cancelled/closed account still has portal access — security issue.",
    current_value: `status=${a.status}, portal_tier=${tier}`,
    expected_value: "portal_tier=null",
  }]
}

// ── Rule 17: SAME-YEAR TAX RETURN ──────────────────────────────────────────
//
// Learned from reviewing clients 13-16: when an account is formed in year N,
// the first tax return covers tax year N and is filed in year N+1. There
// should be NO tax return record (tax_returns row, Tax Return SD, or Tax
// Return payment) dated within year N for that company. Catching this early
// stops staff from creating wrong invoices for newly-formed entities.

export function rule17_sameYearTaxReturn(ctx: HealthContext, now: Date = new Date()): Finding[] {
  const a = ctx.account
  if (!a.formation_date) return []

  const formationYear = new Date(a.formation_date).getUTCFullYear()
  const thisYear = now.getUTCFullYear()
  if (formationYear !== thisYear) return []

  const trCurrentYear = ctx.tax_returns.find(tr => tr.tax_year === thisYear)
  const trSD = ctx.service_deliveries.find(
    sd => sd.service_type === "Tax Return" && (sd.status || "").toLowerCase() !== "cancelled",
  )
  const trPayment = ctx.payments.find(p => (p.description || "").toLowerCase().includes("tax return"))

  const triggers: string[] = []
  if (trCurrentYear) triggers.push(`tax_returns.tax_year=${thisYear}`)
  if (trSD) triggers.push(`service_deliveries.service_type='Tax Return'`)
  if (trPayment) triggers.push(`payments.description~'Tax Return'`)
  if (triggers.length === 0) return []

  return [{
    rule_id: "R17",
    rule_title: "Same-year tax return on new formation",
    severity: "error",
    description: `Company formed in ${formationYear} cannot have a tax return in the same year. First tax return is for tax year ${formationYear}, filed in ${formationYear + 1}.`,
    current_value: triggers.join("; "),
    expected_value: `no tax return artifacts in ${formationYear}`,
  }]
}

// ── Rule 18: PARTNER CLIENT SERVICE SCOPE ──────────────────────────────────
//
// Learned from reviewing clients 13-16 (e.g., Atlas Compliance under the
// Maxscale partner — CMRA only): when a contact has a `client_partners` row,
// the partner's `agreed_services` list scopes what TD manages for that
// client. A One-Time partner client should NOT have renewal dates seeded for
// services outside that scope.
//
// Renewal-date column → service slug mapping:
//   ra_renewal_date         → 'state_ra_renewal' (legacy alias 'ra_renewal')
//   cmra_renewal_date       → 'cmra'
//   annual_report_due_date  → 'state_annual_report' (legacy alias 'annual_report')

const RENEWAL_COLUMN_TO_SLUGS: Array<{ column: keyof AccountRow; slugs: string[]; label: string }> = [
  { column: "ra_renewal_date", slugs: ["state_ra_renewal", "ra_renewal"], label: "RA renewal" },
  { column: "cmra_renewal_date", slugs: ["cmra"], label: "CMRA" },
  { column: "annual_report_due_date", slugs: ["state_annual_report", "annual_report"], label: "annual report" },
]

export function rule18_partnerServiceScope(ctx: HealthContext): Finding[] {
  if (!isOneTime(ctx.account)) return []
  if (ctx.client_partners.length === 0) return []

  // Union of every agreed service across all partner rows linked to this
  // account's contacts.
  const agreed = new Set<string>()
  for (const p of ctx.client_partners) {
    for (const s of p.agreed_services ?? []) agreed.add(s)
  }

  const offending: string[] = []
  for (const { column, slugs, label } of RENEWAL_COLUMN_TO_SLUGS) {
    const value = ctx.account[column]
    if (!value) continue
    const inScope = slugs.some(s => agreed.has(s))
    if (!inScope) offending.push(`${label} (${column}=${value})`)
  }

  if (offending.length === 0) return []

  const partnerNames = ctx.client_partners.map(p => p.partner_name).join(", ")
  return [{
    rule_id: "R18",
    rule_title: "Partner client service scope",
    severity: "warning",
    description: "One-Time partner client has renewal dates for services not in the partner agreement.",
    current_value: `partner=${partnerNames}; out_of_scope=${offending.join(", ")}; agreed_services=[${Array.from(agreed).join(",")}]`,
    expected_value: "renewal dates only for services in agreed_services (or null)",
  }]
}

// ── Rule 19: LEGACY / STALE STATUSES ───────────────────────────────────────
//
// Two checks for stale state imported from older systems or stuck records:
//
// 1. tax_returns.status carrying legacy Airtable-imported values
//    ("Activated - Need Link", "Not Invoiced") that don't match the current
//    workflow — flag as warning so staff can manually re-map.
// 2. Any payment in 'Pending' status for more than 30 days — usually means
//    the payment was either fulfilled (and never marked Paid) or abandoned
//    (and never marked Cancelled). Surfacing as info nudges cleanup without
//    blocking on a single threshold.

const LEGACY_TAX_RETURN_STATUSES = new Set(["Activated - Need Link", "Not Invoiced"])

export function rule19_legacyStatuses(ctx: HealthContext, now: Date = new Date()): Finding[] {
  const findings: Finding[] = []

  for (const tr of ctx.tax_returns) {
    const status = (tr.status || "").trim()
    if (!status) continue
    if (LEGACY_TAX_RETURN_STATUSES.has(status)) {
      findings.push({
        rule_id: "R19",
        rule_title: "Legacy / stale statuses",
        severity: "warning",
        description: `Tax return has legacy status '${status}' — imported from old system, needs manual review.`,
        current_value: `tax_returns.status=${status}`,
        expected_value: "current-workflow status",
      })
    }
  }

  for (const p of ctx.payments) {
    const status = (p.status || "").trim()
    if (status !== "Pending") continue
    if (!p.created_at) continue
    const ageDays = Math.floor((now.getTime() - new Date(p.created_at).getTime()) / (1000 * 60 * 60 * 24))
    if (ageDays <= 30) continue
    const label = p.description || p.id
    findings.push({
      rule_id: "R19",
      rule_title: "Legacy / stale statuses",
      severity: "info",
      description: `Payment '${label}' has been Pending for ${ageDays} days — may need to be marked as Paid or Cancelled.`,
      current_value: `payments.status=Pending, age=${ageDays}d`,
      expected_value: "Paid | Cancelled",
    })
  }

  return findings
}

// ── Rule 20: ENTITY TYPE VALIDATION ────────────────────────────────────────
//
// Current entity_type enum: Single Member LLC, Multi Member LLC, C-Corp
// Elected. An active account without entity_type set means downstream code
// (OA generation, MMLLC member rules, formation pipelines) can't branch
// correctly. C-Corp single/multi-member expansion is on the roadmap but not
// yet in the enum — do NOT flag 'C-Corp Elected' as wrong.

export function rule20_entityTypeValidation(ctx: HealthContext): Finding[] {
  const a = ctx.account
  if ((a.status || "").trim() !== "Active") return []
  if (a.entity_type && a.entity_type.trim() !== "") return []
  return [{
    rule_id: "R20",
    rule_title: "Entity type validation",
    severity: "warning",
    description: "Entity type not set.",
    current_value: `entity_type=${a.entity_type ?? "null"}`,
    expected_value: "Single Member LLC | Multi Member LLC | C-Corp Elected",
  }]
}

// ── Rule 21: ZERO-AMOUNT / SAME-YEAR INSTALLMENT PAYMENTS ──────────────────
//
// Two checks on the payments table:
//
// 1. Same-year installment (ERROR). If the client's first payment is in the
//    current year AND they have an installment-line payment dated this year
//    with amount = 0, that's the wrong invoice — the setup fee covers year 1;
//    installments start NEXT year. The zero-amount line is the symptom of the
//    misfire: the installment schedule was seeded for the formation year by
//    mistake.
// 2. Generic $0 payment (WARNING). Any Paid payment with amount = 0 is
//    suspicious — usually a data entry slip. Skipped when the same payment
//    already triggered (1) so we don't double-flag.
//
// "First payment date" uses paid_date when present, falling back to created_at
// — installments seeded but never paid don't have a paid_date and should not
// suppress the same-year heuristic on the real first payment.

function paymentYear(p: PaymentRow): number | null {
  const ts = p.paid_date || p.created_at
  if (!ts) return null
  const y = new Date(ts).getUTCFullYear()
  return Number.isFinite(y) ? y : null
}

export function rule21_zeroAmountInstallment(ctx: HealthContext, now: Date = new Date()): Finding[] {
  if (ctx.payments.length === 0) return []
  const thisYear = now.getUTCFullYear()

  // Earliest payment year across all rows (paid or not).
  const years = ctx.payments
    .map(p => paymentYear(p))
    .filter((y): y is number => y !== null)
  if (years.length === 0) return []
  const firstYear = Math.min(...years)

  const findings: Finding[] = []
  const sameYearInstallmentIds = new Set<string>()

  if (firstYear === thisYear) {
    for (const p of ctx.payments) {
      if (p.amount !== 0) continue
      const desc = (p.description || "").toLowerCase()
      if (!desc.includes("installment")) continue
      const py = paymentYear(p)
      if (py !== thisYear) continue
      sameYearInstallmentIds.add(p.id)
      findings.push({
        rule_id: "R21",
        rule_title: "Zero-amount / same-year installment",
        severity: "error",
        description:
          `Zero-amount installment for same year as onboarding — client's setup fee covers this year. Installments start next year.`,
        current_value: `payment.id=${p.id}, amount=0, description="${p.description ?? ""}", year=${thisYear}`,
        expected_value: `installments dated ${thisYear + 1} or later`,
      })
    }
  }

  for (const p of ctx.payments) {
    if (p.amount !== 0) continue
    if ((p.status || "").trim() !== "Paid") continue
    if (sameYearInstallmentIds.has(p.id)) continue
    findings.push({
      rule_id: "R21",
      rule_title: "Zero-amount / same-year installment",
      severity: "warning",
      description: "$0 payment exists — verify this is intentional.",
      current_value: `payment.id=${p.id}, status=Paid, amount=0, description="${p.description ?? ""}"`,
      expected_value: "amount > 0 or status != 'Paid'",
    })
  }

  return findings
}

// ── Rule 22: ONE-TIME TIER VALIDATION ──────────────────────────────────────
//
// One-Time clients buy standalone services (ITIN, EIN, etc.). They should
// have portal_tier = 'lead' (before pay) or 'active' (after delivery). The
// 'formation' and 'onboarding' tiers are reserved for annual-management
// clients going through company setup — never appropriate for One-Time.

export function rule22_oneTimeTier(ctx: HealthContext): Finding[] {
  const a = ctx.account
  if (!isOneTime(a)) return []
  const tier = (a.portal_tier || "").trim()
  if (tier !== "formation" && tier !== "onboarding") return []
  return [{
    rule_id: "R22",
    rule_title: "One-Time tier validation",
    severity: "warning",
    description: `One-Time client has tier '${tier}' — One-Time clients should not be in formation/onboarding tier.`,
    current_value: `account_type=One-Time, portal_tier=${tier}`,
    expected_value: "active | lead",
  }]
}

// ── Rule 23: MISSING tax_returns RECORD WHEN TAX RETURN SD EXISTS ──────────
//
// Inverse of Rule 10. R10 fires when there's a tax_returns row but no Tax
// Return SD. R23 fires when there's an active Tax Return SD but no row in
// tax_returns — the SD covers the payment lifecycle, but filing tracking
// needs the tax_returns row. Cancelled SDs are excluded.

export function rule23_missingTaxReturnRow(ctx: HealthContext): Finding[] {
  const trSD = ctx.service_deliveries.find(
    sd => sd.service_type === "Tax Return" && (sd.status || "").toLowerCase() !== "cancelled",
  )
  if (!trSD) return []
  if (ctx.tax_returns.length > 0) return []
  return [{
    rule_id: "R23",
    rule_title: "Tax Return SD without tax_returns row",
    severity: "warning",
    description: "Tax Return service delivery exists but no tax_returns tracking record.",
    current_value: `tax_return_sd=${trSD.id}, tax_returns=0`,
    expected_value: ">= 1 tax_returns row",
  }]
}

// ── Rule 24: INCOMPLETE COMPANY DETAILS ────────────────────────────────────
//
// Active recurring clients should have both state_of_formation and
// formation_date on file — these are needed for annual report scheduling,
// renewal-date math, and document generation. Missing either suggests the
// onboarding intake form was never run, or the company was migrated without
// full details. One-Time accounts skip this — they may not need full company
// details for the work TD performs.

export function rule24_incompleteCompanyDetails(ctx: HealthContext): Finding[] {
  const a = ctx.account
  if ((a.status || "").trim() !== "Active") return []
  if (!isClient(a)) return []
  const missing: string[] = []
  if (!a.state_of_formation) missing.push("state_of_formation")
  if (!a.formation_date) missing.push("formation_date")
  if (missing.length === 0) return []
  return [{
    rule_id: "R24",
    rule_title: "Incomplete company details",
    severity: "info",
    description: `Company details incomplete — missing ${missing.join(", ")}. Check if this is an onboarding client whose details weren't collected.`,
    current_value: `state_of_formation=${a.state_of_formation ?? "null"}, formation_date=${a.formation_date ?? "null"}`,
    expected_value: "both fields populated",
  }]
}

// ── Rule 25: ONBOARDING DETECTION (FORMATION-VS-ONBOARDING GAP) ────────────
//
// Learned from MFCompany: when a company was formed long before TD started
// managing it, the formation_date column reflects a historical event, not
// when TD's relationship began. If the first payment is more than 6 months
// after formation, this is almost certainly an onboarding client (not a
// formation client) — and the absence of a separate client_since-style date
// hides that fact. Info-severity nudge so staff can capture the relationship
// start date explicitly.

export function rule25_onboardingDetection(ctx: HealthContext): Finding[] {
  const a = ctx.account
  if (!a.formation_date) return []
  if (ctx.payments.length === 0) return []

  const formationMs = new Date(a.formation_date).getTime()
  if (!Number.isFinite(formationMs)) return []

  const firstPaymentMs = earliestPaymentMs(ctx)
  if (firstPaymentMs === null) return []

  const gapDays = (firstPaymentMs - formationMs) / (1000 * 60 * 60 * 24)
  if (gapDays <= ONBOARDING_GAP_DAYS) return []

  const firstPaymentISO = new Date(firstPaymentMs).toISOString().slice(0, 10)
  return [{
    rule_id: "R25",
    rule_title: "Onboarding detection",
    severity: "info",
    description: `Company formed ${a.formation_date} but first payment ${firstPaymentISO} — likely an onboarding client, not a formation. Consider adding client_since date.`,
    current_value: `formation_date=${a.formation_date}, first_payment=${firstPaymentISO}, gap=${Math.round(gapDays)}d`,
    expected_value: "first payment within 6 months of formation (or capture client_since)",
  }]
}

// ── Rule 26: TAX RETURN SD STAGE VS PAYMENT CONTEXT ────────────────────────
//
// The Tax Return SD pipeline starts at stage "1st Installment Paid" — the
// stage name asserts a billing fact (an installment was received). When the
// account's payments contain no row whose description matches "installment"
// (case-insensitive), the SD's stage is lying: most likely the client paid
// a setup/onboarding fee that bumped the SD to this stage by accident, or
// the SD was advanced manually without a matching payment row. Either way,
// downstream automations that key off the SD stage (renewal billing,
// installment scheduling, year-end reconciliation) will misfire. Warning
// severity — the data is internally inconsistent but the client experience
// is not broken yet.

export function rule26_taxReturnStageVsPayments(ctx: HealthContext): Finding[] {
  const trSD = ctx.service_deliveries.find(
    sd =>
      sd.service_type === "Tax Return" &&
      (sd.status || "").toLowerCase() !== "cancelled" &&
      (sd.stage || "").trim() === "1st Installment Paid",
  )
  if (!trSD) return []

  const hasInstallmentPayment = ctx.payments.some(p =>
    (p.description || "").toLowerCase().includes("installment"),
  )
  if (hasInstallmentPayment) return []

  return [{
    rule_id: "R26",
    rule_title: "Tax Return SD stage vs payment context",
    severity: "warning",
    description:
      "Tax Return SD at '1st Installment Paid' but no installment payment found — client may have paid a setup/onboarding fee instead. SD stage name doesn't match payment reality.",
    current_value: `tax_return_sd=${trSD.id}, stage="1st Installment Paid", installment_payments=0`,
    expected_value: ">= 1 payment with description matching /installment/i",
  }]
}

// ── Rule 27: TAX RETURN YEAR VALIDATION ────────────────────────────────────
//
// Two checks on tax_returns.tax_year:
//
// 1. Future year — tax_year must be <= current year. A return for a year that
//    hasn't ended is almost always a data-entry slip (typo, dropdown miswire).
// 2. First return misaligned with formation year — if the company was formed
//    in year X, the first tax return covers year X (filed in X+1). When the
//    only tax_returns row is for a year AFTER the formation year, it almost
//    always means the prior-year filing was skipped or the row was created
//    against the wrong year. Only fires when there's exactly ONE tax_returns
//    row — multiple rows imply a deliberate filing history.

export function rule27_taxReturnYearValidation(ctx: HealthContext, now: Date = new Date()): Finding[] {
  if (ctx.tax_returns.length === 0) return []

  const findings: Finding[] = []
  const thisYear = now.getUTCFullYear()

  for (const tr of ctx.tax_returns) {
    if (tr.tax_year === null) continue
    if (tr.tax_year > thisYear) {
      findings.push({
        rule_id: "R27",
        rule_title: "Tax return year validation",
        severity: "warning",
        description: `Tax return year ${tr.tax_year} is in the future (current year: ${thisYear}).`,
        current_value: `tax_returns.tax_year=${tr.tax_year}`,
        expected_value: `<= ${thisYear}`,
      })
    }
  }

  const a = ctx.account
  if (a.formation_date && ctx.tax_returns.length === 1) {
    const formationYear = new Date(a.formation_date).getUTCFullYear()
    const tr = ctx.tax_returns[0]
    if (Number.isFinite(formationYear) && tr.tax_year !== null && tr.tax_year > formationYear) {
      findings.push({
        rule_id: "R27",
        rule_title: "Tax return year validation",
        severity: "warning",
        description: `Tax return year ${tr.tax_year} but company formed in ${formationYear} — first tax return should be for year ${formationYear}.`,
        current_value: `tax_returns.tax_year=${tr.tax_year}, formation_year=${formationYear}`,
        expected_value: `tax_year=${formationYear}`,
      })
    }
  }

  return findings
}

// ── Rule 28: DUPLICATE PAYMENTS ────────────────────────────────────────────
//
// When two or more payment rows share the same amount AND the same
// created_at timestamp, it's almost always a double-insert from a webhook
// retry, a manual duplication, or a stale form resubmit. One finding is
// emitted per (amount, created_at) collision group.

export function rule28_duplicatePayments(ctx: HealthContext): Finding[] {
  if (ctx.payments.length < 2) return []

  const groups = new Map<string, PaymentRow[]>()
  for (const p of ctx.payments) {
    if (p.amount === null) continue
    if (!p.created_at) continue
    const key = `${p.amount}|${p.created_at}`
    const list = groups.get(key) ?? []
    list.push(p)
    groups.set(key, list)
  }

  const findings: Finding[] = []
  for (const entry of Array.from(groups.entries())) {
    const [key, list] = entry
    if (list.length < 2) continue
    const [amountStr, createdAt] = key.split("|")
    findings.push({
      rule_id: "R28",
      rule_title: "Duplicate payments",
      severity: "warning",
      description: `Possible duplicate payments — ${list.length} payments of ${amountStr} created at the same time.`,
      current_value: `payment_ids=[${list.map(p => p.id).join(",")}], amount=${amountStr}, created_at=${createdAt}`,
      expected_value: "no duplicates",
    })
  }

  return findings
}

// ── Aggregator ─────────────────────────────────────────────────────────────

export const RULE_FUNCTIONS = [
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
] as const

export function runRules(ctx: HealthContext): Finding[] {
  const findings: Finding[] = []
  for (const fn of RULE_FUNCTIONS) {
    try {
      const result = fn(ctx)
      findings.push(...result)
    } catch (e) {
      findings.push({
        rule_id: fn.name.split("_")[0]?.toUpperCase() || "Rx",
        rule_title: "Rule execution error",
        severity: "error",
        description: `Rule ${fn.name} threw: ${e instanceof Error ? e.message : String(e)}`,
        current_value: null,
        expected_value: null,
      })
    }
  }
  return findings
}

function summarise(findings: Finding[]): AuditResult["summary"] {
  return {
    error: findings.filter(f => f.severity === "error").length,
    warning: findings.filter(f => f.severity === "warning").length,
    info: findings.filter(f => f.severity === "info").length,
    total: findings.length,
  }
}

// ── Live audit (fetch + run) ───────────────────────────────────────────────

export async function auditClientHealth(accountId: string): Promise<AuditResult> {
  const { data: account, error: accountErr } = await supabaseAdmin
    .from("accounts")
    .select(
      "id, company_name, account_type, status, entity_type, ein_number, formation_date, state_of_formation, portal_tier, portal_account, ra_renewal_date, cmra_renewal_date, annual_report_due_date",
    )
    .eq("id", accountId)
    .single()
  if (accountErr || !account) {
    throw new Error(`Account ${accountId} not found${accountErr ? `: ${accountErr.message}` : ""}`)
  }

  const { data: linkRows } = await supabaseAdmin
    .from("account_contacts")
    .select("contact_id, contacts(id, email, portal_tier)")
    .eq("account_id", accountId)

  const contacts: ContactRow[] = ((linkRows || []) as Array<{ contacts: { id: string; email: string | null; portal_tier: string | null } | null }>)
    .map(r => r.contacts)
    .filter((c): c is { id: string; email: string | null; portal_tier: string | null } => !!c)
    .map(c => ({ id: c.id, email: c.email, portal_tier: c.portal_tier }))

  const contactIds = contacts.map(c => c.id)
  const orClauses: string[] = [`account_id.eq.${accountId}`]
  if (contactIds.length > 0) orClauses.push(`contact_id.in.(${contactIds.join(",")})`)

  const contactEmails = contacts.map(c => c.email).filter((e): e is string => !!e)

  const [sdResult, ss4Result, leaseResult, docsResult, taxReturnsResult, offersResult, leadsResult, membersResult, oaResult, paymentsResult, partnersResult] = await Promise.all([
    supabaseAdmin
      .from("service_deliveries")
      .select("id, service_type, status, stage, stage_order, account_id, contact_id, created_at")
      .or(orClauses.join(",")),
    supabaseAdmin
      .from("ss4_applications")
      .select("id, status, pdf_signed_drive_id, created_at, updated_at")
      .eq("account_id", accountId),
    supabaseAdmin
      .from("lease_agreements")
      .select("id, status, signed_at")
      .eq("account_id", accountId),
    supabaseAdmin
      .from("documents")
      .select("id, account_id, contact_id, document_type_name, file_name")
      .or(orClauses.join(",")),
    supabaseAdmin
      .from("tax_returns")
      .select("id, tax_year, status")
      .eq("account_id", accountId),
    supabaseAdmin
      .from("offers")
      .select("contract_type")
      .eq("account_id", accountId)
      .order("created_at", { ascending: false }),
    contactEmails.length > 0
      ? supabaseAdmin
          .from("leads")
          .select("id, email, status, converted_to_contact_id, converted_to_account_id")
          .in("email", contactEmails)
      : Promise.resolve({ data: [] as LeadRow[] }),
    supabaseAdmin
      .from("members")
      .select("member_type, full_name, representative_name, is_primary, ownership_pct, contact_id")
      .eq("account_id", accountId),
    supabaseAdmin
      .from("oa_agreements")
      .select("id, total_signers, status")
      .eq("account_id", accountId),
    supabaseAdmin
      .from("payments")
      .select("id, description, status, amount, paid_date, created_at")
      .eq("account_id", accountId),
    contactIds.length > 0
      ? supabaseAdmin
          .from("client_partners")
          .select("id, contact_id, partner_name, agreed_services")
          .in("contact_id", contactIds)
      : Promise.resolve({ data: [] as PartnerRow[] }),
  ])

  // Auth user check — only call findAuthUserByEmail if at least one contact
  // has an email. Paginated listUsers is slow, so we short-circuit.
  let hasAuthUser = false
  for (const c of contacts) {
    if (!c.email) continue
    try {
      const found = await findAuthUserByEmail(c.email)
      if (found) {
        hasAuthUser = true
        break
      }
    } catch {
      // Treat lookup failure as "unknown" rather than blocking the audit.
    }
  }

  const allOffers = (offersResult.data || []) as OfferRow[]
  const hasRenewalOffer = allOffers.some(
    o => (o.contract_type || "").toLowerCase() === "renewal",
  )

  const ctx: HealthContext = {
    account: account as AccountRow,
    contacts,
    service_deliveries: (sdResult.data || []) as SDRow[],
    ss4_applications: (ss4Result.data || []) as SS4Row[],
    lease_agreements: (leaseResult.data || []) as LeaseRow[],
    documents: (docsResult.data || []) as DocumentRow[],
    tax_returns: (taxReturnsResult.data || []) as TaxReturnRow[],
    most_recent_offer: allOffers[0] || null,
    leads: (leadsResult.data || []) as LeadRow[],
    members: (membersResult.data || []) as MemberRow[],
    oa_agreements: (oaResult.data || []) as OARow[],
    payments: (paymentsResult.data || []) as PaymentRow[],
    client_partners: (partnersResult.data || []) as PartnerRow[],
    has_renewal_offer: hasRenewalOffer,
    has_auth_user: hasAuthUser,
  }

  const findings = runRules(ctx)
  return {
    account_id: accountId,
    company_name: account.company_name,
    generated_at: new Date().toISOString(),
    findings,
    summary: summarise(findings),
  }
}
