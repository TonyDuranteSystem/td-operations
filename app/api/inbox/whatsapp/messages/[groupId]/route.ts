import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { requireStaffRoute } from "@/lib/auth/require-staff-route"
import { OUTBOX_TEAM_LABEL, normalizeSendMode, outboxDisplayStatus, type SendMode } from "@/lib/messaging/wabridge-outbox"
import { createClient } from "@/lib/supabase/server"
import { isStaffUser } from "@/lib/auth"

export const dynamic = "force-dynamic"

export async function GET(
  _req: NextRequest,
  { params }: { params: { groupId: string } }
) {
  // Staff gate — middleware only guarantees "is logged in" for /api routes,
  // and a portal CLIENT has a login (2026-07-21 invariant; council find 2026-07-29,
  // dev job 7e63fcd2).
  const denied = await requireStaffRoute()
  if (denied) return denied

  const { groupId } = params

  if (!groupId) {
    return NextResponse.json({ error: "groupId is required" }, { status: 400 })
  }

  try {
    const { data, error } = await supabaseAdmin
      .from("messages")
      .select(
        "id, content_text, direction, sender_name, sender_phone, created_at, content_type, media_url"
      )
      .eq("group_id", groupId)
      .order("created_at", { ascending: true })

    if (error) throw error

    // Self-hosted WhatsApp line only: replies still waiting / in test mode / not confirmed / failed live in wa_outbox until the Mac has
    // sent them (a SENT reply becomes an ordinary message row). They are shown in the chat labelled "TD Team", with their state.
    // `send` tells the screen whether replying is allowed. Everything here is best-effort: a failure must not hide the chat itself.
    let outbox: Array<Record<string, unknown>> = []
    let send: { mode: SendMode; hasInbound: boolean } | null = null
    try {
      const { data: group } = await supabaseAdmin.from("messaging_groups").select("channel_id").eq("id", groupId).maybeSingle()
      if (group?.channel_id) {
        const { data: channel } = await supabaseAdmin.from("messaging_channels").select("provider").eq("id", group.channel_id).maybeSingle()
        if (channel?.provider === "wabridge") {
          const [{ data: rows }, { data: state }] = await Promise.all([
            supabaseAdmin
              .from("wa_outbox")
              .select("id, body, status, created_at, claimed_at, error")
              .eq("group_id", groupId)
              .neq("status", "sent")
              .order("created_at", { ascending: true }),
            supabaseAdmin.from("wa_bridge_state").select("send_mode").eq("channel_id", group.channel_id).maybeSingle(),
          ])
          // a reply a person themselves discarded ("It was not sent") is a decision, not a problem — it does not stay in the chat
          outbox = (rows ?? []).filter((o) => !(o.status === "failed" && o.error === "discarded by staff")).map((o) => ({
            id: `outbox:${o.id}`,
            content_text: o.body,
            direction: "outbound",
            sender_name: OUTBOX_TEAM_LABEL,
            sender_phone: null,
            created_at: o.created_at,
            content_type: "text",
            media_url: null,
            // 'unknown' claimed < 2 min ago is "sending"; older = the Mac never confirmed (a person decides)
            outbox_status: outboxDisplayStatus(o.status, o.claimed_at, new Date()),
            outbox_id: o.id,
          }))
          send = {
            mode: normalizeSendMode(state?.send_mode),
            hasInbound: (data ?? []).some((m) => m.direction === "inbound"),
          }
        }
      }
    } catch (outboxErr) {
      console.warn("WhatsApp outbox overlay failed (chat still loads):", outboxErr instanceof Error ? outboxErr.message : String(outboxErr))
    }

    // Voice notes (self-hosted line): audio state + machine transcript. STAFF ONLY — a partner login passes requireStaffRoute but must not
    // hear or read a lead's voice note (Antonio 2026-09-26). Best-effort like the outbox: a failure never hides the chat.
    const voiceIds = (data ?? []).filter((m) => m.content_type === "voice").map((m) => m.id)
    const voiceByMessage = new Map<string, Record<string, unknown>>()
    if (voiceIds.length > 0) {
      try {
        const { data: { user } } = await createClient().auth.getUser()
        if (isStaffUser(user)) {
          const { data: media } = await supabaseAdmin
            .from("message_media")
            .select("message_id, status, transcript, duration_seconds, audio_deleted_at")
            .in("message_id", voiceIds)
          for (const x of media ?? []) {
            voiceByMessage.set(x.message_id, {
              status: x.status,
              transcript: x.transcript,
              duration_seconds: x.duration_seconds,
              audio_deleted: x.audio_deleted_at !== null,
            })
          }
          // a note the Mac has not picked up yet has no row: staff still see it as "preparing" (and the chat refreshes faster)
          for (const id of voiceIds) {
            if (!voiceByMessage.has(id)) voiceByMessage.set(id, { status: "waiting", transcript: null, duration_seconds: null, audio_deleted: false })
          }
        }
      } catch (voiceErr) {
        console.warn("WhatsApp voice overlay failed (chat still loads):", voiceErr instanceof Error ? voiceErr.message : String(voiceErr))
      }
    }
    const withVoice = (data ?? []).map((m) => (m.content_type === "voice" && voiceByMessage.has(m.id) ? { ...m, voice: voiceByMessage.get(m.id) } : m))

    const messages = [...withVoice, ...outbox].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
    return NextResponse.json({ messages, send })
  } catch (error) {
    console.error("WhatsApp messages error:", error)
    return NextResponse.json(
      { error: "Failed to fetch WhatsApp messages" },
      { status: 500 }
    )
  }
}
