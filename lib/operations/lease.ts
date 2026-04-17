/**
 * P3.4 #10 — Lease operation authority layer
 *
 * Single-entry lease-create path for the Office Lease Agreement.
 * Callers:
 *   - MCP lease_create (lib/mcp/tools/lease.ts)
 *   - Onboarding auto-chain handler (lib/jobs/handlers/onboarding-setup.ts)
 *   - Welcome package handler (lib/jobs/handlers/welcome-package-setup.ts)
 *   - MCP welcome_package_prepare (lib/mcp/tools/welcome-package.ts)
 *   - MCP portal_transition_setup legacy-onboard branch (lib/mcp/tools/portal.ts)
 *   - CRM admin transition route (app/api/portal/admin/transition/route.ts)
 *   - CRM "Place Client" button (app/api/crm/admin-actions/place-client/route.ts)
 *   - CRM "Generate Document" for leases (app/api/crm/admin-actions/generate-document/route.ts)
 *
 * Why: before this, 8 different call sites each rebuilt the same
 * create logic — token from companySlug+year, suite auto-assign from
 * last-lease max, FL office defaults, duplicate-check (in most sites
 * but not all), logAction (in most sites but not all). Slight
 * variations drifted: some passed tenant_ein, some didn't; some
 * checked contract_year for duplicates, some skipped that. This
 * function is the single guarded surface.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import { logAction } from "@/lib/mcp/action-log"

// ─── Types ──────────────────────────────────────────────────

export interface CreateLeaseParams {
  account_id: string
  /**
   * Optional — if omitted, the operation fetches the first linked
   * contact from account_contacts. Pass this when the caller already
   * has the contact in hand (most CRM routes do) to save a query.
   */
  contact_id?: string
  /** Auto-assigned ("3D-NNN") if not provided. */
  suite_number?: string
  /** Default: current year. */
  contract_year?: number
  /** Default: today. */
  effective_date?: string
  /** Default: today. */
  term_start_date?: string
  /** Default: {contract_year}-12-31. */
  term_end_date?: string
  /** Default: 12. */
  term_months?: number
  /** Default: 100. */
  monthly_rent?: number
  /** Default: monthly_rent * 12. */
  yearly_rent?: number
  /** Default: 150. */
  security_deposit?: number
  /** Default: 120. */
  square_feet?: number
  /** Default: derived from contact.language; falls back to 'en'. */
  language?: "en" | "it"
  /**
   * When true, the (account_id + contract_year) duplicate check is
   * skipped. Default false. Used by flows that re-generate a lease
   * for the same year after a cancellation, or by CRM admin paths
   * that want the caller to decide on conflict.
   */
  skip_duplicate_check?: boolean
  actor?: string
  summary?: string
  details?: Record<string, unknown>
}

export interface CreateLeaseResult {
  success: boolean
  outcome: "created" | "duplicate" | "not_found" | "error"
  lease?: {
    id: string
    token: string
    access_code: string
    suite_number: string
    contract_year: number
    contact_id: string
  }
  existing?: { id: string; token: string; status: string }
  error?: string
}

// ─── Helpers ────────────────────────────────────────────────

function buildCompanySlug(companyName: string): string {
  return companyName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
}

async function nextSuiteNumber(): Promise<string> {
  const { data: lastLeases } = await supabaseAdmin
    .from("lease_agreements")
    .select("suite_number")
    .order("suite_number", { ascending: false })
    .limit(1)
  if (!lastLeases?.length) return "3D-101"
  const lastNum = parseInt(lastLeases[0].suite_number.replace("3D-", ""), 10)
  if (isNaN(lastNum)) return "3D-101"
  return `3D-${(lastNum + 1).toString().padStart(3, "0")}`
}

// ─── createLease ────────────────────────────────────────────

export async function createLease(
  params: CreateLeaseParams
): Promise<CreateLeaseResult> {
  try {
    if (!params.account_id) {
      return { success: false, outcome: "error", error: "account_id is required" }
    }

    // 1. Fetch account
    const { data: account, error: accErr } = await supabaseAdmin
      .from("accounts")
      .select("id, company_name, ein_number, state_of_formation")
      .eq("id", params.account_id)
      .maybeSingle()

    if (accErr) {
      return { success: false, outcome: "error", error: accErr.message }
    }
    if (!account) {
      return { success: false, outcome: "not_found", error: `Account ${params.account_id} not found` }
    }

    // 2. Resolve contact
    let contactId = params.contact_id
    if (!contactId) {
      const { data: contactLinks } = await supabaseAdmin
        .from("account_contacts")
        .select("contact_id")
        .eq("account_id", params.account_id)
        .limit(1)
      if (!contactLinks?.length) {
        return {
          success: false,
          outcome: "not_found",
          error: `No contact linked to account ${account.company_name}. Link a contact first.`,
        }
      }
      contactId = contactLinks[0].contact_id as string
    }

    const { data: contact, error: contactErr } = await supabaseAdmin
      .from("contacts")
      .select("id, full_name, email, language")
      .eq("id", contactId)
      .maybeSingle()

    if (contactErr) {
      return { success: false, outcome: "error", error: contactErr.message }
    }
    if (!contact) {
      return { success: false, outcome: "not_found", error: `Contact ${contactId} not found` }
    }

    // 3. Duplicate check (unless opted out)
    const year = params.contract_year ?? new Date().getFullYear()
    if (!params.skip_duplicate_check) {
      const { data: existing } = await supabaseAdmin
        .from("lease_agreements")
        .select("id, token, status")
        .eq("account_id", params.account_id)
        .eq("contract_year", year)
        .limit(1)
      if (existing?.length) {
        const ex = existing[0]
        return {
          success: false,
          outcome: "duplicate",
          existing: { id: ex.id, token: ex.token, status: ex.status },
          error: `Lease already exists for ${account.company_name} year ${year}`,
        }
      }
    }

    // 4. Suite number
    const suiteNumber = params.suite_number ?? (await nextSuiteNumber())

    // 5. Token + dates + rent defaults
    const today = new Date().toISOString().slice(0, 10)
    const token = `${buildCompanySlug(account.company_name)}-${year}`
    const effectiveDate = params.effective_date || today
    const termStartDate = params.term_start_date || today
    const termEndDate = params.term_end_date || `${year}-12-31`
    const monthlyRent = params.monthly_rent ?? 100
    const yearlyRent = params.yearly_rent ?? monthlyRent * 12
    const language =
      params.language ||
      (contact.language?.toLowerCase()?.startsWith("it") ? "it" : "en")

    // 6. Insert
    const { data: lease, error: insertErr } = await supabaseAdmin
      .from("lease_agreements")
      .insert({
        token,
        account_id: params.account_id,
        contact_id: contact.id,
        tenant_company: account.company_name,
        tenant_ein: account.ein_number || null,
        tenant_state: account.state_of_formation || null,
        tenant_contact_name: contact.full_name,
        tenant_email: contact.email || null,
        premises_address: "10225 Ulmerton Rd, Largo, FL 33771",
        suite_number: suiteNumber,
        square_feet: params.square_feet ?? 120,
        effective_date: effectiveDate,
        term_start_date: termStartDate,
        term_end_date: termEndDate,
        term_months: params.term_months ?? 12,
        contract_year: year,
        monthly_rent: monthlyRent,
        yearly_rent: yearlyRent,
        security_deposit: params.security_deposit ?? 150,
        language,
        status: "draft",
      })
      .select("id, token, access_code, suite_number, contract_year, contact_id")
      .single()

    if (insertErr || !lease) {
      return {
        success: false,
        outcome: "error",
        error: insertErr?.message || "Insert returned no data",
      }
    }

    // 7. Log
    logAction({
      actor: params.actor || "system",
      action_type: "create",
      table_name: "lease_agreements",
      record_id: lease.id,
      account_id: params.account_id,
      summary:
        params.summary ||
        `Created lease for ${account.company_name} (${year}), Suite ${suiteNumber}`,
      details: params.details || {
        token: lease.token,
        suite_number: suiteNumber,
        contract_year: year,
      },
    })

    return {
      success: true,
      outcome: "created",
      lease: {
        id: lease.id,
        token: lease.token,
        access_code: lease.access_code,
        suite_number: lease.suite_number,
        contract_year: lease.contract_year,
        contact_id: lease.contact_id as string,
      },
    }
  } catch (err) {
    return {
      success: false,
      outcome: "error",
      error: err instanceof Error ? err.message : String(err),
    }
  }
}
