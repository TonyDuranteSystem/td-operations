/**
 * Data loaders shared by the Accounts and Contacts lists (server side).
 */

import type { createClient } from '@/lib/supabase/server'
import { isLivePayment } from '@/lib/billing/payment-classification'
import { chipForInstallment, type InstallmentChip, type InstallmentPaymentRow } from '@/lib/billing/installment-invoices'

type Db = ReturnType<typeof createClient>

const PAGE = 1000

/**
 * Read EVERY row of a query. A plain select is silently cut at 1,000 rows, which would quietly drop companies or people from the
 * filters and counts once the CRM grows past that — so the lists read in chunks until a chunk comes back short.
 */
export async function fetchAllRows<T>(
  page: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
): Promise<T[]> {
  const all: T[] = []
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await page(from, from + PAGE - 1)
    if (error) throw new Error(error.message)
    const rows = data ?? []
    all.push(...rows)
    if (rows.length < PAGE) break
  }
  return all
}

/** Today's date (YYYY-MM-DD) and year in New York — the billing calendar's clock, not the server's UTC. */
export function newYorkToday(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now)
}

export function newYorkYear(now: Date = new Date()): number {
  return Number(newYorkToday(now).slice(0, 4))
}

/**
 * How many live invoices are Overdue and past due, per company. (The list used to ask for the statuses "Due" and "Partially
 * Paid", which are not payment statuses at all — the database refused the whole request and the Overdue column stayed empty.)
 */
export async function loadOverdueCounts(db: Db, today: string = newYorkToday()): Promise<Record<string, number>> {
  const rows = await fetchAllRows((from, to) =>
    db
      .from('payments')
      .select('account_id, status, invoice_status')
      .eq('status', 'Overdue')
      .lt('due_date', today)
      .range(from, to),
  )
  const counts: Record<string, number> = {}
  for (const r of rows) {
    // isLivePayment only looks at the two status words; the category / year it also accepts do not matter here.
    if (!r.account_id || !isLivePayment({ payment_category: null, year: null, status: r.status, invoice_status: r.invoice_status })) continue
    counts[r.account_id] = (counts[r.account_id] ?? 0) + 1
  }
  return counts
}

export interface InstallmentChips {
  first: InstallmentChip
  second: InstallmentChip
}

/** The Paid / Pending / Overdue / Not invoiced chip for each company's installment 1 and 2 of `year`. */
export async function loadInstallmentChips(db: Db, accountIds: string[], year: number): Promise<Record<string, InstallmentChips>> {
  const byAccount: Record<string, InstallmentPaymentRow[]> = {}
  if (accountIds.length > 0) {
    const { data, error } = await db
      .from('payments')
      .select('account_id, payment_category, year, status, invoice_status, total, invoice_number')
      .in('account_id', accountIds)
      .eq('year', year)
      .in('payment_category', ['installment_1', 'installment_2'])
    if (error) throw new Error(error.message)
    for (const r of data ?? []) {
      if (!r.account_id) continue
      ;(byAccount[r.account_id] ??= []).push(r)
    }
  }
  const out: Record<string, InstallmentChips> = {}
  for (const id of accountIds) {
    const rows = byAccount[id] ?? []
    out[id] = { first: chipForInstallment(rows, 1, year), second: chipForInstallment(rows, 2, year) }
  }
  return out
}
