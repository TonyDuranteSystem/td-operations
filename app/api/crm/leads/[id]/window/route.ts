/**
 * GET /api/crm/leads/[id]/window
 *
 * Everything the floating lead window shows, in one call (dev job 6fc63c52). Staff only. Nothing is written.
 * The loading itself lives in lib/leads/window-loader.ts (shared with the draft route): the lead, offers, emails,
 * contracts and activation are read with the staff member's own session; call records and recordings with the
 * service client AFTER the staff check, and the big transcript column is never read here.
 */

import { NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { requireStaffRoute } from "@/lib/auth/require-staff-route"
import { loadLeadWindowData } from "@/lib/leads/window-loader"

export const dynamic = "force-dynamic"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function GET(_request: Request, { params }: { params: { id: string } }) {
  const denied = await requireStaffRoute()
  if (denied) return denied

  if (!UUID.test(params.id)) {
    return NextResponse.json({ error: "That is not a valid lead id." }, { status: 400 })
  }

  try {
    const result = await loadLeadWindowData(createClient(), supabaseAdmin, params.id)
    if (!result.data) return NextResponse.json({ error: result.error }, { status: result.status })
    return NextResponse.json({ data: result.data })
  } catch (err) {
    console.error("[leads/window] unexpected error:", err)
    return NextResponse.json({ error: "Could not load this lead — please try again." }, { status: 500 })
  }
}
