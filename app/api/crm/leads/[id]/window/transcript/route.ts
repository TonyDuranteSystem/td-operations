/**
 * GET /api/crm/leads/[id]/window/transcript?call=<call id>
 *
 * The saved transcript of one call, for the floating lead window's reader.
 * Staff only, read-only. The call must belong to this lead (linked by lead_id,
 * or the lead's own call pointer) — a staff member cannot read an unrelated
 * call by guessing its id through this route.
 */

import { NextResponse } from "next/server"
import { createClient } from "@/lib/supabase/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { requireStaffRoute } from "@/lib/auth/require-staff-route"
import { parseTranscript } from "@/lib/leads/window-data"

export const dynamic = "force-dynamic"

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function GET(request: Request, { params }: { params: { id: string } }) {
  const denied = await requireStaffRoute()
  if (denied) return denied

  const callId = new URL(request.url).searchParams.get("call") ?? ""
  if (!UUID.test(params.id) || !UUID.test(callId)) {
    return NextResponse.json({ error: "That is not a valid lead or call id." }, { status: 400 })
  }

  try {
    // The staff session must be able to see the lead at all.
    const supabase = createClient()
    const { data: lead } = await supabase.from("leads").select("id, circleback_call_id").eq("id", params.id).maybeSingle()
    if (!lead) return NextResponse.json({ error: "Lead not found." }, { status: 404 })

    const { data: call, error } = await supabaseAdmin
      .from("call_summaries")
      .select("id, lead_id, meeting_name, notes, transcript")
      .eq("id", callId)
      .maybeSingle()
    if (error) {
      console.error("[leads/window/transcript] query failed:", error.message)
      return NextResponse.json({ error: "Could not load the transcript — please try again." }, { status: 500 })
    }
    if (!call || (call.lead_id !== lead.id && lead.circleback_call_id !== call.id)) {
      return NextResponse.json({ error: "Call not found for this lead." }, { status: 404 })
    }

    return NextResponse.json({
      title: call.meeting_name ?? "Call",
      summary: call.notes ?? null,
      lines: parseTranscript(call.transcript),
    })
  } catch (err) {
    console.error("[leads/window/transcript] unexpected error:", err)
    return NextResponse.json({ error: "Could not load the transcript — please try again." }, { status: 500 })
  }
}
