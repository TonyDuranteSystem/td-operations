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
  PLAN_TOTAL_TOLERANCE,
  type PaymentPlan,
  type PaymentPlanPart,
  planCurrency,
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
  /** Set by bookCardFee once a card payment lands — the fee portion ALREADY folded into
   *  `amount`/`total` above. Needed to back it back out for anything computing a commission,
   *  which must be a percentage of the real contract price, never of the card-processing fee. */
  card_fee_amount?: number | null
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
 * Which parts the auto-raise cron should act on RIGHT NOW — a date-triggered part whose date has
 * arrived, with no live invoice already occupying its slot.
 *
 * Deliberately reuses `isRaisable` rather than re-deriving "not raised" — same reasoning as that
 * function's own comment: a part a staffer already raised (even Draft/unsent) is NOT raisable,
 * and the cron must never mint a second invoice for a slot a human is already handling.
 *
 * `todayIso` is an explicit argument, not `new Date()` read inside — this codebase's own pattern
 * for date-based cron eligibility (see `decideReminder`/`decideSlaTier`), so a test can assert
 * "3 days after the due date" without mocking the system clock.
 */
export function duePartsToAutoRaise(status: PlanStatus, todayIso: string): PartStatus[] {
  return status.parts.filter(
    (p) =>
      p.part.trigger.kind === "date" &&
      typeof p.part.trigger.date === "string" &&
      p.part.trigger.date <= todayIso &&
      isRaisable(p),
  )
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
    .select("id, invoice_number, invoice_status, amount_paid, amount, tranche_seq, due_date, card_fee_amount" as never)
    .eq("tranche_offer_token" as never, offerToken as never)

  if (rowsErr) throw new Error(`tranche invoice lookup failed: ${rowsErr.message}`)

  return computePlanStatus(parsed.plan, (rows ?? []) as unknown as TrancheInvoiceRow[])
}

/** One part's cash-settlement standing — the input to a real "release commission" decision. */
export interface PlanSettlementPart {
  seq: number
  /** What this part was actually billed for — the invoice's own amount once raised (the same
   *  precedence `classify()` uses: invoice amount first, plan amount only as a fallback for a
   *  part never raised), never the plan's stated figure once a real invoice disagrees with it. */
  agreedAmount: number
  /** `agreedAmount` with any booked card-processing fee subtracted back out — the REAL contract
   *  price for this part. `agreedAmount` itself is fee-INCLUSIVE once a card payment lands
   *  (bookCardFee raises the invoice's own total to base+fee), which is correct for "how much
   *  cash has genuinely moved" but wrong for anything computing a referrer's or partner's
   *  commission — that must be a percentage of what TD was actually owed for the service, never
   *  of the processing fee the client pays to be allowed to use a card. */
  agreedAmountExFee: number
  /** REAL cash received against this part. Never inflated by a credit-only settlement — see the
   *  ⛔ note on `settledInCash` below for why that distinction is the whole point of this type. */
  amountPaid: number
  /** True only when BOTH halves of Antonio's rule hold for this ONE part: the invoice reads
   *  Paid, AND the cash actually received covers what was billed (within PLAN_TOTAL_TOLERANCE —
   *  the same one-cent tolerance the rest of the plan math uses, absorbing float rounding, not a
   *  real shortfall). An unraised part (no invoice at all) is never settled. */
  settledInCash: boolean
}

export interface PlanSettlement {
  offerToken: string
  /** The plan's single currency — same rule as planCurrency: safe because validation already
   *  refused a mixed-currency plan. */
  currency: string
  parts: PlanSettlementPart[]
  /** Sum of every part's real agreed amount — what the client has actually been billed, part by
   *  part, as raised. Computed from the SAME rows `parts` is built from, so it cannot silently
   *  disagree with what `parts` itself says. */
  totalAgreed: number
  /** Sum of every part's `agreedAmountExFee` — the figure a referrer's or partner's commission
   *  must be computed from, never `totalAgreed` (see `agreedAmountExFee`'s own doc comment). */
  totalAgreedExFee: number
  /** Sum of every part's REAL cash received. Credit-only settlements contribute nothing here. */
  totalReceived: number
  /**
   * ⛔ THE RELEASE GATE — deliberately STRICTER than `PlanStatus.fullySettled`, and must never be
   * simplified into reusing it directly (ai-architect + senior-engineer, both independently,
   * 2026-08-13). `fullySettled` calls a part "paid" the moment `invoice_status==='Paid'` alone —
   * which a PURE CREDIT settlement (Regenerate, or an invoice born Paid because existing account
   * credit covered it at creation) can produce with ZERO real cash ever received. Antonio's rule
   * for releasing a referrer's or partner's commission is narrower: "we received the money AND
   * the invoice is marked Paid" — both halves, every part. `eligible` is that narrower answer;
   * `fullySettled` stays the looser one every OTHER screen already correctly shows for "is this
   * obligation closed" (a credit-covered deal is legitimately closed to the CLIENT — it just does
   * not yet justify paying a referrer who was promised a share of real revenue).
   *
   * ⚠️ A KNOWN, HONEST FALSE NEGATIVE — read before "fixing" this. Job `c2751393` verified 115
   * production invoices where the automatic bank-matcher settles a part correctly (status Paid,
   * real money genuinely received) but leaves the owing figure wrong, and in 6 of those 115 it
   * also failed to WRITE `amount_paid` at all — status says Paid, the money field says zero, and
   * the cash genuinely arrived regardless. This gate cannot tell that apart from a real pure-credit
   * settlement — both look identical on this row's two fields. The choice made here is deliberate:
   * `eligible` can go FALSE on a deal that really is fully paid, but can never go TRUE on one that
   * is not — a missed commission a human notices and releases by hand costs far less than an
   * automatic-looking payout on money never received. This is why release stays a HUMAN action
   * with the real numbers shown, not a fully automatic trigger: a person looking at the account can
   * see "Paid" on every invoice and choose to release anyway, informed, which this gate alone
   * cannot safely decide.
   */
  eligible: boolean
}

/**
 * THE PURE CORE (same split as `computePlanStatus`/`planStatusForOffer` above, deliberately):
 * given an already-computed `PlanStatus`, decide real-cash settlement with no database access —
 * so the actual money predicate is unit-testable directly, without a live offer.
 */
export function computePlanSettlementFromStatus(offerToken: string, status: PlanStatus): PlanSettlement {
  const round2 = (n: number) => Math.round(n * 100) / 100

  const parts: PlanSettlementPart[] = status.parts.map((p) => {
    const invoice = p.invoice
    const agreedAmount = invoice ? Number(invoice.amount ?? p.part.amount) : p.part.amount
    // A part never raised has no booked fee to strip; a raised one nets out whatever
    // bookCardFee actually added (0 for a wire/manual settlement — the column is null then).
    const agreedAmountExFee = round2(agreedAmount - Number(invoice?.card_fee_amount ?? 0))
    const amountPaid = invoice ? Number(invoice.amount_paid ?? 0) : 0
    const settledInCash =
      invoice != null &&
      invoice.invoice_status === "Paid" &&
      amountPaid >= agreedAmount - PLAN_TOTAL_TOLERANCE
    return { seq: p.part.seq, agreedAmount, agreedAmountExFee, amountPaid, settledInCash }
  })

  return {
    offerToken,
    currency: planCurrency(status.plan),
    parts,
    totalAgreed: round2(parts.reduce((s, p) => s + p.agreedAmount, 0)),
    totalAgreedExFee: round2(parts.reduce((s, p) => s + p.agreedAmountExFee, 0)),
    totalReceived: round2(parts.reduce((s, p) => s + p.amountPaid, 0)),
    eligible: parts.length > 0 && parts.every((p) => p.settledInCash),
  }
}

/**
 * Real-cash plan settlement — the single answer to "can this deal's referrer/partner commission
 * be released?" Reuses `planStatusForOffer`'s own join (does not re-query) and applies the
 * stricter cash+Paid predicate on top of those SAME rows, so this can never see a different
 * invoice universe than every other screen reading the same offer's plan.
 */
export async function computePlanSettlement(offerToken: string): Promise<PlanSettlement | null> {
  const status = await planStatusForOffer(offerToken)
  if (!status) return null
  return computePlanSettlementFromStatus(offerToken, status)
}

/**
 * The card-fee rate a LATER part of a plan must inherit (council, 2026-08-11) — the single,
 * shared implementation. Part one gets its rate pinned by the signing webhook; without this, a
 * part raised after that — by a staffer or by the auto-raise cron — would otherwise pin whatever
 * the CURRENT configured rate is, charging a card fee a signed, waived-fee agreement never
 * carried. Two callers need the identical answer (the manual "Raise invoice" action and the
 * auto-raise cron); this exists so there is exactly one implementation, not two that can drift
 * (bug-hunter finding, 2026-08-27 auto-raise review: a second hand-rolled copy is exactly the
 * bug class already fixed once as dev_task 6ec6872a).
 *
 * Resolution order: part 1's OWN stamped rate (what was actually charged), falling back to the
 * offer's pinned `card_fee_rate` column only if part 1 was never raised/charged through Stripe.
 * Both reads are edge-cast: the tranche columns and `offers.card_fee_rate` postdate the
 * deliberately-stale generated types (same pattern as the plan fetch in activation).
 */
export async function resolveTrancheCardFeeRate(offerToken: string): Promise<number | undefined> {
  const part1Query = supabaseAdmin
    .from("payments")
    .select("card_fee_rate" as never) as unknown as {
      eq: (c: string, v: unknown) => {
        eq: (c: string, v: unknown) => {
          limit: (n: number) => { maybeSingle: () => Promise<{ data: { card_fee_rate?: number | null } | null }> }
        }
      }
    }
  const { data: part1 } = await part1Query
    .eq("tranche_offer_token", offerToken)
    .eq("tranche_seq", 1)
    .limit(1)
    .maybeSingle()
  if (typeof part1?.card_fee_rate === "number") return part1.card_fee_rate

  const offerQuery = supabaseAdmin
    .from("offers")
    .select("card_fee_rate" as never)
    .eq("token", offerToken) as unknown as {
      maybeSingle: () => Promise<{ data: { card_fee_rate?: number | null } | null }>
    }
  const { data: offerRow } = await offerQuery.maybeSingle()
  return typeof offerRow?.card_fee_rate === "number" ? offerRow.card_fee_rate : undefined
}
