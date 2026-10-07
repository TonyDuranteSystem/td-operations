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
 * RELEASE 2 (dev job 5962e46d): the same click ALSO asks the database to put the reaction on the customer's phone, in the SAME transaction
 * (wabridge_react_click → wabridge_queue_phone_reaction) — latest pick wins on the phone, un-picking the emoji that is on the phone removes
 * it. Every rule (switch OFF by default, allowlist, replies-only, 1 h message age, safe emoji set, health, the Mac sender running) is enforced
 * there; the team mark is saved either way, and the answer says whether it was queued or why not.
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

  // ONE call, ONE transaction (message row locked): the team mark is toggled AND the phone decision is made against the same state, in click
  // order — two separate calls could be overtaken by each other on a double click (council 2026-10-07).
  const { data: click, error: rpcErr } = await supabaseAdmin.rpc("wabridge_react_click", {
    p_message_id: id,
    p_emoji: emoji,
    p_reactor_id: user.id,
    p_reactor_name: getUserDisplayName(user),
  })
  if (rpcErr) {
    // Deployed before its database change (PGRST202 / 42883 = function missing): fall back to the plain team-mark toggle, silently.
    if (rpcErr.code === "PGRST202" || rpcErr.code === "42883") {
      const { data: legacy, error: legacyErr } = await supabaseAdmin.rpc("wabridge_toggle_reaction", {
        p_message_id: id, p_emoji: emoji, p_reactor_id: user.id, p_reactor_name: getUserDisplayName(user),
      })
      if (legacyErr) return NextResponse.json({ error: legacyErr.message }, { status: 500 })
      const l = (legacy as unknown) as { ok?: boolean; code?: string; added?: boolean; reactions?: unknown } | null
      if (!l?.ok) return l?.code === "not_found" ? NextResponse.json({ error: "Message not found" }, { status: 404 }) : NextResponse.json({ error: "Could not react" }, { status: 500 })
      return NextResponse.json({ ok: true, added: !!l.added, reactions: l.reactions ?? [], phone: { queued: false, holdSeconds: 0, notice: null } })
    }
    return NextResponse.json({ error: rpcErr.message }, { status: 500 })
  }

  const parsedClick = (click as unknown) as { toggle?: { ok?: boolean; code?: string; added?: boolean; reactions?: unknown } | null; phone?: unknown } | null
  const parsed = parsedClick?.toggle
  if (!parsed?.ok) {
    if (parsed?.code === "not_found") return NextResponse.json({ error: "Message not found" }, { status: 404 })
    return NextResponse.json({ error: "Could not react" }, { status: 500 })
  }

  // The same click, towards the phone. The team mark above is already saved and stays whatever the answer here says.
  const added = !!parsed.added
  const phone = parseQueueAnswer(parsedClick?.phone)
  if (phone.queued) await emitUiEvent("whatsapp") // other open Inboxes show "sending to the phone…" at once

  return NextResponse.json({
    ok: true,
    added,
    reactions: parsed.reactions ?? [],
    phone: { queued: phone.queued, holdSeconds: phone.holdSeconds, notice: phone.queued ? null : describePhoneReactionRefusal(phone.reason, added ? "set" : "remove") },
  })
}
