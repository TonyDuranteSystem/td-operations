/**
 * Onboarding account upgrade — applied during activate-service when an
 * existing-account onboarding offer is paid.
 *
 * Two side effects on `accounts`:
 *   1. Flip `account_type` from `One-Time` (or null) to `Client` when the
 *      offer carries an annual recurring component (`recurring_costs` has a
 *      1st installment). Without this, `tier-config.ts:ONE_TIME_EXCLUDED`
 *      keeps `billing/invoices/customers/deadlines/bankAccounts/taxDocuments/
 *      activity` hidden in the portal even after tier reaches `active`.
 *   2. Propagate the three financial components from the offer to the account:
 *        - Setup Fee   ← cost_summary[0].total
 *        - Installment 1 ← recurring_costs[label≈January].price
 *        - Installment 2 ← recurring_costs[label≈June].price
 *      These columns drive next year's renewal cron (`annual-installments`)
 *      and the audit panel display.
 *
 * Idempotency / safety rules:
 *   - account_type: only flip when current is `One-Time` or null. Never
 *     downgrade `Client` → anything. Re-running is a no-op.
 *   - setup_fee_amount / installment_*_amount columns: only write when the
 *     current column value is null. If a value was already on the account
 *     (set by the audit panel manually or a prior run), leave it. Re-running
 *     is a no-op.
 *
 * Why a separate lib helper:
 *   - Keeps activate-service's POST handler readable.
 *   - Lets the unit test mock supabaseAdmin once and verify each branch
 *     (flip / no-flip / no-recurring / setup-fee-only / already-Client /
 *     malformed JSON / mixed currency) without spinning up the whole route.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import { dbWriteSafe } from "@/lib/db"

// ─── Inputs ─────────────────────────────────────────────────────────────────

type CostSummarySection = {
  label?: string
  total?: string
  items?: Array<{ name?: string; price?: string }>
}

type RecurringCost = {
  label?: string
  price?: string
  currency?: string
}

export interface OfferShape {
  /** The offer's contract_type ('onboarding' | 'formation' | …). Only `onboarding` triggers this helper. */
  contract_type: string | null
  /** offers.cost_summary — JSONB array of sections. Setup Fee section drives setup_fee_*. */
  cost_summary: unknown
  /** offers.recurring_costs — JSONB array of installment + total rows. */
  recurring_costs: unknown
}

export interface ApplyResult {
  /** Whether the helper actually attempted any write (false when not an onboarding offer). */
  applied: boolean
  /** account_type before the function ran. */
  account_type_before: string | null
  /** account_type after the function ran. */
  account_type_after: string | null
  /** True when the helper changed account_type. */
  account_type_flipped: boolean
  /** setup_fee_amount written to accounts (only when previous was null). */
  setup_fee_written: { amount: number; currency: "USD" | "EUR" } | null
  /** installment_1_amount written. */
  installment_1_written: { amount: number; currency: "USD" | "EUR" } | null
  /** installment_2_amount written. */
  installment_2_written: { amount: number; currency: "USD" | "EUR" } | null
  /** Non-fatal reasons something was skipped (parse failure, value already set, etc.). */
  notes: string[]
}

// ─── Currency / amount parsers ──────────────────────────────────────────────

/**
 * Parse a price string like "$1,500", "€3,800", "$1000", or "USD 2,500" into
 * { amount, currency }. Returns null when the string has no parseable number.
 *
 * Currency detection priority: explicit `$` / `€` symbol first, then ISO
 * substring (`USD` / `EUR`). Defaults to `USD` if none detected — same
 * convention as `app/offer/[token]/contract/service-agreement.tsx:198-201`
 * and `app/api/webhooks/offer-signed/route.ts:87-89`.
 */
export function parsePrice(raw: unknown): { amount: number; currency: "USD" | "EUR" } | null {
  if (raw == null) return null
  const s = String(raw).trim()
  if (!s) return null

  // Strip everything except digits and periods (commas treated as thousands
  // separators). This matches the existing parsing convention in the offer
  // contract page and the offer-signed webhook.
  const digits = s.replace(/[^0-9.]/g, "")
  if (!digits) return null
  const amount = parseFloat(digits)
  if (!Number.isFinite(amount) || amount <= 0) return null

  const upper = s.toUpperCase()
  let currency: "USD" | "EUR" = "USD"
  if (s.includes("€") || /\bEUR\b|EURO/.test(upper)) currency = "EUR"
  else if (s.includes("$") || /\bUSD\b/.test(upper)) currency = "USD"

  return { amount, currency }
}

/**
 * Find a recurring_costs entry whose label looks like the given installment
 * marker. Skips the "Annual Total" / "Annuale" summary line.
 *
 * Markers supported: 'jan' | 'jun'.
 *   - 'jan' matches "1st Installment", "January", "Genn(aio)" labels
 *   - 'jun' matches "2nd Installment", "June", "Giugno" labels
 */
export function findInstallment(
  rows: unknown,
  marker: "jan" | "jun",
): RecurringCost | null {
  if (!Array.isArray(rows)) return null
  const totalRegex = /annual\s*total|annuale|^total$/i
  const janRegex = /\b(1st|first)\s*installment|january|gennaio|\bjan\b|\bgen\b/i
  const junRegex = /\b(2nd|second)\s*installment|june|giugno|\bjun\b/i
  const matchRegex = marker === "jan" ? janRegex : junRegex

  for (const row of rows as RecurringCost[]) {
    const label = String(row?.label || "")
    if (totalRegex.test(label)) continue
    if (matchRegex.test(label)) return row
  }
  return null
}

/** Find the Setup Fee section in cost_summary. */
export function findSetupFeeSection(rows: unknown): CostSummarySection | null {
  if (!Array.isArray(rows)) return null
  for (const row of rows as CostSummarySection[]) {
    const label = String(row?.label || "")
    if (/setup\s*fee/i.test(label)) return row
  }
  // Fallback: first section's total (legacy offers without the explicit Setup Fee label)
  const arr = rows as CostSummarySection[]
  if (arr.length > 0 && arr[0]?.total) return arr[0]
  return null
}

// ─── Main ───────────────────────────────────────────────────────────────────

/**
 * Apply the onboarding-payment account upgrades.
 *
 * Caller is responsible for making sure `contract_type === 'onboarding'` and
 * `accountId` is set. This function silently no-ops (returns applied=false)
 * for any other case so callers can route through it unconditionally without
 * extra branching.
 */
export async function applyOnboardingAccountUpgrades(params: {
  accountId: string
  offer: OfferShape
  /** Optional caller name for the action_log entry. Defaults to 'activate-service'. */
  actor?: string
}): Promise<ApplyResult> {
  const { accountId, offer, actor = "activate-service" } = params
  const result: ApplyResult = {
    applied: false,
    account_type_before: null,
    account_type_after: null,
    account_type_flipped: false,
    setup_fee_written: null,
    installment_1_written: null,
    installment_2_written: null,
    notes: [],
  }

  if (offer.contract_type !== "onboarding") {
    result.notes.push(`skipped: contract_type='${offer.contract_type}' (only 'onboarding' triggers this helper)`)
    return result
  }
  if (!accountId) {
    result.notes.push("skipped: no accountId provided")
    return result
  }

  // Read current account state. Bail if account doesn't exist (caller should
  // have already validated, but defensive).
  const { data: account, error: readErr } = await supabaseAdmin
    .from("accounts")
    .select(
      "id, account_type, setup_fee_amount, setup_fee_currency, installment_1_amount, installment_1_currency, installment_2_amount, installment_2_currency",
    )
    .eq("id", accountId)
    .single()

  if (readErr || !account) {
    result.notes.push(`error: account not found: ${readErr?.message || "unknown"}`)
    return result
  }

  result.account_type_before = (account.account_type as string | null) ?? null
  result.account_type_after = result.account_type_before
  result.applied = true

  // Build the patch. Only write each field when its current value is null —
  // never overwrite a manually-set value or a prior-run write.
  const patch: Record<string, unknown> = {}

  // ── Installments — drive the account_type flip decision ────────────────
  const installment1 = findInstallment(offer.recurring_costs, "jan")
  const installment2 = findInstallment(offer.recurring_costs, "jun")

  let i1Parsed: { amount: number; currency: "USD" | "EUR" } | null = null
  if (installment1) {
    i1Parsed = parsePrice(installment1.price)
    if (!i1Parsed) result.notes.push(`installment_1: could not parse price '${String(installment1.price)}'`)
    // Currency from the entry takes precedence over what parsePrice inferred.
    if (i1Parsed && installment1.currency) {
      const c = String(installment1.currency).toUpperCase()
      if (c === "USD" || c === "EUR") i1Parsed.currency = c
    }
  } else {
    result.notes.push("installment_1: not found in recurring_costs")
  }

  let i2Parsed: { amount: number; currency: "USD" | "EUR" } | null = null
  if (installment2) {
    i2Parsed = parsePrice(installment2.price)
    if (!i2Parsed) result.notes.push(`installment_2: could not parse price '${String(installment2.price)}'`)
    if (i2Parsed && installment2.currency) {
      const c = String(installment2.currency).toUpperCase()
      if (c === "USD" || c === "EUR") i2Parsed.currency = c
    }
  } else {
    result.notes.push("installment_2: not found in recurring_costs")
  }

  if (i1Parsed && account.installment_1_amount == null) {
    patch.installment_1_amount = i1Parsed.amount
    patch.installment_1_currency = i1Parsed.currency
    result.installment_1_written = i1Parsed
  } else if (i1Parsed && account.installment_1_amount != null) {
    result.notes.push(`installment_1: skipped (already set to ${account.installment_1_amount} ${account.installment_1_currency})`)
  }

  if (i2Parsed && account.installment_2_amount == null) {
    patch.installment_2_amount = i2Parsed.amount
    patch.installment_2_currency = i2Parsed.currency
    result.installment_2_written = i2Parsed
  } else if (i2Parsed && account.installment_2_amount != null) {
    result.notes.push(`installment_2: skipped (already set to ${account.installment_2_amount} ${account.installment_2_currency})`)
  }

  // ── Setup fee ───────────────────────────────────────────────────────────
  const setupSection = findSetupFeeSection(offer.cost_summary)
  let setupParsed: { amount: number; currency: "USD" | "EUR" } | null = null
  if (setupSection?.total) {
    setupParsed = parsePrice(setupSection.total)
    if (!setupParsed) result.notes.push(`setup_fee: could not parse total '${String(setupSection.total)}'`)
  } else {
    result.notes.push("setup_fee: no Setup Fee section found in cost_summary")
  }

  if (setupParsed && account.setup_fee_amount == null) {
    patch.setup_fee_amount = setupParsed.amount
    patch.setup_fee_currency = setupParsed.currency
    result.setup_fee_written = setupParsed
  } else if (setupParsed && account.setup_fee_amount != null) {
    result.notes.push(`setup_fee: skipped (already set to ${account.setup_fee_amount} ${account.setup_fee_currency})`)
  }

  // ── account_type flip ───────────────────────────────────────────────────
  // Rule: flip to 'Client' only when (a) the current value is 'One-Time' or
  // null, AND (b) the offer carries an annual recurring component (we found
  // at least one installment row that parsed). A pure setup-fee one-shot
  // stays at 'One-Time'.
  const hasRecurring = !!(i1Parsed || i2Parsed)
  const currentIsOneTime = result.account_type_before === "One-Time" || result.account_type_before == null

  if (hasRecurring && currentIsOneTime) {
    patch.account_type = "Client"
    result.account_type_after = "Client"
    result.account_type_flipped = true
  } else if (!hasRecurring) {
    result.notes.push("account_type: not flipped — offer has no parseable recurring installments")
  } else if (!currentIsOneTime) {
    result.notes.push(`account_type: not flipped — current is '${result.account_type_before}' (only One-Time/null is upgraded)`)
  }

  // ── Persist ─────────────────────────────────────────────────────────────
  if (Object.keys(patch).length === 0) {
    return result
  }
  patch.updated_at = new Date().toISOString()

  const { error: updErr } = await dbWriteSafe(
    supabaseAdmin.from("accounts").update(patch).eq("id", accountId),
    "accounts.update",
  )
  if (updErr) {
    result.notes.push(`error: accounts.update failed: ${updErr}`)
    // Roll back the optimistic flags so the caller knows nothing landed.
    result.account_type_after = result.account_type_before
    result.account_type_flipped = false
    result.setup_fee_written = null
    result.installment_1_written = null
    result.installment_2_written = null
    return result
  }

  // Action log entry — surfaces in CRM activity feed.
  await dbWriteSafe(
    supabaseAdmin.from("action_log").insert({
      actor,
      action_type: "onboarding_account_upgrade",
      table_name: "accounts",
      record_id: accountId,
      account_id: accountId,
      summary: [
        result.account_type_flipped
          ? `account_type ${result.account_type_before ?? "null"} → Client`
          : null,
        result.setup_fee_written
          ? `setup_fee=${result.setup_fee_written.amount} ${result.setup_fee_written.currency}`
          : null,
        result.installment_1_written
          ? `installment_1=${result.installment_1_written.amount} ${result.installment_1_written.currency}`
          : null,
        result.installment_2_written
          ? `installment_2=${result.installment_2_written.amount} ${result.installment_2_written.currency}`
          : null,
      ].filter(Boolean).join(", ") || "no changes",
      details: {
        account_type_before: result.account_type_before,
        account_type_after: result.account_type_after,
        account_type_flipped: result.account_type_flipped,
        setup_fee_written: result.setup_fee_written,
        installment_1_written: result.installment_1_written,
        installment_2_written: result.installment_2_written,
        notes: result.notes,
      },
    }),
    "action_log.insert",
  )

  return result
}
