/**
 * Derive the HEADLINE display status for a lead detail view.
 *
 * Why this exists: a lead carries three independent statuses that each tell a
 * different part of the story — the sales-funnel `leads.status` (intentionally
 * frozen at e.g. "Offer Sent" until payment, per R094), the document
 * `offers.status` ("signed"), and the `pending_activations.status`
 * ("awaiting_payment"). The lead page headline historically showed only the
 * funnel status, so a client who had SIGNED still read "Offer Sent".
 *
 * This helper reconciles them into ONE honest headline label WITHOUT mutating
 * `leads.status` (which must stay untouched to preserve R094 + the Confirm-
 * Payment flow). It is pure/derive-only — no DB writes.
 *
 * Contract:
 * - Terminal / decided funnel states (Converted / Lost / Suspended) always win
 *   and pass through unchanged.
 * - Otherwise, when the offer is signed but payment is NOT yet confirmed, the
 *   headline becomes "Signed — awaiting payment" (a DERIVED overlay).
 * - Otherwise the raw funnel status passes through (Offer Sent / Viewed / New …).
 *
 * `derived` lets the caller decide styling: derived overlays get their own
 * color; pass-through labels reuse the page's existing status-color map.
 */

export interface LeadDisplayStatusInput {
  /** leads.status (sales funnel) */
  leadStatus: string | null
  /** offers.status for the active offer */
  offerStatus: string | null
  /** pending_activations.status, if any */
  activationStatus: string | null
  /** pending_activations.payment_confirmed_at, if any */
  paymentConfirmedAt: string | null
}

export interface LeadDisplayStatus {
  /** Label to show in the headline chip. */
  label: string
  /** True when this is a reconciled overlay (not the raw leads.status). */
  derived: boolean
}

const TERMINAL_FUNNEL_STATES = new Set(['Converted', 'Lost', 'Suspended'])
const SIGNED_OFFER_STATES = new Set(['signed', 'completed'])
const PAID_ACTIVATION_STATES = new Set(['activated', 'payment_confirmed'])

export const SIGNED_AWAITING_PAYMENT_LABEL = 'Signed — awaiting payment'

export function deriveLeadDisplayStatus(input: LeadDisplayStatusInput): LeadDisplayStatus {
  const { leadStatus, offerStatus, activationStatus, paymentConfirmedAt } = input

  // Decided funnel states always win — never overlay over them.
  if (leadStatus && TERMINAL_FUNNEL_STATES.has(leadStatus)) {
    return { label: leadStatus, derived: false }
  }

  const isSigned = !!offerStatus && SIGNED_OFFER_STATES.has(offerStatus)
  const isPaid =
    !!paymentConfirmedAt ||
    (!!activationStatus && PAID_ACTIVATION_STATES.has(activationStatus))

  if (isSigned && !isPaid) {
    return { label: SIGNED_AWAITING_PAYMENT_LABEL, derived: true }
  }

  // Pass through the raw funnel status (Offer Sent / Viewed / New / …).
  return { label: leadStatus ?? '—', derived: false }
}
