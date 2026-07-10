/**
 * Reactivating a cancelled TD invoice — pure decision helpers.
 *
 * Cancelling ("voiding") an invoice used to be a one-way door: nothing in the
 * codebase could bring one back, and the void recorded NOTHING about what the
 * invoice looked like beforehand. That cost a manual production repair on
 * 2026-07-10 (VictoriamRoas LLC INV-002218, cancelled in error).
 *
 * The fix has two halves:
 *   1. `voidInvoice` now stamps a {@link PreVoidState} into `action_log.details`
 *      so a later reactivate can restore the invoice EXACTLY.
 *   2. For invoices cancelled BEFORE that (no recorded state), we DERIVE the
 *      honest state from the invoice itself — see {@link resolveReactivateTarget}.
 *
 * Everything here is pure (no DB, no clock) so it is unit-testable and cannot
 * drift from the real behaviour: the server action does the I/O, these helpers
 * make every decision.
 */

/**
 * `payments.status` is a DB enum with only these members. There is NO
 * `Draft` / `Sent` / `Partial` member — those live in the separate free-text
 * `invoice_status` column. So a Draft invoice is `status='Pending'`,
 * `invoice_status='Draft'`. Getting this backwards writes an invalid enum and
 * the UPDATE fails.
 */
export type PaymentStatus =
  | "Pending"
  | "Paid"
  | "Overdue"
  | "Delinquent"
  | "Waived"
  | "Refunded"
  | "Not Invoiced"
  | "Cancelled"

/** The snapshot `voidInvoice` records so a reactivate can be exact. */
export interface PreVoidState {
  status: PaymentStatus
  invoice_status: string
  amount_due: number
  amount_paid: number
  paid_date: string | null
}

export interface ReactivateTarget extends PreVoidState {
  /** `recorded` = restored from the void's snapshot; `derived` = reconstructed. */
  source: "recorded" | "derived"
}

const PAYMENT_STATUSES: readonly string[] = [
  "Pending", "Paid", "Overdue", "Delinquent", "Waived", "Refunded", "Not Invoiced", "Cancelled",
]

/** Round to cents — guards against float drift when deriving a balance. */
function money(n: number): number {
  return Math.round(n * 100) / 100
}

/**
 * Snapshot an invoice's live state, immediately before it is cancelled.
 * Stored verbatim in `action_log.details.pre_void_state`.
 */
export function capturePreVoidState(payment: {
  status: string | null
  invoice_status: string | null
  amount_due: number | null
  amount_paid: number | null
  paid_date: string | null
}): PreVoidState {
  return {
    status: (payment.status ?? "Pending") as PaymentStatus,
    invoice_status: payment.invoice_status ?? "Draft",
    amount_due: money(Number(payment.amount_due ?? 0)),
    amount_paid: money(Number(payment.amount_paid ?? 0)),
    paid_date: payment.paid_date ?? null,
  }
}

/**
 * Read a snapshot back out of `action_log.details`, defensively.
 *
 * Returns null — meaning "fall back to deriving" — when the payload is absent,
 * malformed, or itself says `Cancelled` (restoring a cancelled invoice to
 * cancelled is a no-op, and would strand the invoice).
 */
export function parsePreVoidState(details: unknown): PreVoidState | null {
  if (!details || typeof details !== "object") return null
  const raw = (details as Record<string, unknown>).pre_void_state
  if (!raw || typeof raw !== "object") return null

  const d = raw as Record<string, unknown>
  const status = d.status
  const invoiceStatus = d.invoice_status

  if (typeof status !== "string" || !PAYMENT_STATUSES.includes(status)) return null
  if (typeof invoiceStatus !== "string" || !invoiceStatus) return null
  if (status === "Cancelled" || invoiceStatus === "Cancelled") return null

  const amountDue = Number(d.amount_due)
  const amountPaid = Number(d.amount_paid)
  if (!Number.isFinite(amountDue) || !Number.isFinite(amountPaid)) return null

  const paidDate = d.paid_date
  if (paidDate !== null && typeof paidDate !== "string" && paidDate !== undefined) return null

  return {
    status: status as PaymentStatus,
    invoice_status: invoiceStatus,
    amount_due: money(amountDue),
    amount_paid: money(amountPaid),
    paid_date: typeof paidDate === "string" ? paidDate : null,
  }
}

/**
 * Decide what a reactivated invoice should look like.
 *
 * Prefers the snapshot the void recorded. Falling back to derivation, the
 * order matters and mirrors how the rest of the system already classifies an
 * invoice (see the dunning pass, which marks a past-due Sent/Partial invoice
 * Overdue):
 *
 *   1. fully covered by real cash  → Paid
 *   2. past its due date           → Overdue   (regardless of whether it was ever emailed —
 *                                               the debt is real; this is what Antonio asked
 *                                               for on 2026-07-10)
 *   3. part-paid                   → Partial
 *   4. was emailed to the client   → Sent
 *   5. otherwise                   → Draft
 *
 * `amount_paid` is REAL CASH and survives a void untouched, so it is carried
 * through as-is and the balance is recomputed from it — never trusted from the
 * possibly-stale `amount_due` on the cancelled row.
 */
export function resolveReactivateTarget(input: {
  prior: PreVoidState | null
  total: number
  amountPaid: number
  /** ISO `YYYY-MM-DD`, or null when the invoice carries no due date. */
  dueDate: string | null
  /** ISO `YYYY-MM-DD` — passed in, never read from the clock, so tests are stable. */
  today: string
  /** True when the invoice was actually emailed to the client. */
  wasSent: boolean
}): ReactivateTarget {
  if (input.prior) return { ...input.prior, source: "recorded" }

  const total = money(Number(input.total) || 0)
  const paid = money(Number(input.amountPaid) || 0)
  const due = money(Math.max(0, total - paid))

  if (total > 0 && paid >= total) {
    return { status: "Paid", invoice_status: "Paid", amount_due: 0, amount_paid: paid, paid_date: null, source: "derived" }
  }

  const base = { amount_due: due, amount_paid: paid, paid_date: null, source: "derived" as const }

  if (input.dueDate && input.dueDate < input.today) {
    return { ...base, status: "Overdue", invoice_status: "Overdue" }
  }
  if (paid > 0) return { ...base, status: "Pending", invoice_status: "Partial" }
  if (input.wasSent) return { ...base, status: "Pending", invoice_status: "Sent" }
  return { ...base, status: "Pending", invoice_status: "Draft" }
}

/**
 * Split the bank-feed rows linked to an invoice into the ones that must be
 * RESET and the ones whose status must be LEFT ALONE.
 *
 * The old `voidInvoice` set `status='unmatched'` on every linked row. That is
 * wrong: a link can also be an unconfirmed *suggestion* on a row the operator
 * already triaged. Blindly resetting resurrected rows previously marked
 * `ignored` (deliberately dismissed) or `outgoing` (money leaving, never an
 * invoice payment) back into the review queue — found on 2026-07-10 while
 * cancelling VictoriamRoas INV-001244, which had exactly those two.
 *
 * Only a CONFIRMED `matched` row represents a real reconciliation that the
 * void undoes, so only it returns to `unmatched`. Every other row just loses
 * its stale pointer.
 */
export function partitionFeedsForUnlink(
  rows: Array<{ id: string; status: string | null }>,
): { resetIds: string[]; clearIds: string[] } {
  const resetIds: string[] = []
  const clearIds: string[] = []
  for (const row of rows) {
    if (row.status === "matched") resetIds.push(row.id)
    else clearIds.push(row.id)
  }
  return { resetIds, clearIds }
}
