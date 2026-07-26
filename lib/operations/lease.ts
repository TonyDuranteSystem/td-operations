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
  /** Tenant signature title. Default: 'Manager'. */
  tenant_title?: string
  /**
   * When true, the code-side (account_id + contract_year) SELECT duplicate
   * check is skipped. Default false. Used by CRM admin paths that want the
   * caller to decide on conflict.
   *
   * ⚠️ This only skips the CODE check — it does NOT override the DB. The unique
   * index uq_lease_account_year_tenant (account_id, contract_year,
   * tenant_company) still enforces one lease per year per tenant, and
   * createLease always writes tenant_company = account.company_name. So to
   * re-generate a same-year lease after a cancellation you must first remove
   * (or void) the prior row; otherwise the INSERT raises a unique violation,
   * which createLease surfaces as outcome "duplicate" (never a second row).
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
      // Keyed on account+year ONLY (not tenant_company). This is the SAFETY net
      // against silent suite/registered-address drift: if the account's legal
      // name was corrected and staff re-generate the same-year lease, the new
      // tenant_company would otherwise miss the prior lease, create a second one
      // with a fresh suite, and overwrite accounts.physical_address. A visible
      // "duplicate" refusal is far safer than a silent address change.
      //
      // A genuinely separate PERSONAL lease (a different tenant_company on the
      // same account, same year — the documented Imperium company+owner case) is
      // NOT created here: createLease always writes tenant_company =
      // account.company_name, so it only ever makes the company lease. Such a
      // personal lease is authored by a different path that sets its own tenant;
      // the unique index keeps both because their tenant_company differs.
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

    // 4. Suite number. A suite is the client's REGISTERED ADDRESS — the address
    // they give their bank — so it must stay STABLE across the years. Previously
    // every lease took the next number from a single global counter, so a renewal
    // (a new contract_year) silently reassigned a DIFFERENT suite and then step 7
    // overwrote accounts.physical_address to the new address. Fix: reuse the suite
    // this account already holds (its earliest prior lease); only a genuinely NEW
    // account with no prior lease gets a fresh number. An explicit suite always
    // wins (staff override).
    let suiteNumber = params.suite_number
    if (!suiteNumber) {
      // Scope to the SAME TENANT, not just the account. An account can carry more
      // than one lease with different suites — e.g. Imperium Commerce LLC has a
      // company lease (3D-111) and a separate PERSONAL lease for its owner
      // (3D-112) created the same day. createLease always writes
      // tenant_company = account.company_name, so match on it: a company renewal
      // reuses the company's own suite and can never inherit the personal one.
      const { data: priorLeases } = await supabaseAdmin
        .from("lease_agreements")
        .select("suite_number")
        .eq("account_id", params.account_id)
        .eq("tenant_company", account.company_name)
        .not("suite_number", "is", null)
        .order("created_at", { ascending: true })
        .limit(1)
      suiteNumber = priorLeases?.[0]?.suite_number ?? (await nextSuiteNumber())
    }

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
        tenant_title: params.tenant_title ?? 'Manager',
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
      // Race loser: another writer inserted the (account_id, contract_year)
      // lease between our duplicate check and this insert. The unique index
      // uq_lease_account_contract_year rejects it with 23505 — treat it as a
      // duplicate (not an error) so callers behave exactly as the SELECT-caught
      // duplicate path, and no second lease row is ever created.
      if (insertErr?.code === "23505") {
        const { data: winner } = await supabaseAdmin
          .from("lease_agreements")
          .select("id, token, status")
          .eq("account_id", params.account_id)
          .eq("contract_year", year)
          .eq("tenant_company", account.company_name)
          .limit(1)
        if (winner?.length) {
          const w = winner[0]
          return {
            success: false,
            outcome: "duplicate",
            existing: { id: w.id, token: w.token, status: w.status },
            error: `Lease already exists for ${account.company_name} year ${year}`,
          }
        }
      }
      return {
        success: false,
        outcome: "error",
        error: insertErr?.message || "Insert returned no data",
      }
    }

    // 7. Sync physical_address on the account so OA generation picks up the suite
    await supabaseAdmin
      .from("accounts")
      .update({ physical_address: `10225 Ulmerton Rd, Suite ${suiteNumber}, Largo, FL 33771` })
      .eq("id", params.account_id)

    // 8. Log
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

// ─── Send lease to the client portal ────────────────────────

export interface SendLeaseToPortalResult {
  success: boolean
  /** Lease status after the call ("sent" on success, or the existing status). */
  status?: string
  /** True when the lease was already in the portal (sent/viewed/signed) — a no-op success. */
  already?: boolean
  lease_id?: string
  token?: string
  recipient?: string | null
  tenant_company?: string
  access_code?: string
  /** True only when the ready-to-sign EMAIL actually went out (not push-only,
   * not skipped for a missing contact email, not failed). Lets callers report
   * truthfully instead of claiming an email that never sent. */
  emailSent?: boolean
  error?: string
}

/**
 * The lease statuses that mean it is already in the client's portal, so a
 * (re-)send is a no-op success. Lease status is constrained to
 * draft/sent/viewed/signed (chk_lease_status); "viewed" means the client has
 * already opened it — never knock that back to "sent".
 */
const LEASE_ALREADY_IN_PORTAL = ["sent", "viewed", "signed"]

/**
 * Make a draft lease appear in the client's PORTAL to sign.
 *
 * Leases reach clients through the portal, NOT by email — this flips the
 * status to "sent" and does not email anyone (mirrors send_oa). Shared so the
 * CRM Send Lease button AND the first-installment renewal auto-send use one
 * code path.
 *
 * Only a "draft" is sendable. A lease already in the portal (sent/viewed/
 * signed) is a no-op success. Any other status is refused with an explicit
 * error rather than falsely reported as sent. The UPDATE carries a
 * `status = 'draft'` guard against a TOCTOU double-flip; if it loses the race
 * the real status is re-read and classified honestly.
 */
export async function sendLeaseToPortal(token: string): Promise<SendLeaseToPortalResult> {
  const { data: lease, error } = await supabaseAdmin
    .from("lease_agreements")
    .select("id, status, tenant_email, tenant_company, account_id, access_code")
    .eq("token", token)
    .single()

  if (error || !lease) return { success: false, error: `Lease not found: ${token}` }

  const base = {
    lease_id: lease.id as string,
    token,
    recipient: lease.tenant_email as string | null,
    tenant_company: lease.tenant_company as string,
    access_code: lease.access_code as string,
  }

  if (LEASE_ALREADY_IN_PORTAL.includes(lease.status)) {
    return { success: true, status: lease.status, already: true, ...base }
  }
  if (lease.status !== "draft") {
    return { success: false, error: `Cannot send a lease in status "${lease.status}"`, ...base }
  }
  if (!lease.tenant_email) return { success: false, error: "No tenant email on lease record", ...base }

  const { data: updated, error: updateErr } = await supabaseAdmin
    .from("lease_agreements")
    .update({ status: "sent" })
    .eq("id", lease.id)
    .eq("status", "draft")
    .select("id")

  if (updateErr) return { success: false, error: `Failed to update lease status: ${updateErr.message}`, ...base }

  if (!updated?.length) {
    // Lost the draft→sent race — re-read to report the real state honestly.
    const { data: fresh } = await supabaseAdmin
      .from("lease_agreements")
      .select("status")
      .eq("id", lease.id)
      .single()
    const now = fresh?.status ?? "unknown"
    if (LEASE_ALREADY_IN_PORTAL.includes(now)) return { success: true, status: now, already: true, ...base }
    return { success: false, error: `Cannot send a lease in status "${now}"`, ...base }
  }

  logAction({
    actor: "system:lease",
    action_type: "send",
    table_name: "lease_agreements",
    record_id: lease.id,
    account_id: lease.account_id,
    summary: `Made lease available in the client portal for ${lease.tenant_company}`,
    details: { token, channel: "portal" },
  })

  // Tell the tenant their lease is ready to sign (portal chat + bell/push + an
  // immediate email when the contact has one on file). Best-effort: a notify
  // failure must never fail the send itself. emailSent reflects whether the
  // email channel actually went out, so callers don't claim an email that never
  // sent.
  let emailSent = false
  try {
    const { notifyLeaseReadyToSign } = await import("@/lib/portal/action-required")
    const notified = await notifyLeaseReadyToSign({ token })
    // "ok (N sent)" = emailed now. A "duplicate within dedup window" skip means
    // the client was already emailed for this within the last few minutes — so
    // report it as notified either way, rather than falsely telling staff no
    // email went out.
    const em = typeof notified.email === "string" ? notified.email : ""
    emailSent = em.startsWith("ok") || em.includes("duplicate within dedup window")
  } catch (err) {
    console.error(`[sendLeaseToPortal] notify failed for ${token}:`, err instanceof Error ? err.message : err)
  }

  return { success: true, status: "sent", emailSent, ...base }
}

export interface CancelLeaseDraftResult {
  success: boolean
  error?: string
  message?: string
}

/**
 * Permanently deletes a lease that is STILL a draft. A draft has never been
 * released to the client (only sent/viewed/signed leases appear in the portal),
 * so there is nothing client-facing to preserve — and removing it frees the
 * "one lease per company per year" block so staff can generate a corrected one.
 * Refuses anything past draft: a sent/viewed/signed lease is the client's
 * document and must never be silently destroyed (mirrors the OA recreate guard).
 * Lives here (not in the route) so the protected accounts write stays in the
 * operations layer, exactly like createLease/sendLeaseToPortal.
 */
export async function cancelLeaseDraft(token: string): Promise<CancelLeaseDraftResult> {
  const { data: lease, error } = await supabaseAdmin
    .from("lease_agreements")
    .select("id, status, tenant_company, account_id, contract_year, suite_number")
    .eq("token", token)
    .maybeSingle()

  if (error) return { success: false, error: `Could not read the lease: ${error.message}` }
  if (!lease) return { success: false, error: `Lease not found: ${token}` }
  if (lease.status !== "draft") {
    return {
      success: false,
      error:
        `Only a draft lease can be cancelled. This lease is "${lease.status}" — it has already ` +
        `been sent to or signed by the client, so it cannot be deleted here.`,
    }
  }

  // Conditional delete = TOCTOU guard. If the client (or another staff action)
  // flipped it out of "draft" between our read and here, this deletes NOTHING
  // and we report it honestly rather than destroying a live/signed lease.
  const { data: deleted, error: delErr } = await supabaseAdmin
    .from("lease_agreements")
    .delete()
    .eq("id", lease.id)
    .eq("status", "draft")
    .select("id")

  if (delErr) return { success: false, error: `Failed to cancel the draft: ${delErr.message}` }
  if (!deleted?.length) {
    return {
      success: false,
      error: `This lease is no longer a draft — it may have just been sent or signed. Nothing was deleted.`,
    }
  }

  // Undo the side effect createLease left on the account. When this draft was
  // generated, createLease wrote the account's physical_address to this suite
  // (that address is what a legacy account's client sees as their registered
  // mailing address). If we delete the draft and leave it, the account keeps
  // pointing at a suite no longer backed by any lease — and because suite numbers
  // are handed out as global-max+1, the freed number is recycled to the next new
  // account, so two clients could display the same suite. Recompute the address
  // from the account's REMAINING leases (reuse the earliest same-tenant suite, or
  // clear it if none remain) — but only when the stored address still reflects the
  // cancelled suite, so a manually-set address is never clobbered.
  if (lease.suite_number) {
    const { data: acct } = await supabaseAdmin
      .from("accounts")
      .select("physical_address")
      .eq("id", lease.account_id)
      .maybeSingle()
    if (acct?.physical_address?.includes(`Suite ${lease.suite_number}`)) {
      const { data: remaining } = await supabaseAdmin
        .from("lease_agreements")
        .select("suite_number")
        .eq("account_id", lease.account_id)
        .eq("tenant_company", lease.tenant_company)
        .not("suite_number", "is", null)
        .order("created_at", { ascending: true })
        .limit(1)
      const restored = remaining?.[0]?.suite_number
        ? `10225 Ulmerton Rd, Suite ${remaining[0].suite_number}, Largo, FL 33771`
        : null
      await supabaseAdmin
        .from("accounts")
        .update({ physical_address: restored })
        .eq("id", lease.account_id)
    }
  }

  logAction({
    actor: "crm-admin",
    action_type: "delete",
    table_name: "lease_agreements",
    record_id: lease.id,
    account_id: lease.account_id,
    summary: `Cancelled draft lease for ${lease.tenant_company} (${lease.contract_year})`,
    details: { token, status_before: "draft", source: "crm-button" },
  })

  return { success: true, message: "Draft lease cancelled." }
}
