/**
 * Invoice matchability — the ONE definition of "can incoming money still be
 * applied to this invoice?".
 *
 * Why this module exists (2026-07-14, Simple Holdings / Fazekas incident):
 * the system had FOUR divergent terminal-status sets — the matcher
 * (`Paid|Voided|Cancelled`), the multi-match partitioner (+`Credit`), the
 * Finance server query (+`Split`, but NOT `Paid`), and `settleInvoiceFromFeed`
 * (`Paid|Voided|Credit`, missing `Cancelled`). Each one let a different class of
 * already-closed invoice back into the pool.
 *
 * Two columns, not one. `payments` carries BOTH `invoice_status` (text, the
 * document lifecycle: Draft → Sent → Overdue → Partial → Paid) and `status`
 * (the payment_status enum: Pending / Paid / Overdue / Delinquent / Waived /
 * Refunded / Not Invoiced / Cancelled). They disagree in production — 48 rows
 * are `status='Paid'` with a NULL `invoice_status`, and reading `invoice_status`
 * alone let those already-paid invoices be auto-matched a SECOND time.
 *
 * Reading `invoice_status` alone is unsafe; excluding NULL `invoice_status`
 * outright is ALSO unsafe — payment `50428dcc` ($1,250 "First Installment 2026",
 * `status='Overdue'`, no invoice_status, no invoice_number) is a genuine open
 * receivable and must stay matchable. So: an invoice is terminal if EITHER
 * column says it is closed; a NULL `invoice_status` falls back to `status`.
 *
 * Deliberately still matchable:
 *  - `Draft`   — invoice created at contract signing; payment legitimately
 *                arrives before the invoice is formally sent.
 *  - `Partial` — the remaining balance is still owed.
 *  - `Pending` / `Overdue` / `Delinquent` — money still expected.
 */

/** `invoice_status` values that mean the document is closed. */
export const TERMINAL_INVOICE_STATUSES = new Set([
  "Paid",
  "Voided",
  "Cancelled",
  "Credit",
  "Split",
])

/**
 * `status` (payment_status enum) values that mean THE MONEY IS ALREADY SETTLED —
 * received, or returned to the client. These are terminal no matter what
 * `invoice_status` says, because crediting them again would be crediting money
 * we already have (or gave back).
 */
export const MONEY_SETTLED_PAYMENT_STATUSES = new Set(["Paid", "Refunded"])

/**
 * `status` values that mean "nothing is owed" ONLY when `invoice_status` is absent.
 * These are the legacy/administrative states: a Cancelled or Waived row with no
 * invoice document, or a `Not Invoiced` placeholder installment row.
 *
 * They are deliberately NOT terminal when `invoice_status` says otherwise. Three
 * live production invoices carry `status='Cancelled'` alongside a real, open
 * `invoice_status` — including INV-002084 (Fiscalot), which has genuinely been
 * part-paid and still owes $500. Treating `status` as an absolute veto made that
 * $500 impossible to receive: the matcher ignored it, staff could not select it,
 * and a manual attempt reported success while moving no money. `invoice_status` is
 * the operational column the Finance UI reads; it wins when it is present.
 */
export const ADMINISTRATIVE_PAYMENT_STATUSES = new Set([
  "Cancelled",
  "Waived",
  "Not Invoiced",
])

/** The two status columns every matchability decision reads. */
export interface InvoiceStatusPair {
  invoice_status?: string | null
  status?: string | null
}

/**
 * True when the invoice is closed and MUST NOT receive money — from the
 * auto-matcher, the manual-match UI, or the multi-invoice waterfall.
 *
 * The rule, in order:
 *  1. `invoice_status` says closed (Paid/Voided/Cancelled/Credit/Split) → terminal.
 *  2. The money is already settled per `status` (Paid/Refunded) → terminal, ALWAYS,
 *     even if `invoice_status` still reads Sent or Overdue. This is the landmine:
 *     48 production invoices are Paid via `status` with a NULL `invoice_status`, and
 *     reading `invoice_status` alone left them creditable a second time.
 *  3. `invoice_status` is present and NOT closed → MATCHABLE, even if `status` says
 *     Cancelled/Waived. Money can still legitimately arrive (see the Fiscalot case).
 *  4. `invoice_status` is absent → fall back to `status`: the administrative states
 *     (Cancelled/Waived/Not Invoiced) mean nothing is owed.
 */
export function isTerminalInvoice(inv: InvoiceStatusPair): boolean {
  const invoiceStatus = inv.invoice_status?.trim()
  const paymentStatus = inv.status?.trim()

  // 1 — the invoice document itself is closed.
  if (invoiceStatus && TERMINAL_INVOICE_STATUSES.has(invoiceStatus)) return true

  // 2 — the money is settled or returned. Overrides an open-looking invoice_status.
  if (paymentStatus && MONEY_SETTLED_PAYMENT_STATUSES.has(paymentStatus)) return true

  // 3 — an open invoice_status wins over an administrative `status`.
  if (invoiceStatus) return false

  // 4 — no invoice_status at all: fall back to `status`.
  return !!paymentStatus && ADMINISTRATIVE_PAYMENT_STATUSES.has(paymentStatus)
}

/**
 * True when the invoice is closed because the money was ALREADY RECEIVED.
 *
 * This is the ONLY case where linking a payment to a closed invoice is legitimate:
 * the audit-trail link (a Stripe charge tied to the invoice its own webhook already
 * settled). Linking money to a Cancelled or Voided invoice is never legitimate —
 * the manual-match path must reject that loudly rather than record a cheerful
 * "linked" with nothing applied.
 */
export function isPaidInvoice(inv: InvoiceStatusPair): boolean {
  return inv.invoice_status?.trim() === "Paid" || inv.status?.trim() === "Paid"
}

/** True when incoming money can still be applied to this invoice. */
export function isMatchableInvoice(inv: InvoiceStatusPair): boolean {
  return !isTerminalInvoice(inv)
}

/**
 * Why a terminal invoice is closed — for the loud server-side rejection when a
 * human tries to settle one from the bank-feed UI (R099: surface the real
 * reason, never a generic failure).
 */
export function terminalReason(inv: InvoiceStatusPair): string | null {
  if (!isTerminalInvoice(inv)) return null

  const invoiceStatus = inv.invoice_status?.trim()
  const paymentStatus = inv.status?.trim()

  if (invoiceStatus && TERMINAL_INVOICE_STATUSES.has(invoiceStatus)) {
    return `Invoice is already ${invoiceStatus}`
  }
  if (paymentStatus && MONEY_SETTLED_PAYMENT_STATUSES.has(paymentStatus)) {
    return `Invoice is already ${paymentStatus}`
  }
  if (paymentStatus && ADMINISTRATIVE_PAYMENT_STATUSES.has(paymentStatus)) {
    return `Invoice is ${paymentStatus} — nothing is owed on it`
  }
  return "Invoice is closed"
}
