import { NextRequest, NextResponse } from "next/server"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { findOrCreateTelegramGroup } from "@/lib/messaging/telegram-groups"

export const dynamic = "force-dynamic"

interface TelegramUpdate {
  update_id: number
  message?: {
    message_id: number
    date: number
    text?: string
    chat: { id: number; type: string; first_name?: string; username?: string; title?: string }
    from?: { id: number; first_name?: string; username?: string }
  }
}

/**
 * POST /api/webhooks/telegram/[channelId]
 *
 * One URL per connected Telegram bot (today: exactly one, @Tony_Durante_bot).
 * The channel comes from the URL, never from the payload — same principle as
 * the 2Chat webhook (app/api/webhooks/2chat/[channelId]).
 *
 * Auth is Telegram's OWN mechanism, not the `?secret=` URL-param convention
 * 2Chat uses: `setWebhook`'s `secret_token` param registers a value Telegram
 * echoes back on every call as the `X-Telegram-Bot-Api-Secret-Token` header —
 * this exists specifically so the secret never sits in a URL (server logs,
 * proxies), which a query-string secret would. Still fail-closed: a channel
 * with no `webhook_secret` configured accepts nothing.
 *
 * Only plain text `message` updates are handled in this pass — `edited_message`,
 * `channel_post`, `callback_query`, stickers/photos/etc. are acknowledged
 * (200, so Telegram doesn't retry) but not stored. Matches the "receive +
 * reply" scope this channel was built for; media support is a later addition,
 * same as WhatsApp's own media handling was built separately from its first
 * text-only pass.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: { channelId: string } }
) {
  const { channelId } = params
  const secretHeader = req.headers.get("x-telegram-bot-api-secret-token")

  const { data: channel, error: channelError } = await supabaseAdmin
    .from("messaging_channels")
    .select("id, webhook_secret")
    .eq("id", channelId)
    .single()

  if (channelError || !channel) {
    return NextResponse.json({ error: "Unknown channel" }, { status: 404 })
  }
  if (!channel.webhook_secret || secretHeader !== channel.webhook_secret) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const update = (await req.json().catch(() => null)) as TelegramUpdate | null
  if (!update) {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const message = update.message
  if (!message || typeof message.text !== "string") {
    // Non-text or non-message update (edited message, sticker, callback query,
    // channel post, …) — acknowledged so Telegram doesn't retry, not stored.
    return NextResponse.json({ ok: true, skipped: "not a text message" })
  }

  const chatId = String(message.chat.id)
  const senderName =
    message.from?.first_name ??
    message.chat.first_name ??
    message.chat.title ??
    (message.from?.username ? `@${message.from.username}` : null)
  const groupName = message.chat.title ?? senderName ?? chatId

  const groupResult = await findOrCreateTelegramGroup({
    channelId: channel.id,
    chatId,
    groupName,
  })
  if ("error" in groupResult) {
    return NextResponse.json({ error: groupResult.error }, { status: 500 })
  }

  const { error: insertError } = await supabaseAdmin.from("messages").insert({
    group_id: groupResult.group.id,
    channel_id: channel.id,
    external_message_id: `${chatId}:${message.message_id}`,
    direction: "inbound",
    sender_name: senderName,
    content_text: message.text,
    content_type: "text",
    status: "new",
  })

  if (insertError) {
    // A redelivered webhook hits the unique constraint on external_message_id
    // — that's a successful dedup, not a failure; every other error is real.
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
      // A genuinely new inbound message revives a hidden (deleted) conversation
      // — same rule as WhatsApp's inbound handler (2026-09-18 fix).
      is_active: true,
    })
    .eq("id", groupResult.group.id)

  return NextResponse.json({ ok: true })
}
