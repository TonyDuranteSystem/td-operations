/**
 * Resolve the display name of the party an invoice belongs to.
 *
 * An invoice is normally linked to an account (the company), but formation
 * clients pay as an individual *before* their LLC exists — in that window the
 * invoice is contact-scoped (account_id null, contact_id set). The bank-feed
 * matching screens must show the person's name in that case so staff can
 * recognise and link the payment, instead of a blank company column.
 *
 * Priority: company name → contact full name → '—'.
 *
 * PostgREST embeds arrive as either a single object or a one-element array
 * depending on the relationship's inferred cardinality, so both shapes are
 * handled defensively.
 */
type Embedded<T> = T | T[] | null | undefined

function unwrap<T>(value: Embedded<T>): T | undefined {
  return Array.isArray(value) ? value[0] : value ?? undefined
}

export function invoicePartyName(inv: {
  accounts?: Embedded<{ company_name?: string | null }>
  contacts?: Embedded<{ full_name?: string | null }>
}): string {
  const company = unwrap(inv.accounts)?.company_name?.trim()
  if (company) return company
  const contactName = unwrap(inv.contacts)?.full_name?.trim()
  return contactName || '—'
}
