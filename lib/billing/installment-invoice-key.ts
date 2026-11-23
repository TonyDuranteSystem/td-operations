/**
 * The yearly installments (dev job bea928e0, Antonio 2026-11-22).
 *
 * An installment is NOT a service and NOT a free choice of "invoice type": it marks the moment the client is invoiced for
 * their contract. The amounts live in the CRM (the company's 1st / 2nd installment amount + currency); the contract only
 * populates the CRM. An installment invoice therefore comes from exactly three places:
 *   - the contract signing (January)        lib/offers/process-agreement-signed.ts
 *   - the yearly run (June, drafts only)     app/api/cron/annual-installments/route.ts
 *   - the company page's Installments section (this module's key) — the manual door, pre-filled from the CRM and locked.
 *
 * This file is the one place that says which two labels exist and which key each installment invoice carries. The keys are the
 * SAME strings the two system writers use, so a manual invoice and a system-made one for the same company, number and year
 * are the same invoice: whichever is created second returns the first instead of billing the client twice.
 *
 * The label text itself is load-bearing (the database rules and the paid handler read it exactly), so these two strings
 * must never be renamed.
 */

export const INSTALLMENT_LABELS = ["Installment 1 (Jan)", "Installment 2 (Jun)"] as const
export type InstallmentLabel = (typeof INSTALLMENT_LABELS)[number]

/** 1 for "Installment 1 (Jan)", 2 for "Installment 2 (Jun)", null for anything else. */
export function installmentNumberOf(label: string | null | undefined): 1 | 2 | null {
  if (label === INSTALLMENT_LABELS[0]) return 1
  if (label === INSTALLMENT_LABELS[1]) return 2
  return null
}

/**
 * The idempotency key of an installment invoice — identical to the system writers':
 *   January  → `renewal-1st:{account}:{year}`            (contract signing)
 *   June     → `annual-installment:{account}:2:{year}`   (yearly run)
 * Null when the label is not one of the two installments.
 */
export function installmentIdempotencyKey(accountId: string, label: string | null | undefined, year: number): string | null {
  const n = installmentNumberOf(label)
  if (n === 1) return `renewal-1st:${accountId}:${year}`
  if (n === 2) return `annual-installment:${accountId}:2:${year}`
  return null
}

const INSTALLMENT_KEY_RE = /^(?:renewal-1st:[0-9a-f-]{36}:\d{4}|annual-installment:[0-9a-f-]{36}:2:\d{4})$/i

/** True only for the two installment keys above — never for a credit note's, a plan part's or a one-off's key. */
export function isInstallmentIdempotencyKey(key: string | null | undefined): boolean {
  return !!key && INSTALLMENT_KEY_RE.test(key)
}

/**
 * An installment invoice that was cancelled or voided is DEAD: it can never be paid, so it must not keep holding its
 * installment's key (the key is unique across every row, dead ones included). A credit note is NOT dead — never listed here.
 * (dev job bea928e0: 8 cancelled installment invoices in production still held their key.)
 */
export function isDeadInstallmentRow(row: { status?: string | null; invoice_status?: string | null }): boolean {
  return row.status === "Cancelled" || row.invoice_status === "Cancelled" || row.invoice_status === "Voided"
}

/**
 * An invoice carries an installment label and a year TOGETHER or not at all: the year is the installment's own year
 * (the one the company page shows), never guessed from a date, and no other kind of invoice carries a year.
 * Returns a plain-English problem, or null when the pair is fine.
 */
export function installmentPairProblem(input: { installment?: string | null; year?: number | null }): string | null {
  const hasLabel = input.installment != null && input.installment !== ""
  const hasYear = input.year != null
  if (hasLabel && installmentNumberOf(input.installment) === null) {
    return "Only the two yearly installments carry a Payment Type, and they are created from the company's Installments section. Remove the Payment Type."
  }
  if (hasLabel && !hasYear) return "An installment invoice needs the year it is for."
  if (hasYear && !hasLabel) return "A year can only be set on an installment invoice."
  return null
}
