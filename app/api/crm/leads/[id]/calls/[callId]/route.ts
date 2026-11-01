/**
 * POST /api/crm/leads/[id]/calls/[callId]   body: { action: "happened" | "no_show" | "rebook" }
 *
 * Staff answer "Did this call happen?" for a booked call with no recording (lead window, dev job 6fc63c52).
 * "happened" also moves a lead that is exactly on Call Scheduled to Call Done (guarded, logged). Staff only.
 */

import { NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { requireStaffRoute } from "@/lib/auth/require-staff-route"
import { confirmCall, type ConfirmAction } from "@/lib/leads/lead-calls"

export const dynamic = "force-dynamic"
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const ACTIONS: ConfirmAction[] = ["happened", "no_show", "rebook"]

export async function POST(request: Request, { params }: { params: { id: string; callId: string } }) {
  const denied = await requireStaffRoute()
  if (denied) return denied
  if (!UUID.test(params.id) || !UUID.test(params.callId)) {
    return NextResponse.json({ error: "That is not a valid lead or call id." }, { status: 400 })
  }
  const body = await request.json().catch(() => ({}))
  const action = body?.action as ConfirmAction
  if (!ACTIONS.includes(action)) {
    return NextResponse.json({ error: "The action must be happened, no_show or rebook." }, { status: 400 })
  }
  try {
    const { data: { user } } = await createClient().auth.getUser()
    const actor = user?.email?.split("@")[0] ?? "staff"
    const result = await confirmCall(supabaseAdmin, { leadId: params.id, callId: params.callId, action, actor })
    return NextResponse.json({ ok: result.ok, message: result.message, moved: result.moved ?? false }, { status: result.status })
  } catch (err) {
    console.error("[leads/calls] unexpected error:", err)
    return NextResponse.json({ error: "Could not save your answer — please try again." }, { status: 500 })
  }
}
