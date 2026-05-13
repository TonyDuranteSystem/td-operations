/**
 * POST /api/crm/admin-actions/bank-feed-retry-activation
 *
 * Admin-only endpoint to retry a crashed activation tied to a td_bank_feeds
 * row in status='activation_crashed'. Looks up the linked pending_activation
 * (via matched_payment_id → payments → pending_activations.portal_invoice_id)
 * and calls runActivation(). On success, clears status back to 'matched'. On
 * failure, updates review_metadata with the new error.
 */

import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { runActivation } from "@/lib/operations/activate-service"

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

  const { data: feed } = await supabaseAdmin
    .from("td_bank_feeds")
    .select("id, status, matched_payment_id, review_metadata")
    .eq("id", feed_id)
    .maybeSingle()

  if (!feed) {
    return NextResponse.json({ error: "Feed not found" }, { status: 404 })
  }
  if (!feed.matched_payment_id) {
    return NextResponse.json({ error: "Feed has no matched payment" }, { status: 400 })
  }

  const { data: pa } = await supabaseAdmin
    .from("pending_activations")
    .select("id, status")
    .eq("portal_invoice_id", feed.matched_payment_id)
    .in("status", ["awaiting_payment", "pending_confirmation", "payment_confirmed"])
    .maybeSingle()

  if (!pa) {
    return NextResponse.json({ error: "No retryable pending_activation linked to this feed" }, { status: 400 })
  }

  const prevMeta = (feed.review_metadata as Record<string, unknown> | null) ?? {}
  const now = new Date().toISOString()

  let actError: string | null = null
  let actResult: Awaited<ReturnType<typeof runActivation>> | null = null
  try {
    actResult = await runActivation(pa.id)
    if (!actResult.ok) {
      actError = actResult.error ?? "runActivation returned ok=false"
    }
  } catch (e) {
    actError = e instanceof Error ? e.message : String(e)
  }

  if (actError) {
    // eslint-disable-next-line no-restricted-syntax -- direct update on td_bank_feeds, no protected table
    await supabaseAdmin
      .from("td_bank_feeds")
      .update({
        review_metadata: {
          ...prevMeta,
          activation_error: actError,
          last_retry_at: now,
          last_retry_by: user.id,
        },
        updated_at: now,
      })
      .eq("id", feed_id)
    return NextResponse.json({ ok: false, error: actError, result: actResult })
  }

  // Success — revert the crash flag so the row drops out of the review queue.
  // eslint-disable-next-line no-restricted-syntax -- direct update on td_bank_feeds, no protected table
  await supabaseAdmin
    .from("td_bank_feeds")
    .update({
      status: "matched",
      review_metadata: {
        ...prevMeta,
        retry_succeeded_at: now,
        last_retry_by: user.id,
      },
      updated_at: now,
    })
    .eq("id", feed_id)

  return NextResponse.json({ ok: true, result: actResult })
}
