/**
 * Payment kind — the tag that keeps a non-client payment out of the client
 * sales machinery (TD Marketing job J-A, 2026-10-17).
 *
 * A Stripe Checkout Session we create for something that is NOT a client service
 * sale (today: a marketing payment link) carries `metadata.payment_kind`. The
 * Stripe webhook then skips every client-side effect for it: converting a CRM lead
 * (including the lookup by payer email), upgrading a portal tier, consuming a
 * pending activation (including the email fallback) and reconciling to an invoice
 * by number. Those effects belong to client purchases only.
 *
 * Rule: an ABSENT tag means a normal client payment (every checkout created
 * before this existed has no tag, and must behave exactly as before). A PRESENT
 * tag is default-deny: only the explicit value `service_sale` keeps the client
 * effects; any other value — including a typo or a future kind — blocks them.
 *
 * Whop payments carry no metadata at all, so a tag cannot travel on them; the
 * marketing flow is Stripe-only by decision (Antonio, 2026-10-17).
 */

export const PAYMENT_KIND_META_KEY = "payment_kind"

/** Explicitly a client service sale — keeps all client effects. */
export const PAYMENT_KIND_SERVICE_SALE = "service_sale"

/** A payment taken through the marketing workspace's payment link. */
export const PAYMENT_KIND_MARKETING = "marketing_sale"

/**
 * A paid strategy call, paid through a link created from the CRM lead page (incoming-payments Phase 2). Like every non-service kind it
 * keeps the client sales machinery out (no lead conversion, no tier, no activation), but the webhook then RECORDS it: the Paid
 * "Strategic Call" invoice + the deductible credit (lib/incoming-payments/confirm.ts `settlePayment`).
 */
export const PAYMENT_KIND_PAID_CALL = "paid_call"

type Meta = Record<string, string | null | undefined> | null | undefined

/** The raw tag value, trimmed; null when there is no tag. */
export function readPaymentKind(metadata: Meta): string | null {
  const raw = metadata?.[PAYMENT_KIND_META_KEY]
  if (typeof raw !== "string") return null
  const v = raw.trim()
  return v === "" ? null : v
}

/**
 * True when the payment must NOT touch client records (leads, portal tier,
 * pending activations, invoices). Absent tag → false (legacy client flow).
 */
export function isNonClientPayment(metadata: Meta): boolean {
  const kind = readPaymentKind(metadata)
  if (kind === null) return false
  return kind !== PAYMENT_KIND_SERVICE_SALE
}
