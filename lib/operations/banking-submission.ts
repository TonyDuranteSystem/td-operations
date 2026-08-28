/**
 * The ONE correct way to get-or-create a company's banking-application
 * record (`banking_submissions`, one row per account+provider).
 *
 * Why this exists (2026-08-28, dev job c3efa6cb): this row is the thing the
 * banking-wizard staff notifications (What's New note + Notification Center
 * card, app/api/portal/wizard-submit/route.ts) key off of. It used to be
 * created two different, independently hand-rolled ways — the
 * `welcome_package_prepare` job and the `welcome_package` MCP tool — with
 * slightly different `prefilled_data` shapes. When neither ever ran for an
 * account (confirmed: at least 3 distinct ways an account's EIN can get
 * recorded without triggering either), the notification code had nothing to
 * key off and silently skipped both staff alerts — real client submissions
 * (BRIXEL LLC, Automatiko LLC, and 5 others) went unreviewed for weeks.
 *
 * A council review (senior-engineer, ai-architect, bug-hunter, project-
 * director) of the fix found that patching the notification code to
 * hand-roll a THIRD insert would reproduce the exact same drift that caused
 * the incident, and would race under a double-submit with no DB backstop
 * (confirmed: banking_submissions had no uniqueness beyond its primary key —
 * see migration 20260828-1200-banking-submissions-unique-account-provider).
 * This function is the fix: the job, the MCP tool, and the notification
 * code's fallback all call this instead of inserting directly.
 *
 * Token format (relay-<slug>-<year> / bank-<slug>-<year>, 30-char slug
 * truncation) is preserved exactly as the job originally used it — do not
 * change it without checking every existing row's token stays matchable.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"

export interface GetOrCreateBankingSubmissionParams {
  accountId: string
  provider: "relay" | "payset"
  contactId?: string | null
}

export interface BankingSubmissionRecord {
  id: string
  token: string
  status: string
  access_code: string | null
  /** true if this call created the row; false if one already existed. */
  created: boolean
}

export type GetOrCreateBankingSubmissionResult =
  | { outcome: "ok"; record: BankingSubmissionRecord }
  | { outcome: "error"; message: string }

function buildToken(provider: "relay" | "payset", companySlug: string, year: number): string {
  return provider === "relay"
    ? `relay-${companySlug.slice(0, 30)}-${year}`
    : `bank-${companySlug.slice(0, 30)}-${year}`
}

function buildPrefilledData(
  provider: "relay" | "payset",
  account: { company_name: string; ein_number: string | null },
  contact: { first_name: string | null; last_name: string | null; email: string | null; phone: string | null; citizenship: string | null } | null,
): Record<string, string> {
  const base = {
    business_name: account.company_name || "",
    phone: contact?.phone || "",
    email: contact?.email || "",
    first_name: contact?.first_name || "",
    last_name: contact?.last_name || "",
  }
  return provider === "relay"
    ? { ...base, ein: account.ein_number || "", personal_phone: contact?.phone || "", personal_email: contact?.email || "" }
    : { ...base, personal_country: contact?.citizenship || "" }
}

/**
 * Returns the existing row for this account+provider, or creates one using
 * the standard token/prefilled_data shape. Safe under concurrency: if two
 * callers race, the unique index on (account_id, provider) rejects the
 * loser's insert, and the loser re-reads to return the winner's row instead
 * of erroring.
 */
export async function getOrCreateBankingSubmission(
  params: GetOrCreateBankingSubmissionParams,
): Promise<GetOrCreateBankingSubmissionResult> {
  const { accountId, provider, contactId } = params

  const { data: existing, error: lookupErr } = await supabaseAdmin
    .from("banking_submissions")
    .select("id, token, status, access_code")
    .eq("account_id", accountId)
    .eq("provider", provider)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle()

  if (lookupErr) {
    return { outcome: "error", message: `lookup failed: ${lookupErr.message}` }
  }
  if (existing) {
    return { outcome: "ok", record: { id: existing.id, token: existing.token, status: existing.status, access_code: existing.access_code, created: false } }
  }

  const { data: account, error: accErr } = await supabaseAdmin
    .from("accounts")
    .select("id, company_name, ein_number")
    .eq("id", accountId)
    .single()
  if (accErr || !account) {
    return { outcome: "error", message: `account not found: ${accErr?.message ?? accountId}` }
  }

  let contact: { first_name: string | null; last_name: string | null; email: string | null; phone: string | null; citizenship: string | null; language: string | null } | null = null
  const resolvedContactId = contactId ?? (
    await supabaseAdmin.from("account_contacts").select("contact_id").eq("account_id", accountId).limit(1).maybeSingle()
  ).data?.contact_id ?? null
  if (resolvedContactId) {
    const { data } = await supabaseAdmin
      .from("contacts")
      .select("first_name, last_name, email, phone, citizenship, language")
      .eq("id", resolvedContactId)
      .maybeSingle()
    contact = data ?? null
  }

  const companySlug = account.company_name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")
  const year = new Date().getFullYear()
  const token = buildToken(provider, companySlug, year)
  const lang = contact?.language === "Italian" || contact?.language === "it" ? "it" : "en"

  const { data: inserted, error: insertErr } = await supabaseAdmin
    .from("banking_submissions")
    .insert({
      token,
      account_id: accountId,
      contact_id: resolvedContactId,
      provider,
      language: lang,
      prefilled_data: buildPrefilledData(provider, account, contact),
      status: "pending",
    })
    .select("id, token, status, access_code")
    .single()

  if (insertErr) {
    // 23505 = unique_violation. A concurrent caller won the race for the
    // same (account_id, provider) — re-read and return their row rather
    // than surfacing an error for what is actually a successful outcome.
    if ((insertErr as { code?: string }).code === "23505") {
      const { data: winner } = await supabaseAdmin
        .from("banking_submissions")
        .select("id, token, status, access_code")
        .eq("account_id", accountId)
        .eq("provider", provider)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle()
      if (winner) {
        return { outcome: "ok", record: { id: winner.id, token: winner.token, status: winner.status, access_code: winner.access_code, created: false } }
      }
    }
    return { outcome: "error", message: `insert failed: ${insertErr.message}` }
  }
  if (!inserted) {
    return { outcome: "error", message: "insert returned no row" }
  }

  return { outcome: "ok", record: { id: inserted.id, token: inserted.token, status: inserted.status, access_code: inserted.access_code, created: true } }
}
