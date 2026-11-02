// The wording Antonio can choose for an offer's invoice (dev job 6fc63c52 follow-up, 2026-11-02: "besides the 'invoice to' I want
// to add the description for the invoice"). Optional: empty = the automatic text ("<services> - <client name>"), so nothing
// changes for any offer that does not use it. Stored on the offer as `invoice_description`; the invoice shows exactly what was
// typed (on a payment plan each part keeps its own "Partial Payment (part N of M)" tail after it).
// Pure: no database access.

export const INVOICE_DESCRIPTION_MAX = 200

/** Validate what staff typed. Empty / blank = not set (null). Line breaks become spaces, runs of spaces collapse. */
export function parseInvoiceDescription(raw: unknown): { value: string | null; error?: undefined } | { value?: undefined; error: string } {
  if (raw === null || raw === undefined) return { value: null }
  if (typeof raw !== 'string') return { error: 'Invoice description: must be text' }
  // eslint-disable-next-line no-control-regex
  const cleaned = raw.replace(/[\r\n\t]+/g, ' ').replace(/[\u0000-\u001f\u007f]/g, '').replace(/ {2,}/g, ' ').trim()
  if (!cleaned) return { value: null }
  if (cleaned.length > INVOICE_DESCRIPTION_MAX) return { error: `Invoice description: at most ${INVOICE_DESCRIPTION_MAX} characters (now ${cleaned.length})` }
  return { value: cleaned }
}

/** Read side: the saved wording of an offer row, or null to use the automatic text. Never throws. */
export function chosenInvoiceDescription(offer: { invoice_description?: unknown } | null | undefined): string | null {
  const v = offer?.invoice_description
  return typeof v === 'string' && v.trim() ? v.trim() : null
}
