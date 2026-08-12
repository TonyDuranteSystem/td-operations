/**
 * WHERE A PAYMENT PLAN ACTUALLY STANDS — one answer, for every surface that asks.
 *
 * Three places need to know "which parts have been raised, and what happened to them": the staff
 * section that offers the Raise button, the client's schedule, and the obligation card that must
 * stay open until a part is both sent and paid. If each computed it, they would disagree — and the
 * disagreement would be about money, in front of a client.
 *
 * The core is PURE: given a plan and the invoice rows carrying its lineage, it returns a state per
 * part. The query wrapper below is the only part that touches the database, so the interesting
 * logic is testable without one.
 *
 * ⛔ THE DEAD-INVOICE LIST IS SHARED WITH THE DATABASE, DELIBERATELY.
 *
 * `DEAD_INVOICE_STATUSES` is the same set the partial unique index excludes
 * (`uq_payments_one_invoice_per_tranche`, migration 20260810-0940). It has to be: the index decides
 * whether a part CAN be raised again, and this file decides whether the button is OFFERED. If the
 * two lists ever drift, the UI shows a button the database refuses, or hides one it would accept.
 * Change them together or not at all.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import {
  type PaymentPlan,
  type PaymentPlanPart,
  validatePaymentPlan,
} from "@/lib/offers/payment-plan"

/**
 * Invoice statuses that mean "this invoice is over and settles nothing".
 *
 * Cancelled — the offer it belonged to was deleted or reset.
 * Voided    — raised, then withdrawn because it was wrong.
 * Credit    — turned into a credit note.
 *
 * All three release the part to be raised again. MUST match the index predicate.
 */
export const DEAD_INVOICE_STATUSES = ["Cancelled", "Voided", "Credit"] as const

/** What has happened to one part, in the order it happens. */
export type PartState =
  /** No live invoice exists. The Raise button belongs here and nowhere else. */
  | "not_raised"
  /** Raised but not sent — the client has not been told, and no money can arrive against it. */
  | "raised_unsent"
  /** Sent, awaiting payment. */
  | "awaiting_payment"
  /** Part-paid — some money arrived, the rest has not. */
  | "part_paid"
  /** Settled. */
  | "paid"

export interface TrancheInvoiceRow {
  id: string
  invoice_number: string | null
  invoice_status: string | null
  amount_paid: number | null
  amount: number | null
  tranche_seq: number | null
  due_date: string | null
  sent_at?: string | null
}

export interface PartStatus {
  part: PaymentPlanPart
  state: PartState
  /** The LIVE invoice for this part, if one exists. Dead ones are deliberately not surfaced here. */
  invoice: TrancheInvoiceRow | null
  /** Dead invoices for this part, newest-agnostic — kept for the audit trail and staff context. */
  supersededInvoices: TrancheInvoiceRow[]
  /**
   * True when this part still owes something — i.e. the obligation is OPEN.
   *
   * Antonio's rule: the obligation stays open until the invoice is both SENT and PAID. So a
   * raised-but-unsent part is still open, which is the case that would otherwise look done on a
   * board while the client has never been told.
   */
  obligationOpen: boolean
}

export interface PlanStatus {
  plan: PaymentPlan
  parts: PartStatus[]
  /** Parts that still owe something. Empty means the whole plan is settled. */
  openParts: PartStatus[]
  /** True when every part is paid — the deal is fully collected. */
  fullySettled: boolean
}

function isDead(row: TrancheInvoiceRow): boolean {
  return (DEAD_INVOICE_STATUSES as readonly string[]).includes(row.invoice_status ?? "")
}

/**
 * Classify one part from its live invoice.
 *
 * The order of these checks matters. Paid is decided from the MONEY, not only from the status
 * word, because a bank match writes the amount before anything reconciles the label — a part with
 * its full amount received is paid whatever the status column currently says.
 */
function classify(part: PaymentPlanPart, live: TrancheInvoiceRow | null): PartState {
  if (!live) return "not_raised"

  const paid = Number(live.amount_paid ?? 0)
  const owed = Number(live.amount ?? part.amount)
  if (live.invoice_status === "Paid" || (owed > 0 && paid >= owed)) return "paid"
  if (paid > 0) return "part_paid"

  // Draft means nobody has told the client. Worth its own state rather than folding into
  // "awaiting payment": the wire matcher ignores a Draft entirely, so money against an unsent
  // part will not auto-match, and staff need to see that difference.
  if (live.invoice_status === "Draft") return "raised_unsent"
  return "awaiting_payment"
}

/** THE PURE CORE. Given a plan and every invoice carrying its lineage, say where each part stands. */
export function computePlanStatus(plan: PaymentPlan, rows: TrancheInvoiceRow[]): PlanStatus {
  const parts: PartStatus[] = plan.map((part) => {
    const mine = rows.filter((r) => Number(r.tranche_seq) === part.seq)
    const dead = mine.filter(isDead)
    const live = mine.find((r) => !isDead(r)) ?? null
    const state = classify(part, live)
    return {
      part,
      state,
      invoice: live,
      supersededInvoices: dead,
      obligationOpen: state !== "paid",
    }
  })

  return {
    plan,
    parts,
    openParts: parts.filter((p) => p.obligationOpen),
    fullySettled: parts.length > 0 && parts.every((p) => !p.obligationOpen),
  }
}

/**
 * Can this part be raised right now?
 *
 * Deliberately NOT "is it not_raised" — that would be a second, subtly different rule. A part is
 * raisable exactly when no live invoice occupies its slot, which is the same condition the
 * database enforces.
 */
export function isRaisable(status: PartStatus): boolean {
  return status.invoice === null
}

/**
 * Where an offer's plan stands, read from the database.
 *
 * Returns null when the offer carries no plan — which is every offer today — so callers can treat
 * "no plan" and "a plan with nothing raised" as the different things they are.
 */
export async function planStatusForOffer(offerToken: string): Promise<PlanStatus | null> {
  const { data: offer, error: offerErr } = await supabaseAdmin
    .from("offers")
    .select("token, payment_plan")
    .eq("token", offerToken)
    .maybeSingle()

  if (offerErr) throw new Error(`offer lookup failed: ${offerErr.message}`)
  if (!offer) return null

  const raw = (offer as { payment_plan?: unknown }).payment_plan
  if (raw == null) return null

  const parsed = validatePaymentPlan(raw)
  // A stored plan that no longer validates is a real possibility — a revision can change the
  // offer's total after the plan was written. Throwing here would take down the whole page; the
  // caller decides how loudly to complain, and the money rails already refuse on their own.
  if (!parsed.ok || !parsed.plan) return null

  // The column is not in the generated types yet (regenerating them is its own risky change), so
  // the select list is a plain string and the row shape is asserted rather than inferred.
  const { data: rows, error: rowsErr } = await supabaseAdmin
    .from("payments")
    .select("id, invoice_number, invoice_status, amount_paid, amount, tranche_seq, due_date")
    .eq("tranche_offer_token" as never, offerToken as never)

  if (rowsErr) throw new Error(`tranche invoice lookup failed: ${rowsErr.message}`)

  return computePlanStatus(parsed.plan, (rows ?? []) as unknown as TrancheInvoiceRow[])
}
