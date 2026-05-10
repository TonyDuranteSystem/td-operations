/**
 * Partner payout calculator — pure functions.
 *
 * Phase 3B. Called from activate-service Step 3.6 when an offer with
 * partner_id and partner_payout_model != 'none' has its payment confirmed.
 *
 * Design principle (per Phase 3 spec): the transaction is the source of
 * truth, not the partner type. The caller passes in the per-transaction
 * model + rate (after the per-txn overrides have already collapsed onto
 * the partner defaults), this helper just does the math.
 */

export type PayoutModel = "none" | "price_difference" | "percentage" | "flat_fee" | "credit_note"

export interface PayoutInput {
  model: PayoutModel
  /**
   * Rate semantics depend on the model:
   *   - percentage  → fraction (0.10 = 10%); decimals like 10 are also accepted and divided by 100 if > 1
   *   - flat_fee    → absolute amount in EUR
   *   - credit_note → absolute amount in EUR (added to next partner invoice)
   *   - price_difference / none → ignored
   */
  rate: number | null
  /**
   * Confirmed payment amount in EUR. If the offer's currency is USD and
   * commissions are tracked in EUR, the caller is responsible for FX
   * conversion before invoking this helper.
   */
  paymentAmount: number
  /**
   * TD base cost (EUR) for the service that was paid. Required for the
   * `price_difference` model; ignored for the others. Read from
   * client_partners.td_base_costs[service_slug] by the caller.
   */
  tdBaseCost?: number | null
}

export interface PayoutResult {
  /** EUR amount the partner is owed for this transaction. null = cannot compute. */
  amount: number | null
  /** Echo of the model used; convenient for the DB write. */
  model: PayoutModel
  /**
   * Reason the amount could not be computed. Caller should write
   * status='manual_review' (or skip) when this is set.
   */
  error?: "missing_base_cost" | "missing_rate" | "negative_result" | "model_none"
  /** Optional human-readable note for the action_log entry. */
  note?: string
}

/**
 * Calculate the partner payout for a single confirmed payment.
 *
 * All amounts are EUR. All inputs that may be null (rate, tdBaseCost) are
 * tolerated — the function returns a PayoutResult with `error` set instead
 * of throwing, so the caller can decide whether to skip the row, write it
 * with status='manual_review', or alert.
 */
export function calculatePartnerPayout(input: PayoutInput): PayoutResult {
  const { model } = input

  if (model === "none") {
    return { amount: null, model, error: "model_none", note: "Partner payout model is 'none' — no payout" }
  }

  // Defensive: payment <=0 is meaningless for a payout.
  if (!(input.paymentAmount > 0)) {
    return { amount: 0, model, note: "Payment amount is zero or negative — payout is 0" }
  }

  if (model === "price_difference") {
    if (input.tdBaseCost == null) {
      return { amount: null, model, error: "missing_base_cost", note: "td_base_costs[service] is missing — manual review required" }
    }
    const diff = round2(input.paymentAmount - input.tdBaseCost)
    if (diff < 0) {
      return { amount: 0, model, error: "negative_result", note: `Payment ${input.paymentAmount} < TD base cost ${input.tdBaseCost} — payout clamped to 0` }
    }
    return { amount: diff, model, note: `${input.paymentAmount} − ${input.tdBaseCost} = ${diff}` }
  }

  // percentage / flat_fee / credit_note all need a rate.
  if (input.rate == null) {
    return { amount: null, model, error: "missing_rate", note: `Rate is required for model '${model}'` }
  }

  if (model === "percentage") {
    // Accept either fraction (0.10) or whole-number percent (10) — auto-detect.
    const fraction = input.rate > 1 ? input.rate / 100 : input.rate
    if (fraction < 0) {
      return { amount: 0, model, error: "negative_result", note: "Negative rate — payout clamped to 0" }
    }
    const amount = round2(input.paymentAmount * fraction)
    return { amount, model, note: `${input.paymentAmount} × ${fraction} = ${amount}` }
  }

  if (model === "flat_fee" || model === "credit_note") {
    const amount = round2(input.rate)
    if (amount < 0) {
      return { amount: 0, model, error: "negative_result", note: "Negative rate — payout clamped to 0" }
    }
    return { amount, model, note: `Flat ${model === "credit_note" ? "credit" : "fee"}: ${amount}` }
  }

  // exhaustive
  const _exhaustive: never = model
  return { amount: null, model: _exhaustive, error: "model_none", note: `Unknown model: ${String(_exhaustive)}` }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}
