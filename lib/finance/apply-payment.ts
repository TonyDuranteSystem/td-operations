/**
 * applyMoneyToInvoice — the ONE writer of the `payments` money columns.
 *
 * Why this exists (2026-07-14, Simple Holdings / Fazekas incident): the system
 * had THREE money-application algorithms that disagreed with each other.
 *
 *   1. `settleInvoiceFromFeed` (manual match) — capped + ACCUMULATES
 *      amount_paid, writes amount_due. Correct.
 *   2. `syncInvoiceStatus('payment', …)` (the AUTO matcher) — OVERWRITES
 *      amount_paid and NEVER writes amount_due. A $500 invoice with $300 already
 *      paid, settled by a $200 wire, recorded amount_paid = $200. The $300 was
 *      silently erased.
 *   3. `confirmPayment`'s direct branch — writes status + amount_paid but never
 *      invoice_status and never amount_due, producing "half-closed" invoices
 *      (64 of them in production) that still read as open, still count as
 *      outstanding, and — because the matcher filtered on invoice_status alone —
 *      remained LIVE auto-match targets that could be credited a second time.
 *
 * One function now owns the decision. Every caller routes through it.
 *
 * INVARIANTS (each one is load-bearing — do not "simplify" them away):
 *  - NEVER credit a terminal invoice (see `isTerminalInvoice`). Returns
 *    `applied: false` with a reason instead of silently no-op'ing while
 *    reporting success — that silent-success is what hid the original bug.
 *  - NEVER apply the same bank transaction to the same invoice twice. When a
 *    `feedId` is given, an insert into `payment_applications` (UNIQUE on
 *    (feed_id, payment_id)) is the gate; a unique violation means "already
 *    applied" and the money write is SKIPPED. Because amount_paid now
 *    accumulates, this guard is what stands between us and double-crediting.
 *  - NEVER over-credit: amount_paid is capped at the invoice total by the
 *    shared, unit-tested `resolveInvoiceStatusAfterPayment`.
 *  - ALWAYS write the full coherent tuple (status, invoice_status, amount_paid,
 *    amount_due, paid_date) so the two status columns can never drift again.
 *  - ALWAYS leave an audit row. The cron/auto path previously moved client money
 *    with NO record in action_log at all.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import { isTerminalInvoice, terminalReason } from "@/lib/finance/invoice-matchability"
import {
  resolveInvoiceStatusAfterPayment,
  resolveInvoiceStatusAfterReversal,
} from "@/lib/finance/invoice-money"
import { capturePreVoidState, resolveReactivateTarget } from "@/lib/billing/invoice-reactivate"
import { reportSystemError } from "@/lib/system-errors"
import type { Json } from "@/lib/database.types"
import { describeReversalSideEffects, resolveTargetTaxYear } from "@/lib/finance/reversal-side-effects"

export type ApplyMode =
  /** Add `appliedAmount` to whatever is already paid (bank feed, part-payment). */
  | "apply"
  /** Settle the invoice in full — used when a caller asserts full settlement and passes no amount. */
  | "settle_full"

export interface ApplyMoneyParams {
  paymentId: string
  /** Required for mode 'apply'. Ignored for 'settle_full'. */
  appliedAmount?: number
  mode: ApplyMode
  paidDate: string
  paymentMethod?: string
  /** Who/what did this — lands in action_log and payment_applications. */
  actor: string
  /** Set for bank-feed settlement. Enables the double-credit guard. */
  feedId?: string
  /**
   * The result of the Stripe refund re-check, when one applies ("ok" | "unchecked").
   * Recorded in the audit row: a safety gate you cannot prove ran is a safety gate you
   * will eventually stop trusting.
   */
  refundCheck?: string
}

export interface ApplyMoneyResult {
  applied: boolean
  /** Why nothing was applied — 'terminal' | 'already_applied' | 'not_found' | 'zero_amount' */
  reason?: string
  detail?: string
  invoiceNumber?: string
  newStatus?: "Paid" | "Partial"
  newAmountPaid?: number
  newAmountDue?: number
}

/**
 * Has THIS bank transaction already applied money to THIS invoice?
 *
 * The ledger is the only thing that knows for certain. A `reason` code cannot tell you:
 * "terminal" means the invoice is closed, but it CANNOT distinguish "someone else closed
 * it" from "this very transaction closed it and we then failed to record the link". Those
 * two need opposite answers, and guessing gives staff the wrong one — telling them no money
 * was applied while this transaction's money sits on that invoice, with a confirmed row
 * proving it.
 *
 * Only a CONFIRMED row counts. An unconfirmed claim is an attempt that died mid-write; it
 * is evidence that someone started, not that money moved.
 *
 * ⚠️ KNOWN, BOUNDED GAP — deliberately left alone. If the money write lands but the
 * CONFIRMATION write then fails (the path that already logs "MONEY APPLIED BUT CLAIM NOT
 * CONFIRMED"), the row stays unconfirmed, so a later retry reads `false` here and records
 * the transaction as an audit link saying "no money applied" — the same mislabel, in a far
 * narrower hole. It CANNOT double-credit: the terminal guard and the compare-and-swap both
 * block that, and it is loud in the logs. Closing it means teaching manualMatch about
 * unconfirmed rows, i.e. more control-flow surgery on a path where money is not at risk —
 * and this cycle has repeatedly shown that the marginal fix costs more than it prevents.
 * Documented rather than coded, on purpose.
 */
export async function hasConfirmedApplication(feedId: string, paymentId: string): Promise<boolean> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- table not in generated types
  const db = supabaseAdmin as any
  const { data } = await db
    .from("payment_applications")
    .select("id")
    .eq("feed_id", feedId)
    .eq("payment_id", paymentId)
    .not("confirmed_at", "is", null)
    .maybeSingle()

  return data != null
}

export async function applyMoneyToInvoice(params: ApplyMoneyParams): Promise<ApplyMoneyResult> {
  const { paymentId, mode, paidDate, paymentMethod, actor, feedId } = params

  const { data: payment } = await supabaseAdmin
    .from("payments")
    .select("id, invoice_number, invoice_status, status, total, amount, amount_paid, portal_invoice_id, account_id, contact_id")
    .eq("id", paymentId)
    .maybeSingle()

  if (!payment) {
    return { applied: false, reason: "not_found", detail: "Invoice not found." }
  }

  // ── Guard 1: terminal invoices are never credited ───────────────────────
  // A feed may still LINK to a Paid invoice for the audit trail (that is how a
  // Stripe payment gets tied to the invoice its own webhook already closed) —
  // but no money is written. The caller decides whether to record the link.
  if (isTerminalInvoice(payment)) {
    return {
      applied: false,
      reason: "terminal",
      detail: terminalReason(payment) ?? "Invoice is closed.",
      invoiceNumber: payment.invoice_number ?? undefined,
    }
  }

  const invoiceTotal = Number(payment.total ?? payment.amount ?? 0)
  const currentPaid = Number(payment.amount_paid ?? 0)

  const appliedAmount =
    mode === "settle_full"
      ? Math.max(invoiceTotal - currentPaid, 0)
      : Number(params.appliedAmount ?? 0)

  if (!(appliedAmount > 0)) {
    return {
      applied: false,
      reason: "zero_amount",
      detail: "Nothing to apply — amount is zero.",
      invoiceNumber: payment.invoice_number ?? undefined,
    }
  }

  // Work out what will ACTUALLY be credited before claiming it. The cap matters:
  // a $650 wire against a $500 balance credits $500, not $650. Claiming the raw
  // amount would make the ledger disagree with the invoice, which defeats the
  // point of having a ledger.
  const { newStatus, newAmountPaid, newAmountDue } = resolveInvoiceStatusAfterPayment(
    invoiceTotal,
    currentPaid,
    appliedAmount,
  )
  const creditedAmount = newAmountPaid - currentPaid

  // ── Guard 2: the double-credit lock ─────────────────────────────────────
  // Claim the (feed, invoice) pair BEFORE writing money. The UNIQUE constraint
  // makes this atomic — a concurrent double-click loses the race and applies
  // nothing. Only bank-feed settlement carries a feedId; other channels (Stripe
  // webhook, manual mark-paid) are guarded by confirmPayment's already-paid
  // short-circuit.
  //
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- table not in generated types
  const db = supabaseAdmin as any

  // How long an UNCONFIRMED claim is honoured before we treat it as the debris of a
  // crashed attempt. Long enough that a slow-but-alive write is never stolen from;
  // short enough that a human retry isn't blocked for the rest of the day.
  const STALE_CLAIM_MS = 5 * 60 * 1000

  let claimId: string | null = null

  if (feedId) {
    // `payment_applications` is not in the generated Supabase types (same escape as
    // `system_errors`); see 20260714-1500-payment-applications.sql (+ confirmed_at).
    //
    // The claim is taken with confirmed_at NULL and confirmed only once the money has
    // actually landed. An unconfirmed claim is NOT proof that money moved — it is
    // proof that someone STARTED. That distinction is what stops a crashed attempt
    // from bricking the transaction forever behind a false "already applied".
    const { data: claimRow, error: claimErr } = await db
      .from("payment_applications")
      .insert({ feed_id: feedId, payment_id: paymentId, amount: creditedAmount, applied_by: actor })
      .select("id")
      .single()

    if (claimErr) {
      if (claimErr.code === "23505") {
        // Someone else holds the lock. Confirmed → the money really was applied.
        // Unconfirmed and old → the previous attempt died before writing; take it over.
        const { data: existing } = await db
          .from("payment_applications")
          .select("id, confirmed_at, applied_at")
          .eq("feed_id", feedId)
          .eq("payment_id", paymentId)
          .maybeSingle()

        const isStale =
          existing != null &&
          existing.confirmed_at == null &&
          Date.now() - new Date(existing.applied_at).getTime() > STALE_CLAIM_MS

        if (!isStale) {
          return {
            applied: false,
            reason: "already_applied",
            detail: "This transaction has already been applied to this invoice.",
            invoiceNumber: payment.invoice_number ?? undefined,
          }
        }

        // Reclaim the abandoned attempt — as a COMPARE-AND-SWAP, not a blind update.
        //
        // Matching on the exact `applied_at` we just read is what makes the takeover
        // EXCLUSIVE. Without it, two processes that both spot the same stale claim (the
        // 15-minute sync and the 6-hourly cron, or either plus a human clicking Match)
        // would BOTH pass the `confirmed_at IS NULL` check, BOTH succeed at the update,
        // and BOTH go on to credit the invoice. Zero rows back means someone else won
        // the race — stand down.
        const { data: retaken, error: retakeErr } = await db
          .from("payment_applications")
          .update({ amount: creditedAmount, applied_by: actor, applied_at: new Date().toISOString() })
          .eq("id", existing.id)
          .is("confirmed_at", null)
          .eq("applied_at", existing.applied_at)
          .select("id")

        if (retakeErr) {
          return {
            applied: false,
            reason: "guard_failed",
            detail: `Could not take over the stale payment lock: ${retakeErr.message}`,
            invoiceNumber: payment.invoice_number ?? undefined,
          }
        }

        if (!retaken || retaken.length === 0) {
          return {
            applied: false,
            reason: "already_applied",
            detail: "This transaction is already being applied by another process.",
            invoiceNumber: payment.invoice_number ?? undefined,
          }
        }

        claimId = existing.id as string
        console.warn(`[apply-payment] Took over a stale, unconfirmed claim for feed=${feedId} payment=${paymentId}`)
      } else {
        // Any other failure: refuse to write money we cannot record.
        return {
          applied: false,
          reason: "guard_failed",
          detail: `Could not record the payment application: ${claimErr.message}`,
          invoiceNumber: payment.invoice_number ?? undefined,
        }
      }
    } else {
      claimId = (claimRow?.id as string) ?? null
    }
  }

  /**
   * Release the lock WE took — by its own id, never by (feed, payment).
   *
   * Deleting by (feed_id, payment_id) is not safe: a delayed failing attempt could
   * delete a DIFFERENT attempt's row — one that had meanwhile succeeded and credited
   * the invoice. The lock would vanish while the money stayed applied, and the next
   * pass would credit it a second time. That is the precise failure this table exists
   * to prevent, so the release must be as precise as the claim.
   */
  const releaseClaim = async (): Promise<string> => {
    if (!claimId) return ""
    const { error: delErr } = await db
      .from("payment_applications")
      .delete()
      .eq("id", claimId)
      .is("confirmed_at", null) // never delete a claim that already committed money
    if (delErr) {
      console.error(`[apply-payment] FAILED TO RELEASE CLAIM ${claimId} (feed=${feedId} payment=${paymentId}):`, delErr.message)
      return " The retry lock could not be released — this transaction may need to be unlocked manually before it can be matched again."
    }
    return ""
  }

  const now = new Date().toISOString()

  // ── The coherent tuple — both status columns, both money columns, always ──
  // The `status` enum is stricter than `invoice_status`: only flip it to Paid on
  // full settlement; a Partial keeps its current enum status (Pending/Overdue).
  const updates: Record<string, unknown> = {
    invoice_status: newStatus,
    amount_paid: newAmountPaid,
    amount_due: newAmountDue,
    updated_at: now,
    ...(newStatus === "Paid" ? { status: "Paid", paid_date: paidDate } : {}),
    ...(paymentMethod ? { payment_method: paymentMethod } : {}),
  }

  // ── THE REAL GUARD: compare-and-swap on the invoice itself ───────────────
  //
  // The write only lands if `amount_paid` is still EXACTLY what we read a moment ago.
  // If anything else moved this invoice in between — a concurrent match, a retry, a
  // second process that took over the same abandoned lock — the row count comes back
  // zero and we apply nothing.
  //
  // It guards CONCURRENCY: a write computed from a stale read cannot land.
  //
  // It does NOT replace the ledger, which guards IDEMPOTENCY OVER TIME. Run the same
  // transaction through the matcher again an hour later and the CAS is perfectly happy —
  // it re-reads the new amount_paid and swaps cleanly. The only thing that says "this
  // transaction has already paid this invoice" is the UNIQUE (feed_id, payment_id) row.
  // Two different jobs, both load-bearing. DO NOT delete the ledger believing the CAS
  // has made it redundant.
  //
  // Why guarding `amount_paid` alone is sufficient: every money writer now goes through
  // this function, and this function always writes `amount_paid`. So any concurrent MONEY
  // write necessarily moves the guarded column and is caught. A concurrent status-only
  // flip (dunning marking an invoice Overdue) does not move it and slips past — but it
  // credits nothing, so it cannot double-credit. ⚠️ If a future writer ever touches money
  // WITHOUT touching `amount_paid`, this guard silently stops working.
  //
  // NULL and 0 are different values to Postgres, so the predicate has to match how the
  // row actually reads today (every invoice touched by the old writer has a NULL balance).
  // eslint-disable-next-line no-restricted-syntax -- THIS is the choke-point the rule points at (dev_task 7ebb1e0c)
  const casQuery = supabaseAdmin.from("payments").update(updates).eq("id", paymentId)

  const guarded =
    payment.amount_paid === null || payment.amount_paid === undefined
      ? casQuery.is("amount_paid", null)
      : casQuery.eq("amount_paid", payment.amount_paid)

  const { data: updatedRows, error: updErr } = await guarded.select("id")

  if (updErr) {
    // ⚠️ AN ERROR HERE DOES NOT MEAN THE WRITE FAILED.
    //
    // supabase-js reports an error whenever it fails to get a RESPONSE — including when
    // the UPDATE committed and the reply was lost (a timeout, a reset connection, the
    // function killed mid-flight). Assuming failure and releasing the lock is the exact
    // class of assumption this whole change exists to destroy: the next pass would find
    // no lock, re-read the (already credited) amount, and credit the SAME money again —
    // and the CAS cannot see it, because the retry reads the post-write value.
    //
    // So: go and look. The invoice itself is the source of truth.
    const { data: after, error: afterErr } = await supabaseAdmin
      .from("payments")
      .select("amount_paid")
      .eq("id", paymentId)
      .maybeSingle()

    // ⚠️ A READ WE COULD NOT PERFORM IS NOT EVIDENCE OF ANYTHING.
    //
    // This re-read fails in exactly the circumstances that made the write fail — the same
    // timeout, the same dropped connection, the same dying function. The failures are
    // CORRELATED, not independent. Swallowing this error would make "could not check"
    // indistinguishable from "read back an empty balance" — and on any invoice whose
    // amount_paid is NULL (every invoice the old writer touched, and every brand-new one)
    // that reads as "the write never happened", releases the lock, and lets the next pass
    // credit the same money again. The unsafe branch would be the COMMON one.
    //
    // Cannot verify ⇒ cannot release. Keep the lock, make a human look.
    if (afterErr) {
      console.error(
        `[apply-payment] Could not verify whether the write to ${paymentId} landed: ${afterErr.message}. Lock retained.`,
      )
      return {
        applied: false,
        reason: "guard_failed",
        detail:
          "The payment could not be confirmed and the invoice could not be re-read. It has been left locked for safety — please check this invoice before matching again.",
        invoiceNumber: payment.invoice_number ?? undefined,
      }
    }

    const afterPaid = after?.amount_paid ?? null
    const landed = afterPaid !== null && Math.abs(Number(afterPaid) - newAmountPaid) < 0.005
    const unchanged =
      (payment.amount_paid === null || payment.amount_paid === undefined)
        ? afterPaid === null
        : afterPaid !== null && Math.abs(Number(afterPaid) - Number(payment.amount_paid)) < 0.005

    if (landed) {
      // The money DID land; only the acknowledgement was lost. Confirm the claim and
      // report success — releasing here would set up a double credit on the next pass.
      if (claimId) {
        await db.from("payment_applications").update({ confirmed_at: now }).eq("id", claimId)
      }
      console.warn(
        `[apply-payment] Write to ${paymentId} reported an error but LANDED (${newAmountPaid}). Claim confirmed; treating as applied.`,
      )
      return {
        applied: true,
        invoiceNumber: payment.invoice_number ?? undefined,
        newStatus,
        newAmountPaid,
        newAmountDue,
      }
    }

    if (unchanged) {
      // The write genuinely did not happen. Safe to hand the lock back so this money can
      // be booked on a later attempt instead of being bricked behind a false
      // "already applied".
      const releaseNote = await releaseClaim()
      return {
        applied: false,
        reason: "write_failed",
        detail: `${updErr.message}${releaseNote}`,
        invoiceNumber: payment.invoice_number ?? undefined,
      }
    }

    // The invoice is in neither state we can reason about — something else moved it.
    // KEEP the lock (releasing it could permit a double credit) and make a human look.
    console.error(
      `[apply-payment] INDETERMINATE write on ${paymentId}: expected ${payment.amount_paid} -> ${newAmountPaid}, found ${afterPaid}. Lock retained; needs a human.`,
    )
    return {
      applied: false,
      reason: "guard_failed",
      detail:
        "The payment could not be confirmed as applied and the invoice is in an unexpected state. It has been left locked for safety — please check this invoice before matching again.",
      invoiceNumber: payment.invoice_number ?? undefined,
    }
  }

  if (!updatedRows || updatedRows.length === 0) {
    // Someone else moved this invoice between our read and our write. Applying now
    // would credit the same money twice. Stand down and hand the lock back.
    await releaseClaim()
    console.warn(
      `[apply-payment] Concurrent change detected on ${paymentId} — another process applied money first. Nothing written.`,
    )
    return {
      applied: false,
      reason: "already_applied",
      detail: "This invoice was updated by another process at the same moment — nothing was applied twice.",
      invoiceNumber: payment.invoice_number ?? undefined,
    }
  }

  // The money has landed. CONFIRM the claim — only a confirmed row is evidence that
  // money was actually applied, and only confirmed rows count toward the invariant
  // sum(confirmed applications) == payments.amount_paid — for BANK-FEED-settled invoices.
  // Money credited through the Stripe webhook, Whop, confirm-payment or activate-service
  // carries no feedId and so writes no ledger row; in general the rule is
  // sum(confirmed applications) <= amount_paid.
  if (claimId) {
    const { error: confirmErr } = await db
      .from("payment_applications")
      .update({ confirmed_at: now })
      .eq("id", claimId)
    if (confirmErr) {
      // The money IS applied. A missing confirmation makes the claim look stale, which
      // could later let the same money be applied a second time — so this must be loud.
      console.error(
        `[apply-payment] MONEY APPLIED BUT CLAIM ${claimId} NOT CONFIRMED (feed=${feedId} payment=${paymentId}):`,
        confirmErr.message,
      )
    }
  }

  // ── Mirrors: keep the client-visible copies in step ──────────────────────
  // client_expenses (what the client sees in the portal as a TD invoice).
  try {
    const { syncTDInvoiceStatus } = await import("@/lib/portal/td-invoice")
    await syncTDInvoiceStatus(paymentId, newStatus, newStatus === "Paid" ? paidDate : undefined, newAmountPaid)
  } catch (err) {
    console.error(`[apply-payment] client_expenses mirror failed for ${paymentId}:`, err)
  }

  // Legacy client_invoices link (older portal records).
  // supabase-js RETURNS errors, it does not throw them — a try/catch here would be
  // dead code and a failed mirror would vanish silently. Check `error` explicitly.
  if (payment.portal_invoice_id) {
    const { error: mirrorErr } = await supabaseAdmin
      .from("client_invoices")
      .update({
        status: newStatus,
        amount_paid: newAmountPaid,
        amount_due: newAmountDue,
        updated_at: now,
        ...(newStatus === "Paid" ? { paid_date: paidDate } : {}),
      })
      .eq("id", payment.portal_invoice_id)

    if (mirrorErr) {
      // The money IS applied — do not fail the operation. But this must be loud: the
      // client's portal copy now disagrees with the invoice.
      console.error(`[apply-payment] client_invoices mirror FAILED for ${paymentId}:`, mirrorErr.message)
    }
  }

  // ── Audit: the auto/cron path previously wrote NOTHING here ──────────────
  try {
    await supabaseAdmin.from("action_log").insert({
      actor,
      action_type: "payment_applied",
      table_name: "payments",
      record_id: paymentId,
      account_id: payment.account_id,
      contact_id: payment.contact_id,
      summary: `${newStatus === "Paid" ? "Settled" : "Part-paid"} ${payment.invoice_number ?? "invoice"}: ${creditedAmount} applied${feedId ? " from bank transaction" : ""}`,
      details: {
        payment_id: paymentId,
        feed_id: feedId ?? null,
        // What was actually credited (capped at the balance) vs what arrived.
        applied_amount: creditedAmount,
        received_amount: appliedAmount,
        previous_amount_paid: currentPaid,
        new_amount_paid: newAmountPaid,
        new_amount_due: newAmountDue,
        new_status: newStatus,
        mode,
        payment_method: paymentMethod ?? null,
        // Did the Stripe refund gate actually run for this money? "unchecked" means we
        // could not verify (no key / unknown charge) and proceeded anyway.
        refund_check: params.refundCheck ?? null,
      },
    })
  } catch (err) {
    console.error(`[apply-payment] action_log write failed for ${paymentId}:`, err)
  }

  return {
    applied: true,
    invoiceNumber: payment.invoice_number ?? undefined,
    newStatus,
    newAmountPaid,
    newAmountDue,
  }
}

// ════════════════════════════════════════════════════════════════════════════════════════
// REVERSAL — taking one transaction's money back off an invoice.
//
// ⛔ WHY THIS LIVES HERE AND NOT IN THE SERVER ACTION THAT CALLS IT.
// The compare-and-swap above is only sufficient "because every money writer goes through
// this function, and this function always writes amount_paid". A reversal helper written
// next to the UI would be a SECOND money writer and would silently retire that guarantee —
// the exact shape of the three-disagreeing-algorithms bug this module was created to end.
//
// ⛔ WHY THE LEDGER ROW IS UN-CONFIRMED, NOT DELETED (2026-07-29, Council).
// The first draft of this fix deleted the `payment_applications` row. That recreates, word
// for word, the failure `scripts/migrations/20260714-2200-…-restrict-delete.sql` was written
// to prevent: if the delete lands and the money write does not, the idempotency record is
// gone while the effect remains, and the next sync is free to credit that invoice again.
// Clearing `confirmed_at` instead keeps the row (and its history), and every existing reader
// already does the right thing with it:
//   • `hasConfirmedApplication` returns false → a legitimate re-match is possible again.
//   • the UNIQUE (feed_id, payment_id) insert still collides, and the collision branch above
//     treats an OLD unconfirmed claim as the debris of a crashed attempt and re-takes it
//     under a compare-and-swap. That is why `applied_at` is aged here.
//   • the scoped invariant sum(CONFIRMED applications) == amount_paid keeps holding.
// It needs no schema change, which matters: production DDL on this project is run by hand.
//
// ⛔ WHY MONEY MOVES FIRST AND THE LEDGER SECOND.
// Both orders can be interrupted; only one fails safe. Money-first, then ledger: if the
// second write dies, the row stays CONFIRMED on a re-opened invoice, which BLOCKS a
// re-credit. Ledger-first: the row is unconfirmed while the money is still applied, and the
// next pass credits it twice. The order is not a detail, it is the guarantee.
// ════════════════════════════════════════════════════════════════════════════════════════

export interface ReverseApplicationParams {
  feedId: string
  paymentId: string
  /** Who did this — lands in the audit row and on the reversed ledger row. */
  actor: string
  /** ISO `YYYY-MM-DD`, passed in so the open-state decision is testable. */
  today: string
}

export interface ReverseApplicationResult {
  reversed: boolean
  /** 'no_application' = this transaction never credited this invoice: nothing to reverse
   *  (the audit-link case). The caller must then NOT touch the invoice at all. */
  reason?: "no_application" | "not_found" | "write_failed" | "concurrent_change" | "indeterminate"
  detail?: string
  /** How much was taken back off the invoice. */
  amountReversed?: number
  newAmountPaid?: number
  newAmountDue?: number
  newInvoiceStatus?: string
  /** Set when the money was reversed but the ledger row could not be un-confirmed. The
   *  invoice is correct; the pair is locked until a human clears it. */
  warning?: string
  /** Plain-English statements about what the original payment set in motion that this
   *  reversal does NOT undo (a lifted tax gate, an internal email already sent). */
  sideEffects?: string[]
}

/**
 * Reverse the money ONE bank transaction applied to ONE invoice.
 *
 * Returns `reversed: false, reason: 'no_application'` when there is no confirmed ledger row
 * for the pair. That is not a failure — it is the audit-link case (a card charge tied to an
 * invoice its own webhook had already closed), and the caller must leave the invoice alone.
 * The first draft of this fix would have re-opened such an invoice and put a client who had
 * already paid back into the overdue-chaser population.
 */
export async function reverseFeedApplication(
  params: ReverseApplicationParams,
): Promise<ReverseApplicationResult> {
  const { feedId, paymentId, actor, today } = params
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- table not in generated types
  const db = supabaseAdmin as any

  const { data: ledgerRow } = await db
    .from("payment_applications")
    .select("id, amount, applied_at, applied_by")
    .eq("feed_id", feedId)
    .eq("payment_id", paymentId)
    .not("confirmed_at", "is", null)
    .maybeSingle()

  if (!ledgerRow) {
    return {
      reversed: false,
      reason: "no_application",
      detail: "This transaction never applied money to this invoice — nothing to reverse.",
    }
  }

  const { data: payment } = await supabaseAdmin
    .from("payments")
    .select(
      "id, invoice_number, invoice_status, status, total, amount, amount_paid, amount_due, paid_date, due_date, sent_at, portal_invoice_id, account_id, contact_id, credit_remaining, installment, description, year",
    )
    .eq("id", paymentId)
    .maybeSingle()

  if (!payment) {
    return { reversed: false, reason: "not_found", detail: "Invoice not found." }
  }

  const invoiceTotal = Number(payment.total ?? payment.amount ?? 0)
  const currentPaid = Number(payment.amount_paid ?? 0)
  const credited = Number(ledgerRow.amount ?? 0)

  const { newAmountPaid, newAmountDue, keepPaidDate } = resolveInvoiceStatusAfterReversal(
    invoiceTotal,
    currentPaid,
    credited,
  )
  const amountReversed = Math.round((currentPaid - newAmountPaid) * 100) / 100

  // What state is this invoice honestly in now? Derived from the truth (remaining balance,
  // due date, whether it was ever emailed) — NOT restored from a snapshot, because a
  // snapshot carries the PRE-reversal amount_paid and restoring it verbatim would put the
  // reversed money straight back on the invoice. The snapshot is written to the audit row
  // for forensics only, under its own key, and is never read back as a restore source.
  const target = resolveReactivateTarget({
    prior: null,
    total: invoiceTotal,
    amountPaid: newAmountPaid,
    dueDate: (payment.due_date as string | null) ?? null,
    today,
    wasSent: !!payment.sent_at,
  })

  const now = new Date().toISOString()
  const updates: Record<string, unknown> = {
    invoice_status: target.invoice_status,
    status: target.status,
    amount_paid: newAmountPaid,
    amount_due: newAmountDue,
    updated_at: now,
    ...(keepPaidDate ? {} : { paid_date: null }),
  }

  // ── MONEY FIRST, under the same compare-and-swap the apply path uses ──────────────────
  // eslint-disable-next-line no-restricted-syntax -- the money choke-point (dev_task 7ebb1e0c)
  const casQuery = supabaseAdmin.from("payments").update(updates).eq("id", paymentId)
  const guarded =
    payment.amount_paid === null || payment.amount_paid === undefined
      ? casQuery.is("amount_paid", null)
      : casQuery.eq("amount_paid", payment.amount_paid)

  const { data: updatedRows, error: updErr } = await guarded.select("id")

  if (updErr) {
    // Same reasoning as the apply path: an error is not proof of failure. Go and look.
    const { data: after, error: afterErr } = await supabaseAdmin
      .from("payments")
      .select("amount_paid")
      .eq("id", paymentId)
      .maybeSingle()

    if (afterErr) {
      console.error(
        `[apply-payment] REVERSAL could not be verified for ${paymentId}: ${afterErr.message}. Ledger row left CONFIRMED (blocks re-credit).`,
      )
      return {
        reversed: false,
        reason: "indeterminate",
        detail:
          "The reversal could not be confirmed and the invoice could not be re-read. Nothing was unlocked — please check this invoice before matching it again.",
      }
    }

    const afterPaid = after?.amount_paid ?? null
    const landed = afterPaid !== null && Math.abs(Number(afterPaid) - newAmountPaid) < 0.005
    if (!landed) {
      return {
        reversed: false,
        reason: "write_failed",
        detail: `The invoice could not be updated: ${updErr.message}. Nothing was reversed.`,
      }
    }
    console.warn(`[apply-payment] REVERSAL on ${paymentId} reported an error but LANDED.`)
  } else if (!updatedRows || updatedRows.length === 0) {
    // Another process moved this invoice between our read and our write. Reversing from a
    // stale read could erase money that arrived in the meantime. Stand down — and leave the
    // ledger row confirmed, so nothing can be re-credited either.
    console.warn(
      `[apply-payment] Concurrent change on ${paymentId} — reversal stood down, nothing written.`,
    )
    return {
      reversed: false,
      reason: "concurrent_change",
      detail:
        "This invoice changed while the reversal was being prepared, so nothing was reversed. Try again.",
    }
  }

  // ── LEDGER SECOND: un-confirm, and age the claim so the stale-claim takeover can re-take
  // it if this transaction is later legitimately matched to this same invoice again. ──────
  const AGED_MS = 10 * 60 * 1000 // comfortably past the 5-minute stale-claim window
  let warning: string | undefined
  const { error: unconfirmErr } = await db
    .from("payment_applications")
    .update({
      confirmed_at: null,
      applied_at: new Date(Date.now() - AGED_MS).toISOString(),
      applied_by: `reversed:${actor}`,
    })
    .eq("id", ledgerRow.id)

  if (unconfirmErr) {
    warning =
      "The money was taken off the invoice, but the transaction could not be unlocked. It cannot be matched again until that is cleared."
    console.error(
      `[apply-payment] MONEY REVERSED BUT LEDGER ROW ${ledgerRow.id} STILL CONFIRMED (feed=${feedId} payment=${paymentId}):`,
      unconfirmErr.message,
    )
    await reportSystemError({
      source: "server",
      route: "lib/finance/apply-payment#reverseFeedApplication",
      message: `Reversal left a confirmed ledger row: feed ${feedId} / invoice ${paymentId}. The invoice is correct but the pair is locked.`,
      context: { feedId, paymentId, ledgerRowId: ledgerRow.id, error: unconfirmErr.message },
    }).catch(() => {})
  }

  // ── Mirrors: ADD the balance projection, never REPLACE the status sync ────────────────
  // syncTDInvoiceStatus is the ONLY emitter of the staff "Client paid" note, so it must keep
  // being called; it maps the STATUS only and leaves the mirror's balances stale (which is
  // how a Paid mirror ended up still demanding the full amount). syncTDInvoiceMirror is the
  // authoritative projection. Both, status first.
  try {
    const { syncTDInvoiceStatus } = await import("@/lib/portal/td-invoice")
    await syncTDInvoiceStatus(paymentId, target.invoice_status, undefined, newAmountPaid)
  } catch (err) {
    console.error(`[apply-payment] reversal status mirror failed for ${paymentId}:`, err)
  }
  try {
    const { syncTDInvoiceMirror } = await import("@/lib/portal/td-invoice-mirror")
    await syncTDInvoiceMirror(paymentId)
  } catch (err) {
    console.error(`[apply-payment] reversal balance mirror failed for ${paymentId}:`, err)
  }

  // Legacy client_invoices copy — the apply path mirrors it, so the reversal must too, or a
  // client-visible record keeps saying Paid with the full amount credited.
  if (payment.portal_invoice_id) {
    const { error: mirrorErr } = await supabaseAdmin
      .from("client_invoices")
      .update({
        status: target.invoice_status,
        amount_paid: newAmountPaid,
        amount_due: newAmountDue,
        updated_at: now,
        ...(keepPaidDate ? {} : { paid_date: null }),
      })
      .eq("id", payment.portal_invoice_id)
    if (mirrorErr) {
      console.error(
        `[apply-payment] client_invoices reversal mirror FAILED for ${paymentId}:`,
        mirrorErr.message,
      )
    }
  }

  // ── What else did settling this invoice set in motion? ───────────────────────────────────
  // Derived from live state, never from a stored inventory (see reversal-side-effects.ts).
  // Anything that fired and is NOT rolled back is raised where staff actually look, because a
  // consequence recorded only in an audit table nobody opens is not visibility — this codebase
  // already lost months to a review queue that was empty because nothing surfaced it.
  const targetTaxYear = resolveTargetTaxYear({
    installment: (payment.installment as string | null) ?? null,
    description: (payment.description as string | null) ?? null,
    year: (payment.year as number | null) ?? null,
  })

  let taxReturnRow: { tax_year: number; paid: boolean; status: string | null } | null = null
  let otherPaidPaymentExists = false
  if (targetTaxYear != null && payment.account_id) {
    const { data: tr } = await supabaseAdmin
      .from("tax_returns")
      .select("tax_year, paid, status")
      .eq("account_id", payment.account_id)
      .eq("tax_year", targetTaxYear)
      .maybeSingle()
    if (tr) {
      taxReturnRow = {
        tax_year: Number(tr.tax_year),
        paid: !!tr.paid,
        status: (tr.status as string | null) ?? null,
      }
    }
    const { data: siblings } = await supabaseAdmin
      .from("payments")
      .select("id, installment, description")
      .eq("account_id", payment.account_id)
      .eq("year", payment.year as number)
      .eq("status", "Paid")
      .neq("id", paymentId)
    otherPaidPaymentExists = (siblings ?? []).some((sib) => {
      const inst = (sib.installment as string | null) ?? ""
      const desc = ((sib.description as string | null) ?? "").toLowerCase()
      return /^Installment/i.test(inst) || desc.includes("tax return") || desc.includes("tax filing")
    })
  }

  const sideEffects = describeReversalSideEffects({
    invoiceNumber: (payment.invoice_number as string | null) ?? null,
    installment: (payment.installment as string | null) ?? null,
    description: (payment.description as string | null) ?? null,
    year: (payment.year as number | null) ?? null,
    taxReturn: taxReturnRow,
    otherPaidPaymentExists,
  })

  if (sideEffects.needsAttention) {
    await reportSystemError({
      source: "server",
      route: "lib/finance/apply-payment#reverseFeedApplication",
      message:
        `Un-matching ${payment.invoice_number ?? "an invoice"} did not undo everything the original payment set in motion: ` +
        sideEffects.statements.join(" "),
      context: { paymentId, feedId, statements: sideEffects.statements, targetTaxYear },
    }).catch(() => {})
  }

  // ── Audit: one row, and it is also what the "what fired" checklist renders from ──
  try {
    await supabaseAdmin.from("action_log").insert({
      actor,
      action_type: "payment_reversed",
      table_name: "payments",
      record_id: paymentId,
      account_id: payment.account_id,
      contact_id: payment.contact_id,
      summary: `Reversed ${amountReversed} from ${payment.invoice_number ?? "invoice"} — bank transaction un-matched`,
      details: {
        payment_id: paymentId,
        feed_id: feedId,
        ledger_row_id: ledgerRow.id,
        amount_reversed: amountReversed,
        credited_amount_on_ledger: credited,
        previous_amount_paid: currentPaid,
        new_amount_paid: newAmountPaid,
        new_amount_due: newAmountDue,
        new_invoice_status: target.invoice_status,
        new_status: target.status,
        ledger_unconfirmed: !unconfirmErr,
        side_effects: sideEffects.statements,
        side_effects_need_attention: sideEffects.needsAttention,
        // Forensics only — deliberately NOT under `pre_void_state`, which the un-cancel path
        // scans for and would otherwise restore, bringing a cancelled invoice back as Paid.
        pre_unlink_state: capturePreVoidState({
          status: payment.status as string | null,
          invoice_status: payment.invoice_status as string | null,
          amount_due: payment.amount_due as number | null,
          amount_paid: payment.amount_paid as number | null,
          paid_date: payment.paid_date as string | null,
          credit_remaining: payment.credit_remaining as number | null,
        }),
      } as unknown as Json,
    })
  } catch (err) {
    console.error(`[apply-payment] reversal audit row failed for ${paymentId}:`, err)
  }

  return {
    reversed: true,
    amountReversed,
    newAmountPaid,
    newAmountDue,
    newInvoiceStatus: target.invoice_status,
    warning,
    sideEffects: sideEffects.statements,
  }
}

/**
 * Every CONFIRMED (transaction → this invoice) application, so a caller un-matching an
 * invoice can reverse each one with its OWN recorded amount.
 *
 * ⛔ DO NOT find these by `td_bank_feeds.matched_payment_id`. A wire split across several
 * invoices stamps that column with only the FIRST one, so invoices 2..N of a waterfall are
 * invisible to a search by pointer — reversing "the" feed would leave their money credited
 * with no transaction behind it. The ledger is the only complete record.
 */
export async function listConfirmedApplications(
  paymentId: string,
): Promise<Array<{ id: string; feed_id: string; amount: number }>> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- table not in generated types
  const db = supabaseAdmin as any
  const { data } = await db
    .from("payment_applications")
    .select("id, feed_id, amount")
    .eq("payment_id", paymentId)
    .not("confirmed_at", "is", null)
  return (data ?? []) as Array<{ id: string; feed_id: string; amount: number }>
}

/**
 * The stronger form of {@link hasConfirmedApplication}: is this transaction's money not just
 * RECORDED against this invoice, but actually SITTING on it?
 *
 * ⛔ WHY THE WEAKER CHECK IS NOT ENOUGH ON THE MANUAL PATH.
 * A confirmed ledger row is normally proof that money moved. But a reversal that removed the
 * money and then failed to un-confirm the row leaves the two disagreeing — and the manual
 * match path reads that row, concludes "the money is already there", marks the transaction
 * matched and reports SUCCESS to the operator while applying nothing. Staff would then go
 * looking for money that is not on the invoice. Comparing the row against the invoice's own
 * balance closes it: the ledger must be corroborated by the money it claims to describe.
 */
export async function confirmedApplicationIsBackedByMoney(
  feedId: string,
  paymentId: string,
): Promise<boolean> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- table not in generated types
  const db = supabaseAdmin as any
  const { data: row } = await db
    .from("payment_applications")
    .select("amount")
    .eq("feed_id", feedId)
    .eq("payment_id", paymentId)
    .not("confirmed_at", "is", null)
    .maybeSingle()
  if (!row) return false

  const { data: payment } = await supabaseAdmin
    .from("payments")
    .select("amount_paid")
    .eq("id", paymentId)
    .maybeSingle()

  const paid = Number(payment?.amount_paid ?? 0)
  const claimed = Number(row.amount ?? 0)
  if (paid + 0.005 >= claimed) return true

  console.error(
    `[apply-payment] LEDGER DISAGREES WITH THE INVOICE: feed ${feedId} claims ${claimed} applied to ${paymentId}, which shows ${paid} paid. Treating the money as NOT applied.`,
  )
  await reportSystemError({
    source: "server",
    route: "lib/finance/apply-payment#confirmedApplicationIsBackedByMoney",
    message: `A confirmed payment application is not backed by the invoice's balance (feed ${feedId} / invoice ${paymentId}): ledger says ${claimed}, invoice shows ${paid} paid.`,
    context: { feedId, paymentId, claimed, paid },
  }).catch(() => {})
  return false
}
