/**
 * Has the client actually PAID this offer?
 *
 * Antonio's rule (2026-09-27): a tax return sold on a PAID offer is paid,
 * whatever its price. Place Client and the onboarding setup look at the
 * client's newest offer, which can still be only sent or viewed — counting
 * that as paid marked an unpaid tax return "Paid - Not Started"
 * (bug-hunter, S1 merge review, 2026-09-29).
 *
 * Paid = the offer is completed, OR its activation record shows the payment
 * was confirmed (payment_confirmed_at set, or status payment_confirmed /
 * activated). A signed offer still awaiting payment is NOT paid.
 */
export function offerCountsAsPaid(p: {
  offerStatus: string | null | undefined
  activationStatus?: string | null
  paymentConfirmedAt?: string | null
}): boolean {
  if (String(p.offerStatus ?? "").toLowerCase() === "completed") return true
  if (p.paymentConfirmedAt) return true
  const a = String(p.activationStatus ?? "").toLowerCase()
  return a === "payment_confirmed" || a === "activated"
}
