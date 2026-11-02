/**
 * POST /api/crm/leads/[id]/window/follow-up-sent   body: { channel: "whatsapp" | "email" }
 *
 * Marks that a follow-up just left the lead window (dev job 6fc63c52): the lead keeps the time (set here, by the
 * server) and the channel, so the Leads table and the window can show "Follow-up sent · WhatsApp · 1 Nov".
 * Called by the window right AFTER a send succeeded; a failure here never undoes the send. Staff only.
 */

import { NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { requireStaffRoute } from "@/lib/auth/require-staff-route"
import { parseFollowUpChannel } from "@/lib/leads/follow-up-sent"

export const dynamic = "force-dynamic"
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

type MarkDb = {
  from: (t: string) => {
    update: (v: Record<string, unknown>) => { eq: (c: string, v: string) => { select: (c: string) => Promise<{ data: unknown[] | null; error: { message: string } | null }> } }
  }
}

export async function POST(request: Request, { params }: { params: { id: string } }) {
  const denied = await requireStaffRoute()
  if (denied) return denied
  if (!UUID.test(params.id)) return NextResponse.json({ error: "That is not a valid lead id." }, { status: 400 })

  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>
  const channel = parseFollowUpChannel(body.channel)
  if (!channel) return NextResponse.json({ error: "The channel must be whatsapp or email." }, { status: 400 })

  try {
    const sentAt = new Date().toISOString()
    const { data, error } = await (supabaseAdmin as unknown as MarkDb)
      .from("leads").update({ last_follow_up_sent_at: sentAt, last_follow_up_channel: channel }).eq("id", params.id).select("id")
    if (error) {
      console.error("[leads/window/follow-up-sent] write failed:", error.message)
      return NextResponse.json({ error: "Could not save the mark — the message itself was sent." }, { status: 500 })
    }
    if (!data || data.length === 0) return NextResponse.json({ error: "Lead not found." }, { status: 404 })
    return NextResponse.json({ ok: true, sentAt, channel })
  } catch (err) {
    console.error("[leads/window/follow-up-sent] unexpected error:", err)
    return NextResponse.json({ error: "Could not save the mark — the message itself was sent." }, { status: 500 })
  }
}
