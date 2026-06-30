/**
 * Overdue-invoice summarization for TD receivables (the `payments` table).
 *
 * Pure helpers — no DB access — so they're unit-testable and reusable by any
 * surface that needs a per-account / per-contact "is this client behind on
 * payments, and by how many days" rollup. First consumer: the portal-chats
 * thread badges (overdue alert next to the contact's name + per company).
 *
 * Overdue rule (matches the runtime check already used in lib/portal/queries.ts
 * and app/api/crm/dashboard-attention/route.ts):
 *   status ∈ {Overdue, Delinquent}  OR  (status === 'Pending' AND due_date < today)
 * Excludes Paid / Waived / Cancelled / Refunded / Not Invoiced and is_test rows.
 * No age cap — legacy and very old debt still count (a real unpaid invoice is
 * a real unpaid invoice).
 *
 * Dates: `due_date` is a SQL DATE ('YYYY-MM-DD'). We compare on UTC midnight so
 * the result is deterministic regardless of server timezone (Vercel runs UTC)
 * and so tests can pin "now" without local-TZ drift.
 */

export interface OverduePaymentRow {
  status: string | null
  due_date: string | null
  amount_due?: number | null
  amount?: number | null
  total?: number | null
  is_test?: boolean | null
}

export interface OverdueSummary {
  /** Number of overdue invoices for this account/contact. */
  count: number
  /** Days past due of the OLDEST overdue invoice (0 if none of them carry a due_date). */
  maxDays: number
  /** Sum of amount still owed across the overdue invoices (best-effort: amount_due → amount → total). */
  totalDue: number
}

const OVERDUE_STATUSES = new Set(['Overdue', 'Delinquent'])

/** UTC-midnight epoch ms for a Date. */
function midnightUtcMs(d: Date): number {
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())
}

/** UTC-midnight epoch ms for a 'YYYY-MM-DD' date string, or null if unparseable. */
function dueDateMs(due: string | null | undefined): number | null {
  if (!due) return null
  const ms = Date.parse(`${due}T00:00:00Z`)
  return Number.isNaN(ms) ? null : ms
}

/** Whole days a due_date is past `now` (never negative). 0 when no/invalid due_date. */
export function daysPastDue(due: string | null | undefined, now: Date): number {
  const dueMs = dueDateMs(due)
  if (dueMs === null) return 0
  const diff = midnightUtcMs(now) - dueMs
  return diff <= 0 ? 0 : Math.floor(diff / 86_400_000)
}

/** Is a single payment row an overdue TD receivable as of `now`? */
export function isOverduePayment(row: OverduePaymentRow, now: Date): boolean {
  if (row.is_test) return false
  const status = row.status ?? ''
  if (OVERDUE_STATUSES.has(status)) return true
  if (status === 'Pending') {
    const dueMs = dueDateMs(row.due_date)
    return dueMs !== null && dueMs < midnightUtcMs(now)
  }
  return false
}

/**
 * Roll up a set of payment rows into an overdue summary, or null if none are
 * overdue. Pass only the rows for ONE account (or one contact) — grouping is
 * the caller's job.
 */
export function summarizeOverdue(rows: OverduePaymentRow[], now: Date): OverdueSummary | null {
  let count = 0
  let maxDays = 0
  let totalDue = 0
  for (const row of rows) {
    if (!isOverduePayment(row, now)) continue
    count++
    maxDays = Math.max(maxDays, daysPastDue(row.due_date, now))
    const owed = Number(row.amount_due ?? row.amount ?? row.total ?? 0)
    if (Number.isFinite(owed)) totalDue += owed
  }
  return count > 0 ? { count, maxDays, totalDue } : null
}
