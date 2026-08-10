/**
 * Payment classification — the single, structured way to ask "what kind of
 * payment is this, and for which year?".
 *
 * RULE: billing / tax / audit logic must classify a payment ONLY via the
 * structured `payment_category` (+ `year`) stamp — NEVER by reading the
 * free-text `description`. The description wording was read exactly once, in the
 * backfill migration 20260529-0500-payment-category-structured-classification.sql,
 * to populate `payment_category`. From then on it is dead to classification.
 *
 * Why this exists: three call sites (the annual-installments cron, the tax
 * reactivation gate, and the billing-status audit) each independently grepped
 * `description.includes("second installment")` etc. The March-2026 import left
 * that wording inconsistent and the `installment` label blank on ~43% of rows,
 * so the grep was both fragile and silently wrong. This helper replaces all
 * three with one structured check.
 */

/** The known payment categories. Single code-side source of truth — kept in
 *  sync with the CHECK constraint on payments.payment_category. Adding a value
 *  = add it here + a one-line CHECK migration. */
export const PAYMENT_CATEGORIES = [
  'setup_fee',
  // A part of a setup fee paid in parts (WS-C item 2, offer payment plans).
  // ⛔ DELIBERATELY NOT installment_1/installment_2: paying an invoice categorised as those fires
  // the paid-installment handler, which lifts a client's ACCOUNTANT HAND-OFF GATE and advances
  // their tax card, and feeds the June cron and the instalment badge. A formation client paying
  // part two of a setup fee must trigger none of that. Client-facing wording is "Partial Payment"
  // — never "instalment", which belongs to the renewal contract.
  'setup_tranche',
  'installment_1',
  'installment_2',
  'annual_renewal',
  'one_time',
  'itin',
  'custom',
  'credit',
  'other',
  // Was MISSING from this list while both the database CHECK and live code used it —
  // found 2026-07-14 by the code↔database contract check, the first time anything had
  // compared this "single source of truth" against the constraint it claims to mirror.
  // The comment above promised the sync; nothing enforced it. Now registered in
  // scripts/check-db-constraints.ts, so the promise is a gate.
  'td_communication',
] as const

export type PaymentCategory = (typeof PAYMENT_CATEGORIES)[number]

/**
 * Map the human `payments.installment` label (payment_type_enum) to the
 * structured category, so every createTDInvoice caller that sets `installment`
 * also stamps `payment_category` automatically — no per-call-site change needed.
 * Returns null for labels with no category (caller may pass an explicit one).
 */
export function categoryFromInstallmentLabel(label: string | null | undefined): PaymentCategory | null {
  switch ((label || '').trim()) {
    case 'Setup Fee': return 'setup_fee'
    case 'Installment 1 (Jan)': return 'installment_1'
    case 'Installment 2 (Jun)': return 'installment_2'
    case 'Annual Payment': return 'annual_renewal'
    case 'One-Time Service':
    case 'One-Time':
    case 'One-time': return 'one_time'
    case 'ITIN': return 'itin'
    case 'Custom': return 'custom'
    default: return null
  }
}

/** The minimal shape any classifier needs. Callers select these columns. */
export interface ClassifiablePayment {
  payment_category: string | null
  year: number | null
  /** Optional lifecycle guards — a Cancelled row is never a live classification. */
  status?: string | null
  invoice_status?: string | null
}

/** A payment is "live" (counts for classification) when it is not cancelled by
 *  either the payment status or the invoice status. */
export function isLivePayment(p: ClassifiablePayment): boolean {
  return p.status !== 'Cancelled' && p.invoice_status !== 'Cancelled'
}

/** True if `value` is one of the known categories (runtime guard for raw DB text). */
export function isPaymentCategory(value: string | null | undefined): value is PaymentCategory {
  return value != null && (PAYMENT_CATEGORIES as readonly string[]).includes(value)
}

/**
 * Is this a live installment payment of ordinal `n` (1 or 2)?
 * Pass `opts.year` to scope to a specific billing year; omit it to match any
 * year (used by the reactivation gate, which is not year-scoped).
 */
export function isInstallment(
  p: ClassifiablePayment,
  n: 1 | 2,
  opts?: { year?: number },
): boolean {
  if (!isLivePayment(p)) return false
  const wanted: PaymentCategory = n === 1 ? 'installment_1' : 'installment_2'
  if (p.payment_category !== wanted) return false
  if (opts?.year != null && p.year !== opts.year) return false
  return true
}

/** Convenience: live first installment, optionally year-scoped. */
export function isFirstInstallment(p: ClassifiablePayment, year?: number): boolean {
  return isInstallment(p, 1, { year })
}

/** Convenience: live second installment, optionally year-scoped. */
export function isSecondInstallment(p: ClassifiablePayment, year?: number): boolean {
  return isInstallment(p, 2, { year })
}
