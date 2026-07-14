/**
 * Which services a client may actually be billed for.
 *
 * WHY THIS EXISTS (2026-07-14, dev_task ba7bfd8d — found in adversarial review):
 * `POST /api/offers/create-checkout` is a PUBLIC route — token-only, no session.
 * It accepted `selected_services` from the REQUEST BODY and let it override the
 * selection stored on the offer. So a client who had already SIGNED for, say, a
 * €1,500 optional add-on could call the endpoint directly with
 * `{ selected_services: [] }` and be charged for only the required services —
 * while their signed contract and the CRM invoice still said the full amount.
 *
 * Disabling the checkboxes in the UI closes nothing: the endpoint is callable
 * without the UI at all.
 *
 * The rule: **once an offer is signed, the stored selection IS the contract.**
 * It is the only thing we will bill, and no request body may change it. The body
 * is honoured ONLY before signing, while the client is still choosing.
 */

/** Offer statuses in which the selection is contractually fixed. */
const LOCKED_STATUSES = new Set(['signed', 'completed'])

export function isSelectionLocked(status: string | null | undefined): boolean {
  return LOCKED_STATUSES.has(String(status ?? '').toLowerCase())
}

export function resolveBillableSelection(input: {
  /** offers.status */
  status: string | null | undefined
  /** offers.selected_services — what the client actually signed for. */
  storedSelection: unknown
  /** selected_services from the request body — UNTRUSTED. */
  requestedSelection: unknown
}): string[] {
  const stored = toNameList(input.storedSelection)

  // Signed → the contract wins, always. The body is ignored entirely.
  // No stored selection means no optional add-ons were chosen — bill the required
  // services only. Never fall back to the body here: that is the hole itself.
  if (isSelectionLocked(input.status)) return stored ?? []

  // Not signed yet → the client is still choosing, so the body is legitimate.
  const requested = toNameList(input.requestedSelection)
  return requested ?? stored ?? []
}

/** null when absent (so callers can distinguish "not sent" from "sent empty"). */
function toNameList(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null
  return v.filter((x): x is string => typeof x === 'string')
}
