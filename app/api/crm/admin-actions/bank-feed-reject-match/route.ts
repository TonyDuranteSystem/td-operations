/**
 * POST /api/crm/admin-actions/bank-feed-reject-match
 *
 * A human says "no, this transaction is not for that invoice".
 *
 * ⛔ REWRITTEN 2026-07-29. Three things were wrong, all of them the same shape — the route
 * threw away the information that made the rejection MEAN anything:
 *
 *  1. It cleared `matched_payment_id` while recording only a timestamp, so WHICH invoice was
 *     rejected was destroyed in the same statement. The matcher therefore re-proposed the
 *     identical candidate on its next pass — every 15 minutes, for ever. A human's "no" did
 *     not stick.
 *  2. It never checked whether that candidate had already been APPLIED. Rejecting a settled
 *     match cleared the pointer and left the money on the invoice with a confirmed ledger row
 *     behind it — the orphaned state that makes a later re-match report success while moving
 *     nothing.
 *  3. It wrote `td_bank_feeds` directly instead of through the verified writer, so a rejected
 *     write (a value the database refuses) would have been silently discarded — the failure
 *     that once left the whole review queue permanently empty.
 */

import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { updateFeed } from "@/lib/finance/feed-write"
import { appendRejectedPair } from "@/lib/finance/feed-vocabulary"
import { reverseFeedApplication } from "@/lib/finance/apply-payment"

export async function POST(req: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const body = await req.json().catch(() => ({}))
  const { feed_id } = body as { feed_id?: string }
  if (!feed_id) {
    return NextResponse.json({ error: "Missing feed_id" }, { status: 400 })
  }

  // Read the pinned candidate BEFORE clearing it — that id IS the rejection.
  const { data: existing, error: readErr } = await supabaseAdmin
    .from("td_bank_feeds")
    .select("review_metadata, matched_payment_id, status")
    .eq("id", feed_id)
    .maybeSingle()

  if (readErr) {
    return NextResponse.json({ error: readErr.message }, { status: 500 })
  }
  if (!existing) {
    return NextResponse.json({ error: "Bank transaction not found" }, { status: 404 })
  }

  const rejectedPaymentId = existing.matched_payment_id as string | null
  const now = new Date().toISOString()
  let reversalWarning: string | undefined

  // If this candidate had actually been settled, take the money back off it first. Money
  // before pointers, always: clearing the pointer while the money stays applied is how an
  // invoice ends up credited by a transaction nothing points at.
  if (rejectedPaymentId) {
    const reversal = await reverseFeedApplication({
      feedId: feed_id,
      paymentId: rejectedPaymentId,
      actor: `dashboard:reject:${user.email ?? user.id}`,
      today: now.slice(0, 10),
    })
    if (!reversal.reversed && reversal.reason !== "no_application") {
      return NextResponse.json(
        { error: reversal.detail ?? "The applied payment could not be reversed." },
        { status: 409 },
      )
    }
    // ⛔ A PARTIAL SUCCESS IS NOT A SUCCESS (2026-07-29, Bug-Hunter on the finished code).
    // `warning` is set when the money came off the invoice but the record could not be
    // unlocked — which permanently blocks that transaction from ever being matched to that
    // invoice again. Swallowing it told the operator "rejected" while leaving a dead end, and
    // it is precisely the swallowed-error class this whole change exists to end.
    if (reversal.warning) {
      reversalWarning = reversal.warning
    }
  }

  const res = await updateFeed(
    feed_id,
    {
      status: "unmatched",
      matched_payment_id: null,
      match_confidence: null,
      review_metadata: {
        // Kept for backwards compatibility with the existing UI/audit reads.
        rejected_at: now,
        rejected_by: user.id,
        // The load-bearing part: the matcher reads this and will not re-propose the pair.
        ...(rejectedPaymentId
          ? appendRejectedPair(existing.review_metadata, {
              payment_id: rejectedPaymentId,
              at: now,
              by: user.id,
            })
          : {}),
      },
    },
    "reject-match",
  )

  if (!res.ok) {
    return NextResponse.json({ error: res.error }, { status: 500 })
  }
  return NextResponse.json({
    ok: true,
    rejected_payment_id: rejectedPaymentId,
    ...(reversalWarning ? { warning: reversalWarning } : {}),
  })
}
