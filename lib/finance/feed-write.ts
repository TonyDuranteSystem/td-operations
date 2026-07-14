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

  // eslint-disable-next-line no-restricted-syntax -- THIS is the single verified write path for td_bank_feeds
  const { error } = await supabaseAdmin
    .from("td_bank_feeds")
    .update({ ...patch, updated_at: new Date().toISOString() })
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
