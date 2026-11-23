/**
 * A team member's start date for the company's invoices and expenses (dev job e5d5400d; Antonio 2026-10-21: it is an option
 * the owner ticks when inviting someone). Same rule as new owners (lib/documents/history-cutoff.ts): a person added later does
 * not see what was saved before they joined, unless the owner ticked 'invoice_history' for them.
 *
 * Pure and client-safe. Returns the date they may see FROM, or null = sees everything (ticked, or no date known).
 */
import { hasCapability, type CapabilityFlags } from './capabilities'
import { filterByHistoryCutoff, isSettledPaymentStatus } from '@/lib/documents/history-cutoff'

export function teammateHistoryStart(t: { createdAt?: string | null; capabilities: CapabilityFlags | null | undefined }): string | null {
  if (hasCapability(t.capabilities, 'invoice_history')) return null
  if (!t.createdAt || Number.isNaN(Date.parse(t.createdAt))) return null
  return t.createdAt
}

/**
 * May this team login open ONE TD invoice (a payment) by its id? The same rule as the invoice list: with a start date, a settled invoice
 * created BEFORE it is hidden; an invoice that is still owed stays visible (dev job e59dd470, 20 Nov hunt A#11: the PDF route used to skip this).
 */
export function teammateMayOpenPayment(
  t: { createdAt?: string | null; capabilities: CapabilityFlags | null | undefined },
  p: { created_at: string | null; status: string | null },
): boolean {
  const start = teammateHistoryStart(t)
  if (!start) return true
  return filterByHistoryCutoff([p], start, null, (row) => ({ created_at: row.created_at ?? '', opened: !isSettledPaymentStatus(row.status) })).length === 1
}
