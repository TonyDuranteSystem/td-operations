import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { findOrCreateWhatsAppGroup } from "@/lib/messaging/groups"
import { digitsOnly } from "@/lib/messaging/phone"
import { sendDisconnectAlertEmail } from "@/lib/messaging/disconnect-alert"

export const dynamic = "force-dynamic"

interface TwoChatWebhookPayload {
  // Status-change events (disconnected / qr-received / message.read) carry `event`.
  event?: string
  payload?: { reason?: string }
  // A "New Message Received" payload carries none of the above — only these.
  id?: string
  uuid?: string
  message?: { text?: string; media?: { url?: string; type?: string; mime_type?: string } }
  remote_phone_number?: string
  channel_phone_number?: string
  sent_by?: "user" | "agent"
}

/** messages.content_type CHECK constraint: text/image/document/voice/video/location/contact/sticker/other. */
const VALID_CONTENT_TYPES = new Set([
  "text", "image", "document", "voice", "video", "location", "contact", "sticker", "other",
])

function mapMediaType(twoChatType: string | undefined): string {
  if (!twoChatType) return "other"
  return VALID_CONTENT_TYPES.has(twoChatType) ? twoChatType : "other"
}

/**
 * POST /api/webhooks/2chat/[channelId]?secret=<messaging_channels.webhook_secret>
 *
 * 2Chat's own webhook, one URL per connected WhatsApp channel. The channel is
 * identified by the URL, not by the payload's channel_phone_number — that
 * field is cross-checked below but never trusted for routing, since it's
 * attacker-controlled the same as the rest of the body.
 *
 * Fail-closed: 2Chat's docs don't expose a request-signing scheme, so the
 * secret embedded in the registered webhook URL is this endpoint's only proof
 * of origin. A channel with no secret configured accepts nothing — the
 * stricter precedent already used here for Stripe/Whop, not the "warn and
 * process anyway" one used for Relay/Banking Circle (Security review finding).
 */
export async function POST(
  req: NextRequest,
  { params }: { params: { channelId: string } }
) {
  const { channelId } = params
  const secret = req.nextUrl.searchParams.get("secret")

  const { data: channel, error: channelError } = await supabaseAdmin
    .from("messaging_channels")
    .select("id, phone_number, webhook_secret")
    .eq("id", channelId)
    .single()

  if (channelError || !channel) {
    return NextResponse.json({ error: "Unknown channel" }, { status: 404 })
  }
  if (!channel.webhook_secret || secret !== channel.webhook_secret) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const body = (await req.json().catch(() => null)) as TwoChatWebhookPayload | null
  if (!body) {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  // ─── Status-change events ────────────────────────────────────────────────
  if (body.event) {
    if (body.event === "disconnected") {
      await sendDisconnectAlertEmail({
        channelName: channel.phone_number ?? channelId,
        reason: body.payload?.reason ?? "unknown",
      })
    }
    // qr-received / message.read: acknowledged, no further action needed yet.
    return NextResponse.json({ ok: true })
  }

  // ─── Inbound message ─────────────────────────────────────────────────────
  if (body.sent_by !== "user") {
    // Our own outbound send echoed back by 2Chat — already recorded when sent.
    return NextResponse.json({ ok: true, skipped: "not a user message" })
  }
  if (!body.remote_phone_number) {
    return NextResponse.json({ error: "Missing remote_phone_number" }, { status: 400 })
  }

  const groupResult = await findOrCreateWhatsAppGroup({
    channelId: channel.id,
    remoteIdentifier: body.remote_phone_number,
  })
  if ("error" in groupResult) {
    return NextResponse.json({ error: groupResult.error }, { status: 500 })
  }

  const { error: insertError } = await supabaseAdmin.from("messages").insert({
    group_id: groupResult.group.id,
    channel_id: channel.id,
    external_message_id: body.uuid ?? body.id ?? null,
    direction: "inbound",
    sender_phone: `+${digitsOnly(body.remote_phone_number)}`,
    content_text: body.message?.text ?? null,
    content_type: mapMediaType(body.message?.media?.type),
    media_url: body.message?.media?.url ?? null,
    status: "new",
  })

  if (insertError) {
    // A redelivered webhook hits the unique constraint on external_message_id —
    // that's a successful dedup, not a failure; every other error is real.
    if (insertError.code === "23505") {
      return NextResponse.json({ ok: true, deduped: true })
    }
    return NextResponse.json({ error: insertError.message }, { status: 500 })
  }

  const { data: current } = await supabaseAdmin
    .from("messaging_groups")
    .select("unread_count")
    .eq("id", groupResult.group.id)
    .single()
  await supabaseAdmin
    .from("messaging_groups")
    .update({
      last_message_at: new Date().toISOString(),
      unread_count: (current?.unread_count ?? 0) + 1,
    })
    .eq("id", groupResult.group.id)

  return NextResponse.json({ ok: true })
}
