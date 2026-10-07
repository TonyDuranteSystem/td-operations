import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { requireStaffRoute } from "@/lib/auth/require-staff-route"
import { OUTBOX_TEAM_LABEL, normalizeSendMode, outboxDisplayStatus, type SendMode } from "@/lib/messaging/wabridge-outbox"
import { createClient } from "@/lib/supabase/server"
import { isStaffUser } from "@/lib/auth"
import { jidToE164 } from "@/lib/messaging/phone"
import { PLAYBACK_URL_SECONDS, VOICE_BUCKET } from "@/lib/messaging/wabridge-media"

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
        "id, content_text, direction, sender_name, sender_phone, created_at, content_type, media_url, reactions, pinned_at, reply_to_id"
      )
      .eq("group_id", groupId)
      // A hidden message (staff "Delete" — see the message route's own comment: this only removes OUR
      // copy from view, the real WhatsApp message on the person's phone is untouched) never reaches the
      // chat again; the row itself is kept for audit, same shape as the portal chat's soft delete (R100).
      .is("deleted_at", null)
      .order("created_at", { ascending: true })

    if (error) throw error

    // Self-hosted WhatsApp line only: replies still waiting / in test mode / not confirmed / failed live in wa_outbox until the Mac has
    // sent them (a SENT reply becomes an ordinary message row). They are shown in the chat labelled "TD Team", with their state.
    // `send` tells the screen whether replying is allowed. Everything here is best-effort: a failure must not hide the chat itself.
    // The confirm-before-send screen needs to show WHO the message is going to (name + number), the same way the
    // Portal Chats Worker card already does — never assume the open chat is the intended recipient (R101 lesson,
    // 2026-09-26: staff opened the wrong chat once during testing). Best-effort: a lookup failure must not hide
    // the chat, it only means the confirm screen falls back to the bare number.
    let chat: {
      name: string | null
      phone: string | null
      language: string | null
      /** Staff-only "three dots" menu (Discuss with Team / Make a note / Create Task,Service,Invoice / To Do)
       *  needs a client to attach to — null when this chat has never been linked to a CRM record. */
      accountId: string | null
      contactId: string | null
    } | null = null
    try {
      const { data: g } = await supabaseAdmin
        .from("messaging_groups")
        .select("group_name, external_group_id, lead_id, contact_id, account_id")
        .eq("id", groupId)
        .maybeSingle()
      if (g) {
        const [lead, contact, account] = await Promise.all([
          g.lead_id ? supabaseAdmin.from("leads").select("full_name").eq("id", g.lead_id).maybeSingle() : Promise.resolve({ data: null }),
          g.contact_id ? supabaseAdmin.from("contacts").select("full_name, language").eq("id", g.contact_id).maybeSingle() : Promise.resolve({ data: null }),
          g.account_id ? supabaseAdmin.from("accounts").select("company_name").eq("id", g.account_id).maybeSingle() : Promise.resolve({ data: null }),
        ])
        chat = {
          name: contact.data?.full_name ?? lead.data?.full_name ?? account.data?.company_name ?? g.group_name ?? null,
          phone: g.external_group_id ? jidToE164(g.external_group_id) : null,
          language: (contact.data as { language?: string } | null)?.language ?? null,
          accountId: g.account_id ?? null,
          contactId: g.contact_id ?? null,
        }
      }
    } catch (chatErr) {
      console.warn("WhatsApp chat identity lookup failed (chat still loads):", chatErr instanceof Error ? chatErr.message : String(chatErr))
    }

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

    // Inbound photos/videos/documents (2026-09-28): a fresh signed view link, minted per load, never stored —
    // same staff-only rule as voice (Antonio 2026-09-26: only Antonio and Luca see WhatsApp media). A message
    // whose file has not been downloaded yet, or is expired/failed, keeps media_url null — the existing
    // isImage/isOtherMedia rendering already handles "no media_url" as a plain placeholder, so nothing else
    // in the UI needs to change for that state.
    const mediaIds = withVoice.filter((m) => m.content_type === "image" || m.content_type === "video" || m.content_type === "document").map((m) => m.id)
    const mediaUrlByMessage = new Map<string, string>()
    if (mediaIds.length > 0) {
      try {
        const { data: { user } } = await createClient().auth.getUser()
        if (isStaffUser(user)) {
          const { data: mediaRows } = await supabaseAdmin
            .from("message_media")
            .select("message_id, status, storage_path, audio_deleted_at")
            .in("message_id", mediaIds)
            .eq("status", "ready")
          const ready = (mediaRows ?? []).filter((x) => x.storage_path && !x.audio_deleted_at)
          if (ready.length > 0) {
            const signed = await Promise.all(
              ready.map((x) => supabaseAdmin.storage.from(VOICE_BUCKET).createSignedUrl(x.storage_path as string, PLAYBACK_URL_SECONDS))
            )
            ready.forEach((x, i) => {
              const url = signed[i]?.data?.signedUrl
              if (url) mediaUrlByMessage.set(x.message_id, url)
            })
          }
        }
      } catch (mediaErr) {
        console.warn("WhatsApp media overlay failed (chat still loads):", mediaErr instanceof Error ? mediaErr.message : String(mediaErr))
      }
    }
    const withMedia0 = withVoice.map((m) => (mediaUrlByMessage.has(m.id) ? { ...m, media_url: mediaUrlByMessage.get(m.id) } : m))

    // CRM → phone reactions on their way or that did not go (dev job 5962e46d, Release 2): the status line under a message's reactions.
    // A SENT one needs no line (it is the green "phone" pill). Best-effort: a failure here must not hide the chat.
    const phoneByMessage = new Map<string, { status: string; desired: string; error: string | null }>()
    try {
      const { data: lanes } = await supabaseAdmin
        .from("wa_reaction_sync")
        .select("message_id, status, desired_emoji, error, requested_at")
        .eq("group_id", groupId)
        .in("status", ["pending", "sending", "failed", "expired"])
        .gt("requested_at", new Date(Date.now() - 2 * 60 * 60_000).toISOString())
        .limit(100)
      // "on its way" only counts for as long as it can still go out (a queued reaction expires after 15 minutes); older ones are not shown
      // as "sending…" even if nothing has swept them yet. Failures / expiries stay visible for the 2 hours above.
      const stillCanGo = Date.now() - 20 * 60_000
      for (const l of lanes ?? []) {
        if ((l.status === "pending" || l.status === "sending") && Date.parse(l.requested_at) < stillCanGo) continue
        phoneByMessage.set(l.message_id, { status: l.status, desired: l.desired_emoji, error: l.error })
      }
    } catch (laneErr) {
      console.warn("WhatsApp reaction status overlay failed (chat still loads):", laneErr instanceof Error ? laneErr.message : String(laneErr))
    }
    const withMedia = withMedia0.map((m) => (phoneByMessage.has(m.id) ? { ...m, phoneReaction: phoneByMessage.get(m.id) } : m))

    const messages = [...withMedia, ...outbox].sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)))
    return NextResponse.json({ messages, send, chat })
  } catch (error) {
    console.error("WhatsApp messages error:", error)
    return NextResponse.json(
      { error: "Failed to fetch WhatsApp messages" },
      { status: 500 }
    )
  }
}
