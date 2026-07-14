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
import { resolveInvoiceStatusAfterPayment } from "@/lib/finance/invoice-money"

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
