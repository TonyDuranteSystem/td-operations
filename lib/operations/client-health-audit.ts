/**
 * Client Health Audit
 *
 * Pure-data audit over a single account, derived from 10 rules learned while
 * reviewing 9 real clients with Antonio (May 2026). Each rule is an
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
}

export interface LeaseRow {
  id: string
  status: string | null
  signed_at: string | null
}

export interface DocumentRow {
  id: string
  account_id: string | null
  contact_id: string | null
  document_type_name: string | null
}

export interface TaxReturnRow {
  id: string
  tax_year: number | null
  status: string | null
}

export interface OfferRow {
  contract_type: string | null
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

export function rule3_ss4StatusSync(ctx: HealthContext): Finding[] {
  const a = ctx.account
  if (!a.ein_number) return []
  if (ctx.ss4_applications.length === 0) return []

  const findings: Finding[] = []
  const STALE_STATUSES = new Set(["awaiting_signature", "submitted", "signed"])
  const TERMINAL_OK = new Set(["done", "ein_received"])

  for (const ss4 of ctx.ss4_applications) {
    const status = (ss4.status || "").trim().toLowerCase()
    if (!status) continue
    if (STALE_STATUSES.has(status)) {
      findings.push({
        rule_id: "R3",
        rule_title: "SS-4 status sync",
        severity: "warning",
        description:
          "Account has an EIN recorded but SS-4 record is still in a pre-EIN status. Mark SS-4 as 'done' / 'ein_received'.",
        current_value: `ss4.status=${status}`,
        expected_value: "done | ein_received",
      })
    } else if (!TERMINAL_OK.has(status)) {
      // Non-terminal but not in the well-known stale set — surface as info so
      // staff can investigate ad-hoc values without false errors.
      findings.push({
        rule_id: "R3",
        rule_title: "SS-4 status sync",
        severity: "info",
        description: "Account has an EIN but SS-4 status is not a known terminal value.",
        current_value: `ss4.status=${status}`,
        expected_value: "done | ein_received",
      })
    }
  }

  return findings
}

// ── Rule 4: CMRA SD ADVANCE AFTER LEASE SIGNED ─────────────────────────────

export function rule4_cmraAfterLease(ctx: HealthContext): Finding[] {
  const signedLease = ctx.lease_agreements.find(l => (l.status || "").toLowerCase() === "signed")
  if (!signedLease) return []

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
  return findings
}

// ── Rule 7: RENEWAL DATES ──────────────────────────────────────────────────

export function rule7_renewalDates(ctx: HealthContext, now: Date = new Date()): Finding[] {
  const a = ctx.account
  if (!a.formation_date) return []
  if (!isClient(a)) return [] // only applies to Client account_type
  const findings: Finding[] = []

  // RA renewal = formation_date + 1 year (approximately; ±60 days OK).
  if (a.ra_renewal_date) {
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
    }
    // If state isn't in the policy table, intentionally do not flag — unknown
    // states stay quiet rather than producing false positives.
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
  const hasTaxReturnSD = ctx.service_deliveries.some(sd => sd.service_type === "Tax Return")
  if (hasTaxReturnSD) return []

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
      "id, company_name, account_type, status, ein_number, formation_date, state_of_formation, portal_tier, portal_account, ra_renewal_date, cmra_renewal_date, annual_report_due_date",
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

  const [sdResult, ss4Result, leaseResult, docsResult, taxReturnsResult, offersResult] = await Promise.all([
    supabaseAdmin
      .from("service_deliveries")
      .select("id, service_type, status, stage, stage_order, account_id, contact_id, created_at")
      .or(orClauses.join(",")),
    supabaseAdmin
      .from("ss4_applications")
      .select("id, status, pdf_signed_drive_id")
      .eq("account_id", accountId),
    supabaseAdmin
      .from("lease_agreements")
      .select("id, status, signed_at")
      .eq("account_id", accountId),
    supabaseAdmin
      .from("documents")
      .select("id, account_id, contact_id, document_type_name")
      .or(orClauses.join(",")),
    supabaseAdmin
      .from("tax_returns")
      .select("id, tax_year, status")
      .eq("account_id", accountId),
    supabaseAdmin
      .from("offers")
      .select("contract_type")
      .eq("account_id", accountId)
      .order("created_at", { ascending: false })
      .limit(1),
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

  const ctx: HealthContext = {
    account: account as AccountRow,
    contacts,
    service_deliveries: (sdResult.data || []) as SDRow[],
    ss4_applications: (ss4Result.data || []) as SS4Row[],
    lease_agreements: (leaseResult.data || []) as LeaseRow[],
    documents: (docsResult.data || []) as DocumentRow[],
    tax_returns: (taxReturnsResult.data || []) as TaxReturnRow[],
    most_recent_offer: ((offersResult.data || [])[0] as OfferRow | undefined) || null,
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
