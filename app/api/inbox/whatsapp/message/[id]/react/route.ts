import { createClient } from "@/lib/supabase/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { isStaffUser, getUserDisplayName } from "@/lib/auth"
import { isValidReactionEmoji } from "@/lib/portal/reactions"
import { parseQueueAnswer, describePhoneReactionRefusal } from "@/lib/messaging/wabridge-react"
import { emitUiEvent } from "@/lib/ui-events"
import { NextRequest, NextResponse } from "next/server"

/**
 * POST /api/inbox/whatsapp/message/[id]/react
 * Toggle an emoji reaction on a WhatsApp message. STAFF ONLY — unlike the portal chat reaction route
 * this has no client-facing counterpart (there is no client widget for WhatsApp), so it never notifies
 * a client and never checks a client/teammate scope. Body: { emoji: string }.
 *
 * RELEASE 2 (dev job 5962e46d): after the team mark is saved, the same click ALSO asks the database to put the reaction on the customer's
 * phone (wabridge_queue_phone_reaction) — latest pick wins on the phone, un-picking the emoji that is on the phone removes it. Every rule
 * (switch OFF by default, allowlist, 1 h message age, safe emoji set, health) is enforced there; the team mark is saved either way, and
 * the answer says whether it was queued or why not. A queue failure NEVER undoes the team mark.
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

  // The same click, towards the phone. Best-effort: the team mark above is already saved and stays whatever happens here.
  const added = !!parsed.added
  let phone = { queued: false, reason: "unreadable" as string | null, holdSeconds: 0 }
  try {
    const { data: queued, error: queueErr } = await supabaseAdmin.rpc("wabridge_queue_phone_reaction", {
      p_message_id: id,
      p_emoji: emoji,
      p_action: added ? "set" : "remove",
      p_user: user.id,
    })
    phone = queueErr ? { queued: false, reason: "unreadable", holdSeconds: 0 } : parseQueueAnswer(queued)
  } catch {
    phone = { queued: false, reason: "unreadable", holdSeconds: 0 }
  }
  if (phone.queued) await emitUiEvent("whatsapp") // other open Inboxes show "sending to the phone…" at once

  return NextResponse.json({
    ok: true,
    added,
    reactions: parsed.reactions ?? [],
    phone: { queued: phone.queued, holdSeconds: phone.holdSeconds, notice: phone.queued ? null : describePhoneReactionRefusal(phone.reason) },
  })
}
