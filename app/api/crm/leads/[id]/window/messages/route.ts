/**
 * GET /api/crm/leads/[id]/window/messages
 *
 * The lead's emails and WhatsApp chats as short story lines for the lead window (dev job 6fc63c52, phase C).
 * Staff only, read-only. The reading itself is loadLeadMessageEvents (lib/leads/window-loader.ts): email index rows
 * linked to the lead or sent from / to its address, and WhatsApp chats linked to the lead or whose number equals the
 * lead's phone (full digits, never a partial match). Only stored snippets / message text are read, newest first, capped.
 */

import { NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { requireStaffRoute } from "@/lib/auth/require-staff-route"
import { loadLeadMessageEvents } from "@/lib/leads/window-loader"

export const dynamic = "force-dynamic"
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function GET(_request: Request, { params }: { params: { id: string } }) {
  const denied = await requireStaffRoute()
  if (denied) return denied
  if (!UUID.test(params.id)) return NextResponse.json({ error: "That is not a valid lead id." }, { status: 400 })

  try {
    const r = await loadLeadMessageEvents(supabaseAdmin, params.id)
    if (!r.events) return NextResponse.json({ error: r.error }, { status: r.status })
    return NextResponse.json({ events: r.events, truncated: r.truncated })
  } catch (err) {
    console.error("[leads/window/messages] unexpected error:", err)
    return NextResponse.json({ error: "Could not load the messages — please try again." }, { status: 500 })
  }
}
