/**
 * The single rule for "is this activation effectively paid?" used by the
 * client-journey trackers.
 *
 * Why this exists: a service can be marked `activated` (activated_at set) while
 * `payment_confirmed_at` was never stamped — happened on legacy/manual
 * bank-transfer activations and on the diagnose-* admin fix routes that set
 * status directly, bypassing runActivation. The journey "Paid" step used to
 * read ONLY payment_confirmed_at, so those clients showed "Awaiting Payment"
 * forever despite being paid + activated (Michele Cotti, 2026-06-10).
 *
 * Rule: paid iff payment_confirmed_at is set, OR the service is activated and it
 * was NOT the deliberately payment-decoupled "Activate Now" path
 * (payment_method = 'none', which activates BEFORE payment for AR/dunning and
 * must keep showing "awaiting").
 *
 * runActivation now also stamps payment_confirmed_at at activation time under
 * the same rule, so going forward the data is correct at the source; this
 * predicate keeps the UI correct for historical rows + the direct-set paths.
 */
export interface ActivationPaidInput {
  payment_confirmed_at: string | null
  activated_at: string | null
  payment_method: string | null
}

/** The payment_method value that means "activated on purpose before payment". */
export const PAYMENT_DECOUPLED = "none"

export function isActivationEffectivelyPaid(
  a: ActivationPaidInput | null | undefined,
): boolean {
  if (!a) return false
  if (a.payment_confirmed_at) return true
  if (a.activated_at && a.payment_method !== PAYMENT_DECOUPLED) return true
  return false
}
