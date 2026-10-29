/**
 * What a person's ticks in the Bank Feed's "Match to invoice" popup MEAN.
 *
 * The popup lets staff tick invoices that are still owed (the payment is applied to them) and,
 * since 2026-10-29, invoices that are ALREADY PAID (the payment is only linked to them for the
 * record — no money moves). Those are two different operations with different safety rules, and
 * one payment cannot be both at once yet: sharing a payment between a settled invoice and an open
 * one means deciding how much of it belongs to each, and the undo path for a payment spread over
 * several invoices is not safe enough to build that on (reviewers' finding, 2026-10-29).
 *
 * The browser's idea of which invoice is paid is a snapshot from when the page loaded, so the
 * decision is made HERE, from the invoices' current status, and a mixed selection is refused with
 * a plain explanation — never silently reclassified.
 *
 * Pure: the server action reads the rows and calls this.
 */
import { isPaidInvoice } from "@/lib/finance/invoice-matchability"

export interface SelectedInvoiceRow {
  id: string
  invoice_number: string | null
  invoice_status: string | null
  status: string | null
}

export type SelectionPlan =
  /** Nothing already paid: the existing multi-invoice match, unchanged. */
  | { kind: "open"; openIds: string[] }
  /** Every invoice already paid: link the payment to all of them for the record. */
  | { kind: "paid"; paidIds: string[] }
  /** Cannot be done as asked; `error` says why in words a person can act on. */
  | { kind: "refused"; error: string }

const label = (r: SelectedInvoiceRow) => r.invoice_number ?? "An invoice"

export function planMatchSelection(ids: ReadonlyArray<string>, rows: ReadonlyArray<SelectedInvoiceRow>): SelectionPlan {
  const wanted = Array.from(new Set(ids.filter(Boolean)))
  if (wanted.length === 0) return { kind: "refused", error: "No invoices selected." }

  const byId = new Map(rows.map((r) => [r.id, r]))
  if (wanted.some((id) => !byId.has(id))) {
    return { kind: "refused", error: "One of the selected invoices could not be found. Close this window and open it again." }
  }
  const selected = wanted.map((id) => byId.get(id)!)

  const paid = selected.filter(isPaidInvoice)
  if (paid.length === 0) return { kind: "open", openIds: wanted }
  if (paid.length === selected.length) return { kind: "paid", paidIds: wanted }

  const notPaid = selected.filter((r) => !isPaidInvoice(r))
  return {
    kind: "refused",
    error:
      `${paid.map(label).join(", ")} ${paid.length === 1 ? "is" : "are"} already paid, but ${notPaid.map(label).join(", ")} ${notPaid.length === 1 ? "is" : "are"} not. ` +
      "Pick only the already-paid invoices to link this payment to them for the record (no money moves), " +
      "or only the unpaid ones to apply the payment to them.",
  }
}

/**
 * The note written on each invoice when a payment is linked to already-paid invoices from the
 * Match popup, which has no note box: what the payment was, so the invoice says why it is linked.
 */
export function recordOnlyLinkNote(feed: {
  amount?: number | string | null
  currency?: string | null
  sender_name?: string | null
  transaction_date?: string | null
}): string {
  const amount = Number(feed.amount ?? 0)
  const money = `${Number.isFinite(amount) ? amount.toFixed(2) : "0.00"} ${feed.currency ?? "USD"}`
  const who = feed.sender_name?.trim() ? ` from ${feed.sender_name.trim()}` : ""
  const when = feed.transaction_date ? ` on ${String(feed.transaction_date).slice(0, 10)}` : ""
  return `Linked from the Bank Feed: payment of ${money}${who}${when}.`
}

/**
 * The refusal for linking a payment, for the record, to already-paid invoices that ANOTHER bank
 * transaction already accounts for: a second claim would double-count the invoice, and undoing it
 * later would reverse the first payment's money (the ledger is keyed by invoice). Null when none is taken.
 */
export function claimedInvoicesError(
  rows: ReadonlyArray<{ id: string; invoice_number: string | null }>,
  claimed: ReadonlySet<string>,
): string | null {
  const taken = rows.filter((r) => claimed.has(r.id))
  if (taken.length === 0) return null
  const names = taken.map((r) => r.invoice_number ?? "An invoice").join(", ")
  return (
    `${names} ${taken.length === 1 ? "is" : "are"} already linked to another bank payment. ` +
    `Untick ${taken.length === 1 ? "it" : "them"}, or undo that link first — linking a second payment to the same invoice would count it twice.`
  )
}
