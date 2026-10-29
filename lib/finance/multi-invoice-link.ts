/**
 * ONE bank transaction linked, for the record, to SEVERAL already-Paid invoices.
 *
 * Real case (Antonio, 2026-10-29): a $125 Stripe payment paid two invoices — one for $50 and one
 * for $75 — and both were already marked Paid. A transaction points at ONE invoice
 * (`matched_payment_id`), and "Link with a note" took one invoice, so the second invoice could
 * never be tied to the payment that settled it. The existing multi-invoice "waterfall" only
 * handles invoices that are still OPEN (it skips Paid ones on purpose, so nothing is
 * double-credited).
 *
 * This is the AUDIT-ONLY version: no money moves. The transaction keeps pointing at the first
 * invoice (every existing single-pointer reader stays valid) and the full set is recorded in
 * `review_metadata`. The matcher's "is this invoice already claimed by a bank transaction?"
 * guard reads this set too, so a second transaction cannot be auto-linked to an invoice that
 * this one already accounts for.
 */
import { auditLinkMetadata, type AuditLinkMetadata } from "@/lib/finance/feed-vocabulary"

/** A sanity ceiling, not a business rule: a payment covering more invoices than this is a mistake. */
export const MAX_LINKED_INVOICES = 20

export interface LinkedInvoiceFact {
  id: string
  invoice_number: string | null
  total: number | null
}

export interface MultiLinkMetadata extends AuditLinkMetadata {
  multi_audit_link: true
  linked_payment_ids: string[]
  linked_invoices: LinkedInvoiceFact[]
  transaction_amount: number
  linked_total: number
  difference: number
}

const round2 = (n: number) => Math.round(n * 100) / 100

/** How the chosen invoices add up against the transaction. `difference` = transaction - invoices. */
export function summarizeMultiLink(
  transactionAmount: number,
  invoiceTotals: ReadonlyArray<number | null | undefined>,
): { linkedTotal: number; difference: number; matches: boolean } {
  const linkedTotal = round2(invoiceTotals.reduce<number>((sum, t) => sum + (Number(t) || 0), 0))
  const difference = round2((Number(transactionAmount) || 0) - linkedTotal)
  return { linkedTotal, difference, matches: Math.abs(difference) < 0.005 }
}

export function multiLinkMetadata(params: {
  note: string
  transactionAmount: number
  invoices: LinkedInvoiceFact[]
}): MultiLinkMetadata {
  const { linkedTotal, difference } = summarizeMultiLink(
    params.transactionAmount,
    params.invoices.map((i) => i.total),
  )
  return {
    ...auditLinkMetadata("manual", params.note),
    multi_audit_link: true,
    linked_payment_ids: params.invoices.map((i) => i.id),
    linked_invoices: params.invoices,
    transaction_amount: round2(Number(params.transactionAmount) || 0),
    linked_total: linkedTotal,
    difference,
  }
}

/**
 * The invoices a multi-linked transaction accounts for. Empty for any other row — including a
 * row whose multi-link keys are stale leftovers, because a real multi-link always carries the
 * `multi_audit_link: true` flag that a later single link / reset overwrites with null.
 */
export function readLinkedPaymentIds(reviewMetadata: unknown): string[] {
  if (!reviewMetadata || typeof reviewMetadata !== "object" || Array.isArray(reviewMetadata)) return []
  const meta = reviewMetadata as Record<string, unknown>
  if (meta.multi_audit_link !== true) return []
  const ids = meta.linked_payment_ids
  if (!Array.isArray(ids)) return []
  return ids.filter((id): id is string => typeof id === "string" && id.length > 0)
}

/** Keys that wipe a previous multi-link from a row's merged review_metadata. */
export const CLEAR_MULTI_LINK_METADATA = {
  multi_audit_link: null,
  linked_payment_ids: null,
  linked_invoices: null,
  transaction_amount: null,
  linked_total: null,
  difference: null,
} as const

/**
 * The invoices a multi-linked transaction covers BESIDES the one it points at, for the matched
 * row to name (otherwise the row looks like it covers one invoice only). Empty for any other row.
 */
export function otherMultiLinkedInvoices(
  reviewMetadata: unknown,
  pointedPaymentId: string | null | undefined,
): LinkedInvoiceFact[] {
  if (readLinkedPaymentIds(reviewMetadata).length === 0) return []
  const list = (reviewMetadata as Record<string, unknown>).linked_invoices
  if (!Array.isArray(list)) return []
  return list.filter(
    (i): i is LinkedInvoiceFact =>
      !!i && typeof i === "object" && typeof (i as LinkedInvoiceFact).id === "string" && (i as LinkedInvoiceFact).id !== pointedPaymentId,
  )
}
