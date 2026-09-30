/**
 * P3.4 #10 — Lease operation authority layer
 *
 * Single-entry lease-create path for the Office Lease Agreement.
 * Callers:
 *   - MCP lease_create (lib/mcp/tools/lease.ts)
 *   - Onboarding auto-chain handler (lib/jobs/handlers/onboarding-setup.ts)
 *   - Welcome package handler (lib/jobs/handlers/welcome-package-setup.ts)
 *   - MCP welcome_package_prepare (lib/mcp/tools/welcome-package.ts)
 *   - CRM "Place Client" button (app/api/crm/admin-actions/place-client/route.ts)
 *   - CRM "Generate Document" for leases (app/api/crm/admin-actions/generate-document/route.ts)
 *   - Annual renewal on first-installment payment (lib/installment-handler.ts) —
 *     the highest-volume, fully unattended caller; missing from this list until
 *     a QA-Tester pass caught the omission (dev job 9ad76300-6181-4250-a1de-c77f37933f82, 2026-08-19).
 *
 * Why: before this, 9 different call sites each rebuilt the same
 * create logic — token from companySlug+year, suite auto-assign from
 * last-lease max, FL office defaults, duplicate-check (in most sites
 * but not all), logAction (in most sites but not all). Slight
 * variations drifted: some passed tenant_ein, some didn't; some
 * checked contract_year for duplicates, some skipped that. This
 * function is the single guarded surface.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import { logAction } from "@/lib/mcp/action-log"
import { dbWrite } from "@/lib/db"

// ─── Types ──────────────────────────────────────────────────

export interface CreateLeaseParams {
  account_id: string
  /**
   * Optional — if omitted, the operation resolves the correct signer
   * itself via lib/members/resolve-signer.ts::resolveAccountSigner
   * (the members.is_signer flag, never the first linked contact). Pass
   * this only when the caller has already resolved a signer through
   * some other legitimate path — an explicit contact_id always wins
   * and skips the resolver entirely, so don't pass a generic "primary
   * contact" fetched for an unrelated purpose (Prowave LLC incident,
   * dev job 9ad76300-6181-4250-a1de-c77f37933f82).
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

/**
 * Canonical form of a suite typed by staff: "3D-318". Accepts "3d318", "3D 318",
 * "Suite 3D-318"; returns null for anything else (the caller rejects it).
 */
export function normalizeSuiteNumber(input: string | null | undefined): string | null {
  const m = /^\s*(?:suite\s*)?3D\s*-?\s*(\d{2,4})\s*$/i.exec(input ?? "")
  return m ? `3D-${parseInt(m[1], 10).toString().padStart(3, "0")}` : null
}

/** "3D-318" -> 318. Anything not shaped like a numbered TD suite -> null. */
export function suiteNumericPart(suite: string | null | undefined): number | null {
  const m = /^\s*3D-(\d+)\s*$/i.exec(suite ?? "")
  return m ? parseInt(m[1], 10) : null
}

/**
 * The next free suite. The highest number is taken NUMERICALLY (a string sort
 * would rank "3D-999" above "3D-1000") across BOTH places a suite can live:
 * lease_agreements.suite_number and accounts.suite_number — so a suite that was
 * assigned to a company but has no lease yet is never handed to someone else.
 * The accounts read is tolerant: before its column exists it just contributes
 * nothing, so this never breaks a deploy that lands ahead of the migration.
 */
export async function nextSuiteNumber(): Promise<string> {
  return `3D-${((await highestSuiteNumber()) + 1).toString().padStart(3, "0")}`
}

/**
 * The highest suite number in use anywhere (leases + assigned company suites),
 * or 100 when none exist. A failed read must NEVER look like "no suites exist" —
 * that would hand out 3D-101, a real client's suite. The lease read must
 * succeed. The accounts read may fail ONLY because the column does not exist
 * yet (Postgres 42703, a deploy that landed ahead of the migration); any other
 * error also throws.
 */
export async function highestSuiteNumber(): Promise<number> {
  const leaseSuites = await readAllSuites("lease_agreements", false)
  const accountSuites = await readAllSuites("accounts", true)
  let max = 100
  for (const value of [...leaseSuites, ...accountSuites]) {
    const n = suiteNumericPart(value)
    if (n !== null && n > max) max = n
  }
  return max
}

/** Every non-null suite_number in a table, paged (PostgREST caps a page at 1000 rows). */
async function readAllSuites(table: "lease_agreements" | "accounts", tolerateMissingColumn: boolean): Promise<string[]> {
  const PAGE = 1000
  const out: string[] = []
  for (let from = 0; from < 50 * PAGE; from += PAGE) {
    const { data, error } = await supabaseAdmin
      .from(table)
      .select("suite_number")
      .not("suite_number", "is", null)
      .order("suite_number", { ascending: false })
      .range(from, from + PAGE - 1)
    if (error) {
      if (tolerateMissingColumn && (error as { code?: string }).code === "42703") return out
      throw new Error(`Could not read ${table}.suite_number: ${error.message}`)
    }
    const rows = Array.isArray(data) ? (data as Array<{ suite_number?: string | null }>) : []
    for (const r of rows) if (typeof r.suite_number === "string") out.push(r.suite_number)
    if (rows.length < PAGE) break
  }
  return out
}

/** The suite staff assigned to a company (accounts.suite_number), or null. Never throws. */
async function getAssignedSuite(accountId: string): Promise<string | null> {
  const { data } = await supabaseAdmin
    .from("accounts")
    .select("suite_number")
    .eq("id", accountId)
    .maybeSingle()
  // Only a well-formed suite counts. The column is free text, so any writer other
  // than the CRM save could have stored "TBD" or "Suite 3D-318"; those must not
  // reach a lease — fall through to prior-lease reuse instead.
  return normalizeSuiteNumber((data as { suite_number?: string | null } | null)?.suite_number)
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

    // 2. Resolve contact. An explicit contact_id always wins (a caller that
    // already knows who signs). Otherwise resolve via resolveAccountSigner —
    // the members-table signer rule shared with SS-4 (is_signer flag,
    // decoupled from ownership %; company member via its representative),
    // falling back to a role-aware account_contacts default for SMLLC/legacy
    // accounts with no members rows. Replaces the old unordered
    // account_contacts.limit(1) pick that named the wrong tenant on a
    // Multi-Member LLC's lease (dev job 9ad76300-6181-4250-a1de-c77f37933f82 — Prowave LLC).
    let contact: { id: string; full_name: string; email: string | null; language?: string | null }
    if (params.contact_id) {
      const { data: explicitContact, error: contactErr } = await supabaseAdmin
        .from("contacts")
        .select("id, full_name, email, language")
        .eq("id", params.contact_id)
        .maybeSingle()

      if (contactErr) {
        return { success: false, outcome: "error", error: contactErr.message }
      }
      if (!explicitContact) {
        return { success: false, outcome: "not_found", error: `Contact ${params.contact_id} not found` }
      }
      contact = explicitContact
    } else {
      const { resolveAccountSigner } = await import("@/lib/members/resolve-signer")
      const resolved = await resolveAccountSigner(params.account_id)
      if (resolved.outcome === "blocked") {
        return { success: false, outcome: "error", error: resolved.message }
      }
      if (resolved.outcome === "not_found") {
        return { success: false, outcome: "not_found", error: resolved.message }
      }
      contact = resolved.contact
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
    // wins (staff override). Next comes the suite staff ASSIGNED to the company
    // (accounts.suite_number, the "Suite assigned" field in Company Info) — that
    // field is the source of truth when set — then the prior-lease reuse.
    let suiteNumber = params.suite_number
    if (!suiteNumber) {
      suiteNumber = (await getAssignedSuite(params.account_id)) ?? undefined
    }
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

    // 7b. Record the suite on the company ("Suite assigned") if none is set yet,
    // so the field is filled for every company that gets a lease. Best-effort and
    // separate from the write above: it must never fail a lease (and before the
    // column exists it simply errors and is ignored).
    await supabaseAdmin
      .from("accounts")
      .update({ suite_number: suiteNumber })
      .eq("id", params.account_id)
      .is("suite_number", null)

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
  // are handed out as global-max+1, the freed number could be recycled to the next
  // new account, so two clients could display the same suite. (Since the company's
  // "Suite Assigned" field: the field is cleared below when it holds this draft's
  // suite and the company has no other lease, so the number is free again.)
  // Recompute the address
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

    // The lease had written this suite onto the company ("Suite Assigned"). If the
    // company holds no other lease, release it — otherwise a draft cancelled
    // because it was made for the WRONG company leaves that suite stuck on it.
    // Best-effort, exact-match only (never clears a different suite).
    const { data: otherLeases } = await supabaseAdmin
      .from("lease_agreements")
      .select("id")
      .eq("account_id", lease.account_id)
      .limit(1)
    if (!otherLeases?.length) {
      await supabaseAdmin
        .from("accounts")
        .update({ suite_number: null })
        .eq("id", lease.account_id)
        .eq("suite_number", lease.suite_number)
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

/**
 * Resolve the TD-provided mailing address (a shared `addresses` row) that a
 * signed lease's premises correspond to. Matches by prefix against
 * `address_line1` rather than a hardcoded ID so this keeps working if a
 * second TD building is ever wired into lease creation. Returns null if no
 * TD-provided business_mailing address matches — caller should skip, not
 * guess (dev job 525e0e67, CMRA Issues-panel investigation, 2026-08-30).
 */
export async function resolveTdMailingAddressForLease(
  premisesAddress: string | null,
): Promise<string | null> {
  if (!premisesAddress) return null

  const { data: candidates } = await supabaseAdmin
    .from("addresses")
    .select("id, address_line1")
    .eq("kind", "business_mailing")
    .eq("is_td_provided", true)
    .eq("active", true)

  // Longest-prefix-first: a deterministic tie-break if a future second TD
  // building's address_line1 ever prefix-collides with another's (no DB
  // uniqueness constraint on address_line1 to rely on instead).
  const sorted = [...(candidates || [])].sort(
    (a, b) => (b.address_line1?.length ?? 0) - (a.address_line1?.length ?? 0),
  )
  const match = sorted.find((a) =>
    premisesAddress.toLowerCase().startsWith((a.address_line1 || "").toLowerCase()),
  )
  return match?.id ?? null
}

/**
 * Point an account's official mailing address at the TD building its signed
 * lease's premises correspond to. The single write path for
 * accounts.business_mailing_address_id from a lease event — lives here
 * (lib/operations/**) rather than inline in the calling routes so both the
 * live lease-signed webhook and the one-off backfill (dev job 525e0e67) go
 * through the same resolution + write logic (P2.4 rule 1).
 *
 * Never overwrites an already-set address. Every new lease's premises
 * currently resolves to the same default building (createLease() hardcodes
 * it — see above), so an unconditional overwrite would silently reset any
 * account already linked to a DIFFERENT TD address back to the default the
 * next time that lease renews and gets signed (caught by council review
 * before shipping — dev job 525e0e67, 2026-08-30; the reference case is
 * E-commerce Empire New York LLC — its business_mailing_address_id already
 * points elsewhere, though whether that's a deliberate assignment or stale
 * data is UNCONFIRMED, flagged to Antonio, not something this function
 * should guess at either way). If a genuine relocation between TD buildings
 * is ever built, that feature should call this with an explicit force path
 * — silently reinterpreting "unset" as "safe to overwrite" is not that
 * feature.
 */
export async function linkAccountToLeaseMailingAddress(
  accountId: string,
  premisesAddress: string | null,
): Promise<{ linked: boolean; addressId: string | null }> {
  const { data: account } = await supabaseAdmin
    .from("accounts")
    .select("business_mailing_address_id")
    .eq("id", accountId)
    .single()
  if (account?.business_mailing_address_id) return { linked: false, addressId: null }

  const addressId = await resolveTdMailingAddressForLease(premisesAddress)
  if (!addressId) return { linked: false, addressId: null }

  // dbWrite (not a raw await) so a failed write throws and surfaces to the
  // caller's try/catch as a real error, instead of this function reporting
  // `linked: true` on a write that never actually landed (Supabase errors
  // are returned, not thrown — bug-hunter review, dev job 525e0e67).
  const updated = await dbWrite(
    supabaseAdmin.from("accounts").update({ business_mailing_address_id: addressId }).eq("id", accountId).select("id"),
    "accounts.business_mailing_address_id_from_lease",
  )
  if (!updated || (Array.isArray(updated) && updated.length === 0)) {
    throw new Error(`linkAccountToLeaseMailingAddress: update matched no row for account ${accountId}`)
  }

  return { linked: true, addressId }
}
