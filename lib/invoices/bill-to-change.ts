/**
 * Changing who an invoice is billed to (dev job e62bc2b6, Antonio 2026-11-21).
 *
 * Two doors use this: the Finance "Bill to" button (staff) and the "someone else
 * is paying" box on the client's payment page. Both end in the SAME decision, so
 * the rules live here, pure (no database), and every case is unit-testable.
 *
 * The four choices are the offer builder's "Invoice to" choices:
 *   person  — the invoice belongs to the person only (no company)
 *   company — the invoice moves into a company that is in the CRM
 *   entity  — a payer (saved, or typed now): ONLY the name printed on the invoice
 *             changes; the invoice stays where it is (same books, same portal)
 *
 * Who RECEIVES the invoice never changes here: the email still goes to the
 * invoice's own contact (see lib/portal/resolve-payment-recipient.ts).
 */
import { parseBillTo, type BillToEntityDetails } from "@/lib/offers/bill-to"

/** Statuses an invoice can still be re-addressed in. A paid invoice is allowed on
 *  purpose (a client may ask for the paid invoice under another name). */
export const BILL_TO_EDITABLE_STATUSES = ["Draft", "Sent", "Overdue", "Partial", "Paid"] as const

export interface BillToPaymentRow {
  invoice_status: string | null
  total: number | null
  account_id: string | null
  contact_id: string | null
  billing_entity_id: string | null
  payment_category: string | null
  installment: string | null
}

export type EntityPlan =
  | { kind: "clear" }
  | { kind: "saved"; id: string }
  | { kind: "typed"; details: BillToEntityDetails }

export interface BillToChangePlan {
  /** What payments.account_id must be after the change. */
  account_id: string | null
  entity: EntityPlan
  /** True when the invoice moves to another company or to the person. */
  accountChanged: boolean
  /** True when the payer must hang on a person (saved/typed payers do). */
  needsContactForEntity: boolean
}

export type BillToDecision = { ok: true; plan: BillToChangePlan } | { ok: false; error: string }

const isInstallment = (row: BillToPaymentRow): boolean =>
  Boolean(row.installment && row.installment.trim()) || /^installment/i.test(row.payment_category ?? "")

/**
 * Why this invoice may NOT move to another company (or to the person), or null when it may.
 * An installment is counted per company; a credit note sits on the company it reduces.
 */
export function companyMoveBlockedReason(row: BillToPaymentRow, creditNotesReferencing: number): string | null {
  if (isInstallment(row)) {
    return "An installment invoice stays with its company (the installment is counted per company). To change the name printed on it, choose a payer instead of another company."
  }
  if (creditNotesReferencing > 0) {
    return "A credit note points at this invoice, so it cannot move to another company. To change the name printed on it, choose a payer instead."
  }
  return null
}

/**
 * Decide what a requested "Bill to" does to an invoice. Never touches the database.
 * `creditNotesReferencing` = how many credit notes point at this invoice.
 */
export function decideBillToChange(
  row: BillToPaymentRow,
  rawBillTo: unknown,
  ctx: { creditNotesReferencing: number },
): BillToDecision {
  const parsed = parseBillTo(rawBillTo)
  if (parsed.error) return { ok: false, error: parsed.error.replace(/^Invoice to: /, "Bill to: ") }
  const billTo = parsed.billTo
  if (!billTo) return { ok: false, error: "Bill to: choose who the invoice is billed to" }

  const status = row.invoice_status
  if (!status || !(BILL_TO_EDITABLE_STATUSES as readonly string[]).includes(status)) {
    return { ok: false, error: `Bill to cannot be changed on a ${status ?? "legacy"} record — only on Draft, Sent, Overdue, Partial or Paid invoices.` }
  }
  if (Number(row.total ?? 0) < 0) {
    return { ok: false, error: "Bill to cannot be changed on a credit note." }
  }

  let plan: BillToChangePlan
  if (billTo.type === "person") {
    if (!row.contact_id) return { ok: false, error: "This invoice has no person on it, so it cannot be billed to the person." }
    plan = { account_id: null, entity: { kind: "clear" }, accountChanged: row.account_id !== null, needsContactForEntity: false }
  } else if (billTo.type === "company") {
    plan = { account_id: billTo.account_id, entity: { kind: "clear" }, accountChanged: row.account_id !== billTo.account_id, needsContactForEntity: false }
  } else if ("billing_entity_id" in billTo) {
    plan = { account_id: row.account_id, entity: { kind: "saved", id: billTo.billing_entity_id }, accountChanged: false, needsContactForEntity: true }
  } else {
    plan = { account_id: row.account_id, entity: { kind: "typed", details: billTo.entity }, accountChanged: false, needsContactForEntity: true }
  }

  if (plan.accountChanged) {
    const blocked = companyMoveBlockedReason(row, ctx.creditNotesReferencing)
    if (blocked) return { ok: false, error: blocked }
  }
  return { ok: true, plan }
}

/** The dated line added to the invoice's INTERNAL notes (never copied to the client). */
export function billToChangeNote(p: { date: string; from: string; to: string; by: string }): string {
  return `${p.date}: Bill to changed from "${p.from}" to "${p.to}" — ${p.by}.`
}

/** Marker words in the note line that say the CLIENT (not staff) named the payer. */
export const CLIENT_NAMED_BY = "named by the client on the payment page"

/**
 * Did the client name the CURRENT payer? True only when the LAST "Bill to changed"
 * line in the internal notes was written by the client's box — so a later change by
 * staff clears the Finance mark. No new column: the notes line is the record.
 */
export function lastBillToChangeWasByClient(notes: string | null | undefined): boolean {
  const lines = (notes ?? "").split("\n").filter((l) => l.includes("Bill to changed from"))
  const last = lines[lines.length - 1]
  return Boolean(last && last.includes(CLIENT_NAMED_BY))
}

/** Append a line to existing internal notes (blank line between entries). */
export function appendNote(existing: string | null | undefined, line: string): string {
  const base = (existing ?? "").trim()
  return base ? `${base}\n${line}` : line
}
