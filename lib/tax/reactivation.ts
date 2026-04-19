/**
 * Tax Return pause reactivation — flip `on_hold` Tax Return SDs back to
 * `active` once the client's 2nd installment has been paid.
 *
 * Runs in two places:
 *   1. Synchronously from `onSecondInstallmentPaid` in lib/installment-handler.ts
 *      — so the banner switches back immediately when a 2nd installment is
 *      recorded through the normal payment flow.
 *   2. Daily from /api/cron/tax-reactivation as a safety net — picks up any
 *      payments recorded manually, ingested from Stripe webhooks that
 *      bypassed `onSecondInstallmentPaid`, or back-dated after the SD was
 *      parked on_hold.
 *
 * Intentionally NOT touching `app_settings.tax_season_paused`. That is the
 * global master switch — flipping it to false reactivates ALL on_hold SDs
 * via the portal's banner logic. The per-SD reactivation here is for clients
 * whose 2nd installment landed while the global flag is still true (typical
 * June–July transition window).
 *
 * Identification of a "2nd installment paid" payment:
 *   - payments.status = 'Paid'
 *   - EITHER payments.installment = 'Installment 2 (Jun)' (the canonical value
 *     set by the installment helper)
 *   - OR payments.description ILIKE '%2nd installment%'
 *   - OR payments.description ILIKE '%second installment%'
 *   The OR branches cover legacy / manually-entered payments where the
 *   structured `installment` field is null (one historical case as of
 *   2026-04-18 — "Second Installment – LLC Consulting & Management").
 */

import { supabaseAdmin } from "@/lib/supabase-admin"

export interface ReactivationResult {
  scanned: number
  reactivated: number
  skipped: number
  errors: number
  details: Array<{
    sd_id: string
    account_id: string
    company_name: string | null
    action: "reactivated" | "skipped_no_payment" | "error"
    error_message?: string
  }>
}

/**
 * Scan all on_hold Tax Return SDs and flip the ones that have a confirmed
 * 2nd installment payment. Safe to run repeatedly — each flip is idempotent.
 *
 * @param accountIdFilter  if provided, scan only this account (used by the
 *                         synchronous `onSecondInstallmentPaid` path)
 */
export async function reactivateOnHoldTaxReturns(
  accountIdFilter?: string | null,
): Promise<ReactivationResult> {
  const result: ReactivationResult = {
    scanned: 0,
    reactivated: 0,
    skipped: 0,
    errors: 0,
    details: [],
  }

  let sdQuery = supabaseAdmin
    .from("service_deliveries")
    .select("id, account_id")
    .eq("service_type", "Tax Return")
    .eq("status", "on_hold")
    .not("account_id", "is", null)
    .limit(500)
  if (accountIdFilter) sdQuery = sdQuery.eq("account_id", accountIdFilter)

  const { data: sds, error: sdErr } = await sdQuery
  if (sdErr) throw new Error(`reactivateOnHoldTaxReturns: SD query failed — ${sdErr.message}`)

  result.scanned = sds?.length ?? 0
  if (!sds?.length) return result

  const accountIds = sds.map(s => s.account_id).filter((v): v is string => typeof v === "string")
  if (accountIds.length === 0) return result

  // Pull company_name for log lines + the full set of candidate payments in
  // one round-trip each (beats one-query-per-SD for a cron scanning ~200).
  const [{ data: accts }, { data: payments }] = await Promise.all([
    supabaseAdmin
      .from("accounts")
      .select("id, company_name")
      .in("id", accountIds),
    supabaseAdmin
      .from("payments")
      .select("id, account_id, status, installment, description, paid_date")
      .in("account_id", accountIds)
      .eq("status", "Paid")
      .limit(2000),
  ])

  const companyByAcct = new Map<string, string | null>()
  for (const a of accts ?? []) {
    if (a.id) companyByAcct.set(a.id, a.company_name ?? null)
  }

  const secondInstallmentByAcct = new Map<string, boolean>()
  for (const p of payments ?? []) {
    if (!p.account_id) continue
    const inst = typeof p.installment === "string" ? p.installment : ""
    const desc = typeof p.description === "string" ? p.description : ""
    const isSecond =
      inst === "Installment 2 (Jun)" ||
      /2nd\s+installment/i.test(desc) ||
      /second\s+installment/i.test(desc)
    if (isSecond) secondInstallmentByAcct.set(p.account_id, true)
  }

  for (const sd of sds) {
    if (!sd.account_id) continue
    const paid = secondInstallmentByAcct.get(sd.account_id) === true
    const companyName = companyByAcct.get(sd.account_id) ?? null

    if (!paid) {
      result.skipped++
      result.details.push({
        sd_id: sd.id,
        account_id: sd.account_id,
        company_name: companyName,
        action: "skipped_no_payment",
      })
      continue
    }

    // eslint-disable-next-line no-restricted-syntax -- deferred migration, dev_task 7ebb1e0c
    const { error: upErr } = await supabaseAdmin
      .from("service_deliveries")
      .update({ status: "active", updated_at: new Date().toISOString() })
      .eq("id", sd.id)
      .eq("status", "on_hold") // guard against races

    if (upErr) {
      result.errors++
      result.details.push({
        sd_id: sd.id,
        account_id: sd.account_id,
        company_name: companyName,
        action: "error",
        error_message: upErr.message,
      })
      continue
    }

    result.reactivated++
    result.details.push({
      sd_id: sd.id,
      account_id: sd.account_id,
      company_name: companyName,
      action: "reactivated",
    })
  }

  return result
}
