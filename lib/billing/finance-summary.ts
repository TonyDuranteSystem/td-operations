/**
 * Pure invoice summary for the account/contact "Finance" overview card
 * (dev job 10995181 follow-up). Mirrors the exact Overdue/Pending/Paid
 * classification already used by the account Payments tab and contact
 * Invoices tab (components/accounts/account-detail.tsx's PagamentiTab) —
 * deliberately NOT extracted into a shared function those tabs also call,
 * matching this codebase's existing convention of independently duplicating
 * this classification per surface rather than introducing a dependency
 * between them. Keep this logic in sync by hand if that classification ever
 * changes.
 */
/**
 * Structural subset of the fields the classification actually reads — matches
 * both lib/types.ts's Payment (account page) and contact-detail.tsx's local
 * ContactInvoice (contact page) without either needing to import the other.
 */
export interface InvoiceLike {
  invoice_number: string | null
  invoice_status: string | null
  status: string | null
  due_date: string | null
  total: number | null
  amount_due: number | null
  amount: number
  amount_currency: string | null
}

export interface FinanceSummary {
  outstandingCount: number
  outstandingTotal: number
  overdueCount: number
  paidCount: number
  paidTotal: number
  currency: string
}

export function summarizeInvoicesForFinanceCard(payments: InvoiceLike[], today: string): FinanceSummary {
  const invoiced = payments.filter(
    (p) => p.invoice_number && p.invoice_number !== "1.0" && p.invoice_number !== "2.0",
  )
  const invoiceStatus = (p: InvoiceLike) => p.invoice_status ?? p.status ?? ""

  const overdue = invoiced.filter(
    (p) => invoiceStatus(p) === "Overdue" || (invoiceStatus(p) === "Sent" && !!p.due_date && p.due_date < today),
  )
  const pending = invoiced.filter(
    (p) => ["Sent", "Draft", "Partial"].includes(invoiceStatus(p)) && !(p.due_date && p.due_date < today),
  )
  const paid = invoiced.filter((p) => invoiceStatus(p) === "Paid")
  const outstanding = [...overdue, ...pending]

  const sum = (rows: InvoiceLike[]) => rows.reduce((s, p) => s + (Number(p.total) || p.amount_due || p.amount || 0), 0)
  const currency = invoiced[0]?.amount_currency || "USD"

  return {
    outstandingCount: outstanding.length,
    outstandingTotal: sum(outstanding),
    overdueCount: overdue.length,
    paidCount: paid.length,
    paidTotal: sum(paid),
    currency,
  }
}
