/**
 * What a person needs to see, next to each invoice in the Bank Feed's "more than one invoice
 * fits this payment" box, to choose without leaving the screen (Antonio, 2026-10-29: "I have to
 * go back and forth from invoices to check what invoice is what").
 *
 * The box is built from a snapshot written when the matcher parked the transaction, and that
 * snapshot only carries the invoice number and the client name. These details are therefore read
 * LIVE from the invoices when the page loads, so they also work for rows parked before this
 * existed and always show the invoice's current state. EVERY tied invoice stays listed — nothing
 * is hidden or reordered by what is shown here.
 */
import { readContestedCandidates } from "@/lib/finance/feed-vocabulary"
import { isPaidInvoice } from "@/lib/finance/invoice-matchability"

export interface ContestedInvoiceDetail {
  id: string
  description: string | null
  installment: string | null
  total: number | null
  currency: string | null
  /** Already-Paid, from the same both-columns rule the matcher uses. */
  paid: boolean
  paid_date: string | null
  /** The invoice's own status word, shown when it is not Paid (Sent, Overdue, Partial, ...). */
  status_label: string | null
}

export interface ContestedInvoiceRow {
  id: string
  description?: string | null
  installment?: string | null
  total?: number | string | null
  amount?: number | string | null
  amount_currency?: string | null
  invoice_status?: string | null
  status?: string | null
  paid_date?: string | null
}

/** Every distinct invoice id named in any tied set on the given feed rows. */
export function contestedPaymentIds(feeds: ReadonlyArray<{ review_metadata?: unknown }>): string[] {
  const ids = new Set<string>()
  for (const feed of feeds) {
    for (const c of readContestedCandidates(feed.review_metadata)) ids.add(c.payment_id)
  }
  return Array.from(ids)
}

function toNumber(value: number | string | null | undefined): number | null {
  if (value == null) return null
  const n = typeof value === "string" ? parseFloat(value) : value
  return Number.isFinite(n) ? n : null
}

export function toContestedInvoiceDetail(row: ContestedInvoiceRow): ContestedInvoiceDetail {
  const paid = isPaidInvoice({ invoice_status: row.invoice_status ?? null, status: row.status ?? null })
  return {
    id: row.id,
    description: row.description?.trim() || null,
    installment: row.installment?.trim() || null,
    total: toNumber(row.total) ?? toNumber(row.amount),
    currency: row.amount_currency ?? null,
    paid,
    paid_date: row.paid_date ? String(row.paid_date).slice(0, 10) : null,
    status_label: paid ? null : (row.invoice_status?.trim() || row.status?.trim() || null),
  }
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]

/** 'YYYY-MM-DD' (or a longer timestamp) -> 'Sep 4, 2026'. Read as a calendar date, no timezone shift. */
export function formatCalendarDate(value: string | null | undefined): string | null {
  if (!value) return null
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(value)
  if (!m) return null
  const month = Number(m[2])
  if (month < 1 || month > 12) return null
  return `${MONTHS[month - 1]} ${Number(m[3])}, ${m[1]}`
}

export function formatDetailAmount(total: number | null, currency: string | null): string | null {
  if (total == null) return null
  const symbol = currency === "EUR" ? "€" : "$"
  return `${symbol}${total.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

/** The three short facts shown under an invoice number. Any of them may be null (not shown). */
export function contestedInvoiceFacts(detail: ContestedInvoiceDetail): {
  what: string | null
  amount: string | null
  state: string
} {
  const paidOn = formatCalendarDate(detail.paid_date)
  const state = detail.paid
    ? paidOn
      ? `paid ${paidOn}`
      : "paid (no date recorded)"
    : (detail.status_label ?? "not paid yet")
  return {
    what: detail.description ?? detail.installment,
    amount: formatDetailAmount(detail.total, detail.currency),
    state,
  }
}
