/**
 * GET /api/crm/admin-actions/offer-send-check?token=<offer token>
 *
 * Staff only. READ-ONLY: the box "Before this offer can be sent" asks this what the real Send will say about a DRAFT
 * offer (offer builder Part 1, dev job d2971d11). It runs the same function as the real Send (lib/offers/send-check.ts) in
 * its "preview" mode: every step runs, nothing is written (the approved wording is worked out in memory, not frozen onto the
 * offer), nothing is sent, no portal login is created.
 *
 * Lives under /api/crm (a session is required) and NOT under /api/offers — that prefix is public in the middleware (the
 * client's own offer pages), and this answer carries internal reasons nobody outside the staff may read.
 *
 * Answers: 401 not signed in · 403 not staff (a client, partner or marketing login is refused) · 400 no token ·
 * 404 no such offer · 200 { applicable:false } for an offer that is no longer a draft (nothing to check) ·
 * 200 { applicable:true, blockers, risks, notChecked, willSendTo, checkedAt } otherwise.
 */

import { NextRequest, NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { isStaffUser } from "@/lib/auth"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { offerSendCheck } from "@/lib/offers/send-check"

export const dynamic = "force-dynamic"

const NO_STORE = { "Cache-Control": "no-store" }

export async function GET(req: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401, headers: NO_STORE })
  if (!isStaffUser(user)) return NextResponse.json({ error: "Staff access required" }, { status: 403, headers: NO_STORE })

  const token = req.nextUrl.searchParams.get("token")?.trim()
  if (!token) return NextResponse.json({ error: "token is required" }, { status: 400, headers: NO_STORE })

  const { data: offer, error } = await supabaseAdmin
    .from("offers")
    .select("token, status, client_email, services, bundled_pipelines, recurring_costs, installment_currency, contract_type")
    .eq("token", token)
    .maybeSingle()
  if (error) return NextResponse.json({ error: `Could not read the offer (${error.message})` }, { status: 500, headers: NO_STORE })
  if (!offer) return NextResponse.json({ error: "Offer not found" }, { status: 404, headers: NO_STORE })

  const checkedAt = new Date().toISOString()
  // Only a draft is about to be sent; a sent / viewed / signed offer has nothing to check.
  if (offer.status !== "draft") {
    return NextResponse.json({ applicable: false, status: offer.status, checkedAt }, { headers: NO_STORE })
  }

  try {
    const check = await offerSendCheck({ offer, door: "send", mode: "preview" })
    return NextResponse.json(
      { applicable: true, status: offer.status, blockers: check.blockers, risks: check.risks, notChecked: check.notChecked, willSendTo: check.willSendTo, checkedAt },
      { headers: NO_STORE },
    )
  } catch (e) {
    return NextResponse.json({ error: `Could not check the offer (${e instanceof Error ? e.message : String(e)})` }, { status: 500, headers: NO_STORE })
  }
}
