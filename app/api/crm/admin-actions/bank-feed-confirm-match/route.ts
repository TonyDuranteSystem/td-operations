/**
 * POST /api/crm/admin-actions/bank-feed-confirm-match
 *
 * Admin-only endpoint to confirm a needs_review candidate match between a
 * td_bank_feeds row and a payments invoice. Calls manualMatch() which marks
 * the feed + invoice paid and triggers the activation chain if linked.
 */

import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { manualMatch } from "@/lib/bank-feed-matcher"

export async function POST(req: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const body = await req.json().catch(() => ({}))
  const { feed_id, payment_id } = body as { feed_id?: string; payment_id?: string }
  if (!feed_id || !payment_id) {
    return NextResponse.json({ error: "Missing feed_id or payment_id" }, { status: 400 })
  }

  try {
    const result = await manualMatch(feed_id, payment_id)
    if (!result.matched) {
      return NextResponse.json({ ok: false, error: result.error ?? "Match failed" }, { status: 500 })
    }
    return NextResponse.json({ ok: true, result })
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e)
    return NextResponse.json({ error: msg }, { status: 500 })
  }
}
