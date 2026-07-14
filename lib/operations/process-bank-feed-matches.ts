/**
 * processBankFeedMatches — PR B orchestrator.
 *
 * Walks a batch of td_bank_feeds rows through matchAndReconcile() and, when
 * the matcher auto-marks an invoice Paid (confidence='exact'|'partial'|
 * 'retroactive'), follows up by running the downstream activation chain on
 * any linked pending_activation. On activation failure the feed is parked at
 * status='activation_crashed' so it appears in the Reconciliation review
 * queue with a Retry button.
 *
 * Outcomes counted per feed:
 *   - auto_activated     — matcher auto-marked + linked PA reached `activated`
 *                          (or no PA was linked — i.e., the invoice was a
 *                          manual TD invoice paid by wire with no activation
 *                          attached, which is also a clean success).
 *   - needs_review       — matcher saved a candidate but did not auto-mark
 *                          (confidence below threshold). Surfaced in sidebar
 *                          badge for staff to confirm/reject.
 *   - activation_crashed — matcher auto-marked the invoice but runActivation
 *                          returned ok=false or threw. Surfaced in sidebar
 *                          badge for staff to retry.
 *   - no_match           — matcher returned no candidate at all.
 *
 * Errors from matchAndReconcile itself (rare — would mean Supabase failure)
 * are pushed to result.errors[] and processing continues.
 *
 * Called from cron / sync flows in PR C.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import { matchAndReconcile } from "@/lib/bank-feed-matcher"
import { runActivation } from "@/lib/operations/activate-service"
import { updateFeed } from "@/lib/finance/feed-write"

export interface ProcessBankFeedMatchesOpts {
  /** If provided, only these feed IDs are processed. If omitted, all
   *  td_bank_feeds rows with status='unmatched' are processed (oldest first,
   *  capped at 200 per run to bound runtime). */
  feedIds?: string[]
}

/** What happened to one feed — surfaced so callers can log it honestly. */
export interface FeedOutcome {
  feedId: string
  outcome:
    | "auto_activated"
    /** Matched, but nothing was activated: an audit link (no money moved) or a
     *  part-payment (the obligation is not met, so the service does not switch on). */
    | "matched_no_activation"
    | "needs_review"
    | "activation_crashed"
    | "no_match"
    | "error"
  matched: boolean
  invoiceNumber?: string
  confidence?: string
  /**
   * Whether MONEY was applied. A feed can be `matched` with moneyApplied=false —
   * the audit-link case, where the invoice was already settled through another
   * channel (e.g. the Stripe webhook closed it) and the feed is linked for the
   * trail only. Callers must not report that as a payment being reconciled.
   */
  moneyApplied?: boolean
  error?: string
}

export interface ProcessBankFeedMatchesResult {
  processed: number
  auto_activated: number
  /** Matched but NOT activated — audit links and part-payments. Never fold these into
   *  auto_activated: the cron log would claim activations that never happened. */
  matched_no_activation: number
  needs_review: number
  activation_crashed: number
  no_match: number
  errors: Array<{ feedId: string; error: string }>
  /** Per-feed outcomes, in processing order. */
  details: FeedOutcome[]
}

const BATCH_LIMIT = 200

/**
 * Process ONE feed through the full chain — match, then activate.
 *
 * This exists so the ingest paths (the Relay and Banking Circle webhooks, and the
 * run-matcher cron) can never again call `matchAndReconcile` directly. That function
 * marks an invoice Paid but has no knowledge of `pending_activations`, so a wire that
 * arrived through a webhook paid the client's invoice and NEVER ACTIVATED THEIR
 * SERVICE — and the cron could not rescue it, because the feed was no longer
 * 'unmatched' by the time the cron looked. Every path now goes through the
 * orchestrator, which owns the activation chain.
 *
 * Returns the matcher's own result (for logging) alongside the batch outcome.
 */
export async function processOneFeed(feedId: string): Promise<FeedOutcome> {
  const result = await processBankFeedMatches({ feedIds: [feedId] })
  return (
    result.details[0] ?? {
      feedId,
      outcome: "no_match",
      matched: false,
    }
  )
}

export async function processBankFeedMatches(
  opts: ProcessBankFeedMatchesOpts = {},
): Promise<ProcessBankFeedMatchesResult> {
  const result: ProcessBankFeedMatchesResult = {
    processed: 0,
    auto_activated: 0,
    matched_no_activation: 0,
    needs_review: 0,
    activation_crashed: 0,
    no_match: 0,
    errors: [],
    details: [],
  }

  // Resolve the list of feed IDs to walk.
  let feedIds: string[]
  if (opts.feedIds && opts.feedIds.length > 0) {
    feedIds = opts.feedIds
  } else {
    const { data, error } = await supabaseAdmin
      .from("td_bank_feeds")
      .select("id")
      .eq("status", "unmatched")
      .order("transaction_date", { ascending: true })
      .limit(BATCH_LIMIT)
    if (error) {
      result.errors.push({ feedId: "<batch-select>", error: error.message })
      return result
    }
    feedIds = (data ?? []).map(r => r.id)
  }

  for (const feedId of feedIds) {
    result.processed++
    let matchResult
    try {
      matchResult = await matchAndReconcile(feedId)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      result.errors.push({ feedId, error: msg })
      result.details.push({ feedId, outcome: "error", matched: false, error: msg })
      continue
    }

    const base = {
      feedId,
      matched: matchResult.matched,
      invoiceNumber: matchResult.invoiceNumber,
      confidence: matchResult.confidence,
      moneyApplied: matchResult.moneyApplied,
    }

    // Branch on outcome of matchAndReconcile.
    if (matchResult.matched && matchResult.paymentId) {
      // Do NOT activate on money that did not fully settle the invoice.
      //  - moneyApplied === false → an AUDIT LINK (the invoice was already paid via
      //    another channel). Nothing new was received; activating off it would fire
      //    the chain on a payment that was already handled.
      //  - confidence 'partial'  → the client part-paid. The obligation is not met, so
      //    the service must not switch on. Activation follows the closing payment.
      if (matchResult.moneyApplied === false || matchResult.confidence === "partial") {
        // Counted separately: reporting these as "activated" would be a lie in the cron
        // log — nothing was activated, and for an audit link no money even moved. This
        // is the number Antonio reads.
        result.matched_no_activation++
        result.details.push({ ...base, outcome: "matched_no_activation" })
        continue
      }

      // Auto-matched and fully settled. Now run activation if a pending_activation
      // is linked to this invoice.
      const { data: pa } = await supabaseAdmin
        .from("pending_activations")
        .select("id, status")
        .eq("portal_invoice_id", matchResult.paymentId)
        .in("status", ["awaiting_payment", "pending_confirmation", "payment_confirmed"])
        .maybeSingle()

      if (!pa) {
        // No activation chain linked — the invoice was a standalone TD
        // receivable (manual invoice paid by wire). The matcher already
        // marked it Paid; nothing more to do. Count as a clean win.
        result.auto_activated++
        result.details.push({ ...base, outcome: "auto_activated" })
        continue
      }

      // Run the activation. On failure, park the feed at activation_crashed
      // with the error stored in review_metadata so the admin can retry.
      let activationError: string | null = null
      try {
        const actResult = await runActivation(pa.id)
        if (!actResult.ok) {
          activationError = actResult.error ?? "runActivation returned ok=false"
        }
      } catch (err) {
        activationError = err instanceof Error ? err.message : String(err)
      }

      if (activationError) {
        const now = new Date().toISOString()
        // Through the verified writer. `activation_crashed` was NOT in production's CHECK
        // constraint until 2026-07-14 — so every one of these parks was silently rejected
        // and the feed was left looking cleanly matched while the client's service had in
        // fact failed to activate. The Retry button had nothing to act on because the queue
        // it reads from could never be written to.
        await updateFeed(feedId, {
          status: "activation_crashed",
          review_metadata: {
            activation_error: activationError,
            pending_activation_id: pa.id,
            crashed_at: now,
          },
        }, "orchestrator:activation-crashed")
        result.activation_crashed++
        result.details.push({ ...base, outcome: "activation_crashed", error: activationError })
      } else {
        result.auto_activated++
        result.details.push({ ...base, outcome: "auto_activated" })
      }
      continue
    }

    // matched=false branch.
    if (matchResult.paymentId) {
      // matchAndReconcile already wrote status='needs_review' for this row.
      result.needs_review++
      result.details.push({ ...base, outcome: "needs_review" })
    } else {
      result.no_match++
      result.details.push({ ...base, outcome: "no_match", error: matchResult.error })
    }
  }

  return result
}
