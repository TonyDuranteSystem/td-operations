/**
 * The ONE way to write a `td_bank_feeds` row — and it CHECKS whether the write landed.
 *
 * WHY THIS EXISTS (2026-07-14, the post-ship incident):
 * Every feed update in this codebase looked like
 *
 *     await supabaseAdmin.from("td_bank_feeds").update({...}).eq("id", feedId)
 *
 * with no `error` destructured and nothing checked. supabase-js **returns** errors — it
 * does not throw them. So when production's CHECK constraint rejected a value, the write
 * failed, the rejection was handed back, and the code dropped it on the floor.
 *
 * The database told us the truth on every one of those writes, hundreds of times over
 * months, and the code binned the message. The result: the entire review queue silently
 * did not exist. Zero rows, ever, in `needs_review` or `activation_crashed` — while the
 * Finance UI showed tabs and a badge for both, permanently empty, and staff reasonably
 * read empty as "nothing to review".
 *
 * The constraint did not break anything. **The discarded error did.**
 *
 * A write you did not verify is not a write. That is the same sentence that closed the
 * money-writer bug in `apply-payment.ts` — it was sitting one file away, unnoticed by
 * three reviewers across five rounds, because we were all reading code against code and
 * nobody compared the code against the database it actually writes to.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import { reportSystemError } from "@/lib/system-errors"
import { FEED_STATUSES, MATCH_CONFIDENCES } from "@/lib/finance/feed-vocabulary"

export interface FeedWriteResult {
  ok: boolean
  error?: string
}

export interface UpdateFeedOptions {
  /**
   * Replace `review_metadata` wholesale instead of merging into it. Almost never what you
   * want — see `mergeReviewMetadata` below for why. Reserved for a deliberate reset.
   */
  replaceReviewMetadata?: boolean
}

/**
 * Top-level merge of a `review_metadata` patch onto what the row already holds.
 *
 * ⛔ WHY MERGING IS THE DEFAULT (2026-07-29, Council finding — five reviewers, independently).
 *
 * `review_metadata` is ONE jsonb column carrying several UNRELATED facts, written by
 * different code paths at different times:
 *
 *   - `matched_payment_ids` / `multi_match_allocations` / `multi_match_leftover` — the ONLY
 *     record of how a single wire was split across several invoices. `matched_payment_id`
 *     holds just the FIRST funded invoice, so if this key is lost the allocation is
 *     unrecoverable. Two production feeds carried it when this was written.
 *   - `refunded_or_disputed` — the only thing that renders the red REFUNDED block in the
 *     Finance UI. Lose it and a refunded charge shows as an ordinary confirmable candidate.
 *   - `rejected_pairs` — "a human already said NO to this transaction/invoice pair". The
 *     auto-matcher obeys it, so losing it re-opens a wrong-client re-credit.
 *   - `contested` — why a row was parked for review, and the alternatives.
 *
 * Every one of those was previously destroyed by the next writer: this function used to
 * assign the column, and six call sites passed a freshly built object. So a rejection
 * recorded at 12:28 was gone by the next cron pass, and the "one wire, four invoices"
 * allocation was one park away from being erased.
 *
 * A shallow (top-level key) merge is deliberately enough: every fact above owns a distinct
 * top-level key, so a writer replaces its OWN key and touches nobody else's.
 */
function mergeReviewMetadata(
  previous: unknown,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const prev =
    previous && typeof previous === "object" && !Array.isArray(previous)
      ? (previous as Record<string, unknown>)
      : {}
  return { ...prev, ...patch }
}

/**
 * Update one bank-feed row, verifying that the database accepted it.
 *
 * On failure: logs loudly, records a system error (so it surfaces in /system-health
 * instead of dying in a Vercel log nobody reads), and returns ok:false. Callers decide
 * what to do — but they can no longer be unaware that it happened.
 *
 * @param context  where this write came from, e.g. "matcher:needs_review" — lands in the
 *                 error record so a rejected write names its own origin.
 */
export async function updateFeed(
  feedId: string,
  patch: Record<string, unknown>,
  context: string,
  options: UpdateFeedOptions = {},
): Promise<FeedWriteResult> {
  // Fail fast on a value the database will certainly reject. Without this the write goes
  // out, comes back rejected, and we learn about it only from the error report. Cheaper
  // and clearer to catch it here — and it makes the vocabulary file load-bearing rather
  // than decorative.
  const status = patch.status
  if (typeof status === "string" && !(FEED_STATUSES as readonly string[]).includes(status)) {
    const message = `Refusing to write unknown feed status "${status}" (from ${context}). Allowed: ${FEED_STATUSES.join(", ")}. If this value is genuinely new, it must be added to lib/finance/feed-vocabulary.ts AND to the database CHECK constraint, in that order.`
    console.error(`[feed-write] ${message}`)
    await reportSystemError({
      source: "server",
      route: "lib/finance/feed-write",
      message,
      context: { feedId, context, patch },
    }).catch(() => {})
    return { ok: false, error: message }
  }

  const confidence = patch.match_confidence
  if (
    typeof confidence === "string" &&
    !(MATCH_CONFIDENCES as readonly string[]).includes(confidence)
  ) {
    const message = `Refusing to write unknown match_confidence "${confidence}" (from ${context}). Allowed: ${MATCH_CONFIDENCES.join(", ")}. Audit-link kinds belong in review_metadata.link_kind, NOT here — a new confidence value would be invisible to the retroactive-pass guard that stops two feeds claiming one invoice.`
    console.error(`[feed-write] ${message}`)
    await reportSystemError({
      source: "server",
      route: "lib/finance/feed-write",
      message,
      context: { feedId, context, patch },
    }).catch(() => {})
    return { ok: false, error: message }
  }

  // Merge `review_metadata` rather than replacing it (see mergeReviewMetadata above).
  // Read-modify-write: two writers racing on DIFFERENT keys can still lose one update, which
  // is acceptable for advisory triage data — but a writer replacing keys it never heard of is
  // NOT, and that is what this closes. The one key where a lost write would matter
  // (`rejected_pairs`, which the matcher obeys) is additionally re-read and re-checked at the
  // moment it is used, so a dropped append delays the memory, it does not defeat it.
  let effectivePatch = patch
  const metaPatch = patch.review_metadata
  if (
    !options.replaceReviewMetadata &&
    metaPatch &&
    typeof metaPatch === "object" &&
    !Array.isArray(metaPatch)
  ) {
    const { data: existing } = await supabaseAdmin
      .from("td_bank_feeds")
      .select("review_metadata")
      .eq("id", feedId)
      .maybeSingle()
    effectivePatch = {
      ...patch,
      review_metadata: mergeReviewMetadata(
        existing?.review_metadata,
        metaPatch as Record<string, unknown>,
      ),
    }
  }

  // eslint-disable-next-line no-restricted-syntax -- THIS is the single verified write path for td_bank_feeds
  const { error } = await supabaseAdmin
    .from("td_bank_feeds")
    .update({ ...effectivePatch, updated_at: new Date().toISOString() })
    .eq("id", feedId)

  if (error) {
    const message = `Bank-feed write REJECTED by the database (${context}): ${error.message}`
    console.error(`[feed-write] ${message}`, { feedId, patch })
    await reportSystemError({
      source: "server",
      route: "lib/finance/feed-write",
      message,
      context: { feedId, context, patch, code: error.code },
    }).catch(() => {})
    return { ok: false, error: error.message }
  }

  return { ok: true }
}

/**
 * The same verified write, for a batch of feeds.
 *
 * Bulk updates were the last unchecked writes in the matcher. A bulk write that fails
 * fails for EVERY row in it — silently, if nobody looks — so it is the shape of this bug
 * with the largest blast radius, not the smallest.
 */
export async function updateFeeds(
  feedIds: string[],
  patch: Record<string, unknown>,
  context: string,
): Promise<FeedWriteResult> {
  if (feedIds.length === 0) return { ok: true }

  // A bulk UPDATE cannot merge per-row jsonb, and a bulk REPLACE of review_metadata would
  // erase a different set of facts on every row it touched (allocations, refund flags,
  // rejections). Refuse rather than offer a footgun; write those one row at a time.
  if ("review_metadata" in patch) {
    const message = `Refusing to bulk-write review_metadata (from ${context}). It is a per-row merge (see updateFeed) — a bulk write would replace unrelated keys on every row.`
    console.error(`[feed-write] ${message}`)
    await reportSystemError({
      source: "server",
      route: "lib/finance/feed-write",
      message,
      context: { context, feedIds: feedIds.length },
    }).catch(() => {})
    return { ok: false, error: message }
  }

  const status = patch.status
  if (typeof status === "string" && !(FEED_STATUSES as readonly string[]).includes(status)) {
    const message = `Refusing to bulk-write unknown feed status "${status}" (from ${context}). Allowed: ${FEED_STATUSES.join(", ")}.`
    console.error(`[feed-write] ${message}`)
    await reportSystemError({
      source: "server",
      route: "lib/finance/feed-write",
      message,
      context: { context, feedIds: feedIds.length, patch },
    }).catch(() => {})
    return { ok: false, error: message }
  }

  // eslint-disable-next-line no-restricted-syntax -- the verified bulk write path for td_bank_feeds
  const { error } = await supabaseAdmin
    .from("td_bank_feeds")
    .update({ ...patch, updated_at: new Date().toISOString() })
    .in("id", feedIds)

  if (error) {
    const message = `Bank-feed BULK write REJECTED by the database (${context}, ${feedIds.length} rows): ${error.message}`
    console.error(`[feed-write] ${message}`)
    await reportSystemError({
      source: "server",
      route: "lib/finance/feed-write",
      message,
      context: { context, feedIds: feedIds.length, patch, code: error.code },
    }).catch(() => {})
    return { ok: false, error: error.message }
  }

  return { ok: true }
}
