/**
 * Two-step flow for a My Finances transaction that's actually a client
 * paying an invoice (Antonio's own design, corrected 2026-09-11 after an
 * earlier draft put the invoice/note/write-off popup in the wrong place):
 *
 *   1. sendOwnerTransactionToFinance — a simple action FROM My Finances.
 *      Moves the transaction over so it becomes a normal, visible row in
 *      Finance. No invoice is picked yet.
 *   2. linkFeedTransactionToInvoice — the popup that lives IN Finance. Pick
 *      the invoice, write a note, say whether this fully closes it (writing
 *      off whatever's left).
 *
 * WHY STEP 1 DOES NOT LEAVE THE ROW AS A PLAIN, UNSTAMPED "unmatched" FEED
 * ROW (council review, first design round): the automatic "maybe a client
 * payment" sweep (sweepFeedsToOwnerLedger, lib/finance/owner-ledger-projection.ts)
 * runs before the matcher on every cycle and would very likely reclaim an
 * ambiguous transaction — no invoice number in the wording, amount far
 * outside its own matching tolerance — before step 2 ever happens, undoing
 * the move. The new row is stamped with a `client_payment_claim` in its
 * review_metadata (lib/finance/feed-vocabulary.ts) — the owner has already
 * said this is a client payment, which is stronger evidence than anything
 * the sweep could infer on its own, and `isClientInvoicePayment` now checks
 * for it at the same tier as a true settlement.
 *
 * WHY STEP 2 APPLIES MONEY WITH A REAL feedId THIS TIME (unlike the
 * abandoned first draft, which applied straight from the My Finances row):
 * applyMoneyToInvoice's own double-credit lock (payment_applications, UNIQUE
 * on feed_id+payment_id) only exists when a feedId is passed. Routing
 * through a real td_bank_feeds row inherits that already-tested protection
 * for free instead of needing a bespoke one.
 *
 * WHY THE SOURCE ROW IN td_books_transactions IS ANNOTATED, NEVER DELETED
 * (council review): deleting it can silently understate a bank account's
 * displayed cash balance, makes the row invisible to the statement-upload
 * duplicate check (a later re-upload could silently re-add the same money
 * as "new"), and throws away any categorization/notes/tax-year linkage
 * already on the row. Its money is excluded from the owner's own P&L
 * instead (computeOwnerPnL, lib/owner-finance.ts) once moved_to_feed_id is
 * set — fixed 2026-09-11 after a bug-hunter pass on the first draft found
 * the row was still being silently double-counted there.
 *
 * WHY linkFeedTransactionToInvoice MARKS THE FEED "matched" (fixed 2026-09-11,
 * bug-hunter + senior-engineer, independently, second-round review of this
 * rebuild): without this write, nothing ever changes the feed's own status —
 * it would stay "unmatched" forever, so a second click on the same row
 * against a DIFFERENT invoice would sail straight past applyMoneyToInvoice's
 * double-credit lock (keyed on feed_id+payment_id — a different payment_id is
 * a different key) and credit the same cash twice, and the 15-minute
 * auto-matcher cron would eventually do the same on its own. Mirrors
 * manualMatchMulti's own updateFeed call (lib/bank-feed-matcher.ts) exactly.
 *
 * WHY THE WRITE-OFF NEVER GOES THROUGH updateInvoice({total: ...}) (fixed
 * 2026-09-11, ai-architect, same review round): that path unconditionally
 * runs adjustSingleServiceLineForTotal, which REFUSES whenever the invoice
 * has more than one adjustable line or any fee line — silently failing to
 * close the exact multi-line invoice a real write-off is likely to involve.
 * It's also the wrong shape for what actually happened: a write-off doesn't
 * mean the invoice was smaller, it means TD chose not to collect the rest of
 * a real, correctly-invoiced amount. `total` and the line items are left
 * exactly as invoiced; only `amount_due`/`status`/`invoice_status`/`paid_date`
 * change, via a direct write. The client_expenses mirror stays correct
 * automatically regardless — trg_sync_client_expense on `payments` fires on
 * this exact column set for every writer, not only updateInvoice.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import { applyMoneyToInvoice } from "@/lib/finance/apply-payment"
import { isTerminalInvoice, terminalReason, wasFullyPaid } from "@/lib/finance/invoice-matchability"
import { clientPaymentClaimMetadata } from "@/lib/finance/feed-vocabulary"
import { updateFeed } from "@/lib/finance/feed-write"
import { closePaymentWithWriteOff } from "@/lib/operations/payment"
import { reportSystemError } from "@/lib/system-errors"

// ═══════════════════════════════════════════════════════════════════════
// STEP 1 — My Finances: send a transaction to Finance.
// ═══════════════════════════════════════════════════════════════════════

export interface SendToFinanceResult {
  ok: boolean
  error?: string
  feedId?: string
}

function guessFeedSource(bankName: string | null): string {
  const n = (bankName ?? "").toLowerCase()
  if (n.includes("chase")) return "chase"
  if (n.includes("mercury")) return "mercury_api"
  if (n.includes("relay")) return "relay"
  if (n.includes("airwallex")) return "airwallex_api"
  if (n.includes("revolut")) return "revolut"
  return "manual"
}

export async function sendOwnerTransactionToFinance(
  transactionId: string,
  actor: string,
): Promise<SendToFinanceResult> {
  const { data: tx, error: txErr } = await supabaseAdmin
    .from("td_books_transactions")
    .select("id, amount, currency, transaction_date, bank_name, description, counterparty, moved_to_feed_id")
    .eq("id", transactionId)
    .maybeSingle()
  if (txErr) return { ok: false, error: `Could not read the transaction: ${txErr.message}` }
  if (!tx) return { ok: false, error: "Transaction not found." }
  if (tx.moved_to_feed_id) return { ok: false, error: "This transaction has already been sent to Finance." }
  const amount = Number(tx.amount)
  if (!(amount > 0)) return { ok: false, error: "Only money coming IN can be sent to Finance." }

  const nowIso = new Date().toISOString()
  const externalId = `books:${transactionId}`

  // Insert first — idempotent on external_id (the same primitive Plaid sync
  // itself relies on), so a retry after a dropped connection can never
  // create two feed rows for the same transaction.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- td_bank_feeds review_metadata/external_id upsert shape not in generated types' narrow Insert type for this path
  const db = supabaseAdmin as any
  const { data: feedRow, error: insErr } = await db
    .from("td_bank_feeds")
    .upsert(
      [{
        external_id: externalId,
        transaction_date: tx.transaction_date,
        amount,
        currency: tx.currency ?? "USD",
        source: guessFeedSource(tx.bank_name),
        sender_name: tx.counterparty ?? null,
        memo: tx.description ?? null,
        status: "unmatched",
        review_metadata: clientPaymentClaimMetadata(actor, nowIso),
      }],
      { onConflict: "external_id", ignoreDuplicates: true },
    )
    .select("id")
    .maybeSingle()

  if (insErr) return { ok: false, error: `Could not create the Finance-side transaction: ${insErr.message}` }

  let feedId = feedRow?.id as string | undefined
  if (!feedId) {
    // ignoreDuplicates means a row with this external_id already existed —
    // a previous attempt succeeded even though this call didn't see it come
    // back (e.g. a retried request). Read it back rather than treat this as
    // a failure.
    const { data: existing } = await db
      .from("td_bank_feeds")
      .select("id")
      .eq("external_id", externalId)
      .maybeSingle()
    feedId = existing?.id as string | undefined
  }
  if (!feedId) return { ok: false, error: "Could not confirm the Finance-side transaction was created." }

  const { error: markErr } = await supabaseAdmin
    .from("td_books_transactions")
    .update({ moved_to_feed_id: feedId })
    .eq("id", transactionId)
    .is("moved_to_feed_id", null)

  if (markErr) {
    console.error(`[owner-transaction-link] moved_to_feed_id write failed for ${transactionId}: ${markErr.message}`)
    await reportSystemError({
      source: "server",
      route: "lib/finance/owner-transaction-link#sendOwnerTransactionToFinance",
      message: `A Finance-side transaction (${feedId}) was created for My Finances row ${transactionId}, but marking the source row failed — it may still show as sendable and get duplicated on a retry.`,
      context: { transactionId, feedId, error: markErr.message },
    }).catch(() => {})
  }

  return { ok: true, feedId }
}

// ═══════════════════════════════════════════════════════════════════════
// STEP 2 — Finance: link a (now-visible) transaction to an invoice.
// ═══════════════════════════════════════════════════════════════════════

export interface LinkFeedToInvoiceParams {
  feedId: string
  paymentId: string
  note: string
  /** true = this settles the invoice for less than its full total; the
   *  remainder is written off. false = an ordinary partial payment on
   *  account, invoice stays open for the rest. */
  writeOffRemaining: boolean
  actor: string
}

export interface LinkFeedToInvoiceResult {
  ok: boolean
  error?: string
  invoiceNumber?: string
  newStatus?: string
  newAmountPaid?: number
  newAmountDue?: number
}

export async function linkFeedTransactionToInvoice(
  params: LinkFeedToInvoiceParams,
): Promise<LinkFeedToInvoiceResult> {
  const { feedId, paymentId, note, writeOffRemaining, actor } = params

  const { data: feed, error: feedErr } = await supabaseAdmin
    .from("td_bank_feeds")
    .select("id, amount, currency, transaction_date, status, source, external_id")
    .eq("id", feedId)
    .maybeSingle()
  if (feedErr) return { ok: false, error: `Could not read the transaction: ${feedErr.message}` }
  if (!feed) return { ok: false, error: "Transaction not found." }
  if (feed.status === "matched") {
    return { ok: false, error: "This transaction has already settled an invoice." }
  }

  const { data: payment, error: payErr } = await supabaseAdmin
    .from("payments")
    .select("id, invoice_number, invoice_status, status, total, amount, amount_paid, amount_currency, notes")
    .eq("id", paymentId)
    .maybeSingle()
  if (payErr) return { ok: false, error: `Could not read the invoice: ${payErr.message}` }
  if (!payment) return { ok: false, error: "Invoice not found." }
  if (isTerminalInvoice(payment)) {
    // Paid is the ONE terminal reason it's still legitimate to connect a
    // transaction here — the audit-trail link, no money applied, because the
    // money was already received some other way. Everything else terminal
    // (Voided, Cancelled, Credit, Split) keeps refusing outright below —
    // connecting money to those is never legitimate.
    //
    // wasFullyPaid, NOT isPaidInvoice — deliberately. isPaidInvoice ORs in the
    // coarse `status` column unconditionally, and a credit note's `status` is
    // ALSO always "Paid" from the moment it's created (see that predicate's
    // own doc comment, and wasFullyPaid's — a real, already-shipped-once
    // regression elsewhere in this file's neighborhood). Without this,
    // isTerminalInvoice(payment) is already true for a credit note via its
    // invoice_status="Credit", and isPaidInvoice(payment) would ALSO read
    // true off the same row's status="Paid" — silently audit-linking a
    // transaction to a credit note as "money already received", which is
    // backwards: a credit note is money owed back TO the client, not money
    // TD received. wasFullyPaid reads invoice_status first and only falls
    // back to `status` when invoice_status is absent, so a credit note
    // (invoice_status="Credit") never matches — it falls through to the
    // terminalReason refusal below instead, exactly like Voided/Cancelled/Split.
    //
    // Until 2026-09-15 the ONLY thing that could ever make this connection
    // was the automatic matcher's own retroactive pass (lib/bank-feed-matcher.ts)
    // guessing its way to it. A human choosing the invoice deliberately had
    // no equivalent and could only be told no — including, absurdly, a human
    // trying to manually redo a connection the machine had already made once
    // and someone had since undone. Found live: Antonio hit exactly that.
    if (wasFullyPaid(payment)) {
      const auditNote = `Invoice was already paid — linked for the audit trail; no money applied. ${note}`
      const auditClaim = await updateFeed(feedId, {
        matched_payment_id: paymentId,
        match_confidence: "manual",
        matched_at: new Date().toISOString(),
        matched_by: actor,
        status: "matched",
        review_metadata: {
          note: auditNote,
          link_kind: "manual",
          audit_link: true,
          money_applied: false,
        },
      }, "link-feed-transaction-to-invoice:audit-link")
      if (!auditClaim.ok) {
        return {
          ok: false,
          error: auditClaim.error ?? "Could not link this transaction.",
          invoiceNumber: payment.invoice_number ?? undefined,
        }
      }

      // Same mirror as the money-applying path below, so My Finances shows
      // "Linked" instead of being stuck on "Sent to Finance" — non-fatal,
      // reported rather than silently dropped (same reasoning as the
      // money-applying path's own mirror write, a few lines down).
      const { error: auditMirrorErr } = await supabaseAdmin
        .from("td_books_transactions")
        .update({ linked_payment_id: paymentId, linked_at: new Date().toISOString(), linked_note: note, linked_by: actor })
        .eq("moved_to_feed_id", feedId)
      if (auditMirrorErr) {
        console.error(`[owner-transaction-link] My Finances mirror write failed for feed ${feedId}: ${auditMirrorErr.message}`)
        await reportSystemError({
          source: "server",
          route: "lib/finance/owner-transaction-link#linkFeedTransactionToInvoice",
          message: `Audit-linked ${payment.invoice_number ?? paymentId} via feed ${feedId} (already paid elsewhere, no money applied), but mirroring the outcome back onto the My Finances row failed.`,
          context: { feedId, paymentId, error: auditMirrorErr.message },
        }).catch(() => {})
      }

      return {
        ok: true,
        invoiceNumber: payment.invoice_number ?? undefined,
        newStatus: payment.invoice_status ?? payment.status ?? "Paid",
        newAmountPaid: payment.amount_paid ?? undefined,
        newAmountDue: 0,
      }
    }
    return {
      ok: false,
      error: terminalReason(payment) ?? "This invoice is already closed.",
      invoiceNumber: payment.invoice_number ?? undefined,
    }
  }

  // Server-side refund/dispute re-check — bug-hunter, second review round:
  // the UI disables the button once a feed is ALREADY flagged refunded, but
  // that flag is set by a separate periodic pass and this is the only place
  // that actually settles money, so it must re-verify itself rather than
  // trust the UI or a stale flag — mirrors manualMatch's own gate
  // (lib/bank-feed-matcher.ts) so a card payment gets the same protection
  // through either path.
  if (feed.source === "stripe" && feed.external_id) {
    const { isChargeRefundedNow } = await import("@/lib/stripe-sync")
    const check = await isChargeRefundedNow(String(feed.external_id))
    if (check === "refunded") {
      await updateFeed(feedId, {
        status: "needs_review",
        matched_payment_id: paymentId,
        review_metadata: {
          refunded_or_disputed: true,
          candidate_payment_id: paymentId,
          checked_at: new Date().toISOString(),
        },
      }, "link-feed-transaction-to-invoice:refunded")
      return {
        ok: false,
        error: "This payment has been refunded or disputed — it was NOT applied to the invoice.",
        invoiceNumber: payment.invoice_number ?? undefined,
      }
    }
    if (check === "defer") {
      return {
        ok: false,
        error: "Could not verify this payment with Stripe right now — try again in a moment.",
        invoiceNumber: payment.invoice_number ?? undefined,
      }
    }
  }

  const applied = await applyMoneyToInvoice({
    paymentId,
    mode: "apply",
    appliedAmount: Number(feed.amount),
    paidDate: String(feed.transaction_date),
    actor,
    feedId,
  })

  if (!applied.applied) {
    return {
      ok: false,
      error: applied.detail ?? "Could not apply the payment.",
      invoiceNumber: payment.invoice_number ?? undefined,
    }
  }

  // Consume the feed — bug-hunter + senior-engineer pass, 2026-09-11: without
  // this, the row stays "unmatched" forever (nothing else in this function
  // ever wrote to it), so a second click here — on this same row, against a
  // DIFFERENT invoice — sails straight past applyMoneyToInvoice's own
  // double-credit lock (it's keyed on feed_id+payment_id, so a different
  // payment_id is a different key) and credits the same cash twice. The
  // 15-minute auto-matcher cron would eventually do the same. Mirrors
  // manualMatchMulti's own updateFeed call (lib/bank-feed-matcher.ts) exactly,
  // so this flow is consumed the identical way the ordinary matcher already
  // is — not a new, weaker guarantee.
  const feedClaim = await updateFeed(feedId, {
    matched_payment_id: paymentId,
    match_confidence: "manual",
    matched_at: new Date().toISOString(),
    matched_by: actor,
    status: "matched",
  }, "link-feed-transaction-to-invoice:link")
  if (!feedClaim.ok) {
    console.error(`[owner-transaction-link] feed consume failed for ${feedId}: ${feedClaim.error}`)
    await reportSystemError({
      source: "server",
      route: "lib/finance/owner-transaction-link#linkFeedTransactionToInvoice",
      message: `Payment applied to ${payment.invoice_number ?? paymentId} via feed ${feedId}, but marking the feed as matched failed — it may still show as unmatched and could be linked to a second invoice.`,
      context: { feedId, paymentId, error: feedClaim.error },
    }).catch(() => {})
  }

  const dated = `${new Date().toISOString().slice(0, 10)}: ${note}`
  const existingNotes = (payment as { notes?: string | null }).notes ?? null
  const combinedNotes = existingNotes ? `${existingNotes}\n${dated}` : dated

  // Mirror the outcome back onto the original My Finances row too, so it
  // shows the result without a second query. Non-fatal if it fails (the
  // money is already safely applied and the feed already consumed above) —
  // but checked and reported, not silently dropped: senior-engineer review,
  // 2026-09-11, found this previously ignored its own result, which could
  // leave My Finances permanently showing "Sent to Finance" instead of
  // "Linked ✓" with no visibility into why.
  const { error: mirrorErr } = await supabaseAdmin
    .from("td_books_transactions")
    .update({ linked_payment_id: paymentId, linked_at: new Date().toISOString(), linked_note: note, linked_by: actor })
    .eq("moved_to_feed_id", feedId)
  if (mirrorErr) {
    console.error(`[owner-transaction-link] My Finances mirror write failed for feed ${feedId}: ${mirrorErr.message}`)
    await reportSystemError({
      source: "server",
      route: "lib/finance/owner-transaction-link#linkFeedTransactionToInvoice",
      message: `Payment applied to ${payment.invoice_number ?? paymentId} via feed ${feedId}, but mirroring the outcome back onto the My Finances row failed — it may still show "Sent to Finance" instead of "Linked".`,
      context: { feedId, paymentId, error: mirrorErr.message },
    }).catch(() => {})
  }

  if (writeOffRemaining && (applied.newAmountDue ?? 0) > 0) {
    // Deliberately NOT routed through updateInvoice({total: ...}) — see
    // closePaymentWithWriteOff's own doc comment (lib/operations/payment.ts)
    // for why: that path unconditionally runs adjustSingleServiceLineForTotal
    // (app/(dashboard)/finance/actions.ts), which REFUSES whenever the
    // invoice has more than one adjustable line or any fee line — the exact
    // multi-line invoice this write-off is most likely to be used on would
    // silently fail to close (ai-architect finding, 2026-09-11).
    const closeResult = await closePaymentWithWriteOff({ paymentId, notes: combinedNotes })

    if (!closeResult.success) {
      // The payment IS applied (confirmed above, backed by a real
      // payment_applications row) and the feed is already consumed — only
      // the write-off's status flip failed. The invoice is correctly
      // Partial; nothing to roll back.
      return {
        ok: false,
        error: `The payment was applied, but closing the invoice failed: ${closeResult.error}. It's now correctly Partial — try closing it from the invoice's own Edit action.`,
        invoiceNumber: payment.invoice_number ?? undefined,
        newStatus: applied.newStatus,
        newAmountPaid: applied.newAmountPaid,
        newAmountDue: applied.newAmountDue,
      }
    }
    return {
      ok: true,
      invoiceNumber: payment.invoice_number ?? undefined,
      newStatus: "Paid",
      newAmountPaid: applied.newAmountPaid,
      newAmountDue: 0,
    }
  }

  const { updateInvoice } = await import("@/app/(dashboard)/finance/actions")
  const noteResult = await updateInvoice(paymentId, { notes: combinedNotes })
  if (!noteResult.success) {
    console.error(`[owner-transaction-link] note write failed for ${paymentId}: ${noteResult.error}`)
    await reportSystemError({
      source: "server",
      route: "lib/finance/owner-transaction-link#linkFeedTransactionToInvoice",
      message: `Payment applied to ${payment.invoice_number ?? paymentId} but the explanatory note failed to save.`,
      context: { paymentId, feedId, error: noteResult.error },
    }).catch(() => {})
  }

  return {
    ok: true,
    invoiceNumber: payment.invoice_number ?? undefined,
    newStatus: applied.newStatus,
    newAmountPaid: applied.newAmountPaid,
    newAmountDue: applied.newAmountDue,
  }
}
