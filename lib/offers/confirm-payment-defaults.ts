/**
 * The currency the Confirm Payment dialog pre-selects for an offer.
 *
 * EXPLICIT WINS: a currency recorded on the offer (offers.currency) is a decision
 * someone made — it is what the money engine, the card checkout and the invoice
 * use, so the dialog must agree with it. Before this the dialog only looked at the
 * price text, so an offer whose signed contract says "€450" but whose invoice was
 * corrected to USD (International Automobile Authority LLC, 2026-10-16) pre-selected
 * EUR and would have stamped the activation record "EUR 450" against a $450 invoice.
 *
 * Only for offers with no recorded currency does it fall back to reading the price
 * text, exactly as the dialog always did: a "$" in any section total → USD, else EUR.
 */
export function confirmPaymentCurrency(
  explicit: string | null | undefined,
  costSummary: Array<{ total?: string }> | null | undefined,
): 'USD' | 'EUR' {
  const e = String(explicit ?? '').trim().toUpperCase()
  if (e === 'USD' || e === 'EUR') return e
  if (!Array.isArray(costSummary)) return 'EUR'
  for (const section of costSummary) {
    if (section?.total && section.total.includes('$')) return 'USD'
  }
  return 'EUR'
}
