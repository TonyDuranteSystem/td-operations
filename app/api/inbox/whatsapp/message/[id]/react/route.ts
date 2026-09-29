import { createClient } from "@/lib/supabase/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { isStaffUser, getUserDisplayName } from "@/lib/auth"
import { isValidReactionEmoji } from "@/lib/portal/reactions"
import { NextRequest, NextResponse } from "next/server"

/**
 * POST /api/inbox/whatsapp/message/[id]/react
 * Toggle an emoji reaction on a WhatsApp message. STAFF ONLY — unlike the portal chat reaction route
 * this has no client-facing counterpart (there is no client widget for WhatsApp), so it never notifies
 * a client and never checks a client/teammate scope. Body: { emoji: string }.
 */
export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isStaffUser(user)) {
    return NextResponse.json({ error: "Not authorized" }, { status: 403 })
  }

  const id = params.id
  if (!id) return NextResponse.json({ error: "id required" }, { status: 400 })

  let body: { emoji?: unknown }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }
  const emoji = typeof body.emoji === "string" ? body.emoji.trim() : ""
  if (!isValidReactionEmoji(emoji)) {
    return NextResponse.json({ error: "A valid emoji is required." }, { status: 400 })
  }

  const { data: result, error: rpcErr } = await supabaseAdmin.rpc("wabridge_toggle_reaction", {
    p_message_id: id,
    p_emoji: emoji,
    p_reactor_id: user.id,
    p_reactor_name: getUserDisplayName(user),
  })
  if (rpcErr) return NextResponse.json({ error: rpcErr.message }, { status: 500 })

  const parsed = (result as unknown) as { ok?: boolean; code?: string; added?: boolean; reactions?: unknown } | null
  if (!parsed?.ok) {
    if (parsed?.code === "not_found") return NextResponse.json({ error: "Message not found" }, { status: 404 })
    return NextResponse.json({ error: "Could not react" }, { status: 500 })
  }

  return NextResponse.json({ ok: true, added: !!parsed.added, reactions: parsed.reactions ?? [] })
}
