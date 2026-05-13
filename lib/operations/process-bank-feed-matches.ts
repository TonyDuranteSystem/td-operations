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

export interface ProcessBankFeedMatchesOpts {
  /** If provided, only these feed IDs are processed. If omitted, all
   *  td_bank_feeds rows with status='unmatched' are processed (oldest first,
   *  capped at 200 per run to bound runtime). */
  feedIds?: string[]
}

export interface ProcessBankFeedMatchesResult {
  processed: number
  auto_activated: number
  needs_review: number
  activation_crashed: number
  no_match: number
  errors: Array<{ feedId: string; error: string }>
}

const BATCH_LIMIT = 200

export async function processBankFeedMatches(
  opts: ProcessBankFeedMatchesOpts = {},
): Promise<ProcessBankFeedMatchesResult> {
  const result: ProcessBankFeedMatchesResult = {
    processed: 0,
    auto_activated: 0,
    needs_review: 0,
    activation_crashed: 0,
    no_match: 0,
    errors: [],
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
      continue
    }

    // Branch on outcome of matchAndReconcile.
    if (matchResult.matched && matchResult.paymentId) {
      // Auto-matched (exact / partial / retroactive). Now run activation if
      // a pending_activation is linked to this invoice.
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
        // eslint-disable-next-line no-restricted-syntax -- targeted update on td_bank_feeds, no protected table
        await supabaseAdmin
          .from("td_bank_feeds")
          .update({
            status: "activation_crashed",
            review_metadata: {
              activation_error: activationError,
              pending_activation_id: pa.id,
              crashed_at: now,
            },
            updated_at: now,
          })
          .eq("id", feedId)
        result.activation_crashed++
      } else {
        result.auto_activated++
      }
      continue
    }

    // matched=false branch.
    if (matchResult.paymentId) {
      // matchAndReconcile already wrote status='needs_review' for this row.
      result.needs_review++
    } else {
      result.no_match++
    }
  }

  return result
}
