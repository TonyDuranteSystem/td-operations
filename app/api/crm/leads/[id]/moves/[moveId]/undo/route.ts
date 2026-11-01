/**
 * POST /api/crm/leads/[id]/moves/[moveId]/undo
 *
 * Undo an AUTOMATIC move to Call Done within its 24-hour window (lead window, dev job 6fc63c52). The lead goes back
 * to its earlier status and is never moved automatically again. Refused if the status changed since. Staff only.
 */

import { NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { requireStaffRoute } from "@/lib/auth/require-staff-route"
import { undoMove } from "@/lib/leads/lead-calls"

export const dynamic = "force-dynamic"
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function POST(_request: Request, { params }: { params: { id: string; moveId: string } }) {
  const denied = await requireStaffRoute()
  if (denied) return denied
  if (!UUID.test(params.id) || !UUID.test(params.moveId)) {
    return NextResponse.json({ error: "That is not a valid lead or move id." }, { status: 400 })
  }
  try {
    const { data: { user } } = await createClient().auth.getUser()
    const actor = user?.email?.split("@")[0] ?? "staff"
    const result = await undoMove(supabaseAdmin, { leadId: params.id, moveId: params.moveId, actor })
    return NextResponse.json({ ok: result.ok, message: result.message }, { status: result.status })
  } catch (err) {
    console.error("[leads/undo] unexpected error:", err)
    return NextResponse.json({ error: "Could not undo — please try again." }, { status: 500 })
  }
}
