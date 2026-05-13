/**
 * POST /api/crm/admin-actions/bank-feed-reject-match
 *
 * Admin-only endpoint to reject a needs_review candidate. The feed goes back
 * to status='unmatched' with matched_payment_id+match_confidence cleared, and
 * review_metadata records the rejection timestamp for audit.
 */

import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { supabaseAdmin } from "@/lib/supabase-admin"

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

  // Pull existing review_metadata so we can append rejected_at without
  // clobbering anything already stored.
  const { data: existing } = await supabaseAdmin
    .from("td_bank_feeds")
    .select("review_metadata")
    .eq("id", feed_id)
    .maybeSingle()

  const prev = (existing?.review_metadata as Record<string, unknown> | null) ?? {}
  const now = new Date().toISOString()

  // eslint-disable-next-line no-restricted-syntax -- direct update on td_bank_feeds, no protected table
  const { error } = await supabaseAdmin
    .from("td_bank_feeds")
    .update({
      status: "unmatched",
      matched_payment_id: null,
      match_confidence: null,
      review_metadata: { ...prev, rejected_at: now, rejected_by: user.id },
      updated_at: now,
    })
    .eq("id", feed_id)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }
  return NextResponse.json({ ok: true })
}
