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
import { supabaseAdmin } from "@/lib/supabase-admin"
import { readContestedCandidates } from "@/lib/finance/feed-vocabulary"

export async function POST(req: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const body = await req.json().catch(() => ({}))
  const { feed_id, payment_id, acknowledge_contested } = body as {
    feed_id?: string
    payment_id?: string
    acknowledge_contested?: boolean
  }
  if (!feed_id || !payment_id) {
    return NextResponse.json({ error: "Missing feed_id or payment_id" }, { status: 400 })
  }

  // ⛔ RE-CHECK CONTESTED ON THE SERVER (2026-07-29).
  // When several invoices fitted a payment equally well, the matcher parks the transaction and
  // pins the top-scoring one — which in the incident that produced this guard was the WRONG
  // company. This endpoint takes a payment_id straight from the browser and applies the full
  // amount, so a stale page, a mis-tap on a phone, or a caller that never rendered the
  // contested block would settle the pinned candidate in one request. Refuse unless the caller
  // states explicitly that it knows the row is contested.
  const { data: feed } = await supabaseAdmin
    .from("td_bank_feeds")
    .select("review_metadata")
    .eq("id", feed_id)
    .maybeSingle()

  const contested = readContestedCandidates(feed?.review_metadata)
  if (contested.length > 1 && !acknowledge_contested) {
    return NextResponse.json(
      {
        ok: false,
        error:
          "More than one invoice fits this payment, so it cannot be confirmed with one click. Open the transaction and choose the right invoice deliberately.",
        contested,
      },
      { status: 409 },
    )
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
