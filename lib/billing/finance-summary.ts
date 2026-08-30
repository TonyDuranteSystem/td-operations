/**
 * Pure invoice summary for the account/contact "Finance" overview card
 * (dev job 10995181 follow-up). Unlike the account Payments tab / contact
 * Invoices tab this mirrors the SHAPE of (Overdue/Pending/Paid), this rolls
 * every invoice into ONE headline "Outstanding" figure — so unlike those
 * tabs (which show each status section separately with its own subtotal,
 * making an ambiguous or credit row merely visible-but-separate) this one
 * cannot afford to silently drop a row or lump a credit into a receivable
 * total. Fixed post-council-review (2026-08-30, dev job 10995181, full
 * council pass — 9 reviewers, 3 System Counselor MISMATCH-STOPs) against
 * three real defects: (1) a Draft/Partial invoice past due matched neither
 * the overdue nor pending filter and vanished from Outstanding entirely —
 * fixed by defaulting to "outstanding unless known-settled" instead of an
 * exhaustive positive status list; (2) a partially-paid invoice was summed
 * at its full original total instead of the remaining balance; (3) a credit
 * note (money owed BACK to the client) was counted as a receivable. Also:
 * credit notes for a split/installment-plan invoice are not necessarily
 * issued right away (Antonio, 2026-08-30) — excluding by the CN- number
 * prefix (assigned at creation) rather than by invoice_status='Credit'
 * (assigned in a later, separate step) closes that gap too. (4) The overdue/
 * settled classification now comes from the SAME shared helper the account
 * Payments tab and contact Invoices tab use (lib/billing/invoice-status.ts)
 * instead of a fourth independently-typed copy of the same rule. (5) Test
 * fixture invoices (`is_test`) no longer inflate a real client's totals.
 */
import { invoiceStatusOf, isInvoiceOverdue, isInvoiceSettled } from "./invoice-status"

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
  amount_paid: number | null
  amount: number
  amount_currency: string | null
  is_test?: boolean | null
}

export interface CurrencyFinanceSummary {
  currency: string
  outstandingCount: number
  outstandingTotal: number
  overdueCount: number
  paidCount: number
  paidTotal: number
}

export interface FinanceSummary {
  /** One entry per currency present in the invoice set — almost always
   *  length 1. Sorted alphabetically (not "whichever invoice loaded first")
   *  so the result is deterministic regardless of query order. */
  byCurrency: CurrencyFinanceSummary[]
}

// A credit note is money TD owes the client, never a receivable. Checked by
// number prefix (assigned at creation, before any status transition) rather
// than solely by invoice_status='Credit' (assigned in a separate, sometimes
// delayed, follow-up step) so a not-yet-retagged credit note is still
// excluded — see the file header note on split/installment-plan credits.
function isCreditNote(p: InvoiceLike): boolean {
  return !!p.invoice_number?.startsWith("CN-") || invoiceStatusOf(p) === "Credit" || Number(p.total) < 0
}

// Remaining balance — NOT the original face amount. `amount_due` is
// authoritative when present (a partial payment or a partial credit
// application both reduce it while leaving `total` at face value); `?? `
// (not `||`) so a genuine $0 balance isn't skipped in favor of a stale total.
function remainingBalance(p: InvoiceLike): number {
  if (p.amount_due != null) return Number(p.amount_due)
  const total = Number(p.total ?? p.amount ?? 0)
  const paid = Number(p.amount_paid ?? 0)
  return total - paid
}

function paidAmount(p: InvoiceLike): number {
  return Number(p.total) || Number(p.amount) || 0
}

export function summarizeInvoicesForFinanceCard(payments: InvoiceLike[], today: string): FinanceSummary {
  const invoiced = payments.filter(
    (p) => p.invoice_number && p.invoice_number !== "1.0" && p.invoice_number !== "2.0" && !p.is_test && !isCreditNote(p),
  )

  const byCurrencyMap = new Map<string, InvoiceLike[]>()
  for (const p of invoiced) {
    const currency = p.amount_currency || "USD"
    const list = byCurrencyMap.get(currency) ?? []
    list.push(p)
    byCurrencyMap.set(currency, list)
  }

  const byCurrency = Array.from(byCurrencyMap.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([currency, rows]) => {
      const paid = rows.filter((p) => invoiceStatusOf(p) === "Paid")
      const overdue = rows.filter((p) => isInvoiceOverdue(p, today))
      // Outstanding = everything invoiced that isn't settled (Paid/Cancelled/
      // Voided/Split) — a Draft or Partial row past due (or any future status
      // this list doesn't yet know about) still counts, rather than silently
      // disappearing.
      const outstanding = rows.filter((p) => !isInvoiceSettled(p))

      return {
        currency,
        outstandingCount: outstanding.length,
        outstandingTotal: outstanding.reduce((s, p) => s + remainingBalance(p), 0),
        overdueCount: overdue.length,
        paidCount: paid.length,
        paidTotal: paid.reduce((s, p) => s + paidAmount(p), 0),
      }
    })

  return { byCurrency }
}
