/**
 * Which person a typed / saved payer hangs on, for an invoice that has NO person of its own (dev job e62bc2b6, bug-hunter
 * follow-up). The Bill to dialog (which payers it lists), the save (which person the payer is attached to) and the options
 * route all use THIS one pick, so they can never disagree with each other — and it is the same answer on every call.
 *
 * Ranking: an owner-role contact first (case-insensitive, like every other role check), then the company's primary contact,
 * then the lowest contact id — so a tie never depends on the order the database happens to return rows in.
 *
 * NOT used for who RECEIVES the invoice email: that is lib/portal/resolve-payment-recipient.ts and the pin in
 * lib/operations/invoice-bill-to.ts deliberately mirrors it (changing it would change who gets live invoice emails).
 */
export interface PayerPersonLink {
  contact_id: string
  role: string | null
  is_primary?: boolean | null
}

export function pickPayerPerson(links: PayerPersonLink[]): string | null {
  if (links.length === 0) return null
  const rank = (l: PayerPersonLink) => (l.role?.toLowerCase().includes("owner") ? 0 : 2) + (l.is_primary ? 0 : 1)
  const sorted = [...links].sort((a, b) => rank(a) - rank(b) || a.contact_id.localeCompare(b.contact_id))
  return sorted[0].contact_id
}
