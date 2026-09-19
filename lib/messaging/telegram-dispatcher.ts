/**
 * Telegram Bot API send + record.
 *
 * Deliberately its OWN env var, `TELEGRAM_CLIENT_BOT_TOKEN` — NOT the existing
 * `TELEGRAM_BOT_TOKEN`, which belongs to Hermes (Antonio's personal research/
 * notification bridge, lib/ai-agent/telegram-notify.ts). Reusing that token
 * would put real client conversations through Antonio's own approval bot.
 * Confirmed with a fresh, dedicated bot (@Tony_Durante_bot) instead.
 *
 * Mirrors send-dispatcher.ts's shape (dispatch → record the outbound copy in
 * `messages` on success) but Telegram has exactly one provider, so there's no
 * PROVIDER_HANDLERS registry to route through like WhatsApp's.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"

export type TelegramSendResult = { ok: true; result: unknown } | { ok: false; error: string }

export interface TelegramDispatchParams {
  /** Telegram's `chat.id`, as stored in messaging_groups.external_group_id. */
  chatId: string
  message: string
  channelId: string
  groupId: string
}

/**
 * Send a text message via the Telegram Bot API and record it as an outbound
 * `messages` row on success. A bot can only message a chat that has messaged
 * it first — Telegram's own platform rule, not something this code can work
 * around — so a send to a chat that has never opened the bot fails with
 * Telegram's own "chat not found" error, surfaced verbatim in `error`.
 */
export async function dispatchTelegramMessage(
  params: TelegramDispatchParams
): Promise<TelegramSendResult> {
  const token = process.env.TELEGRAM_CLIENT_BOT_TOKEN
  if (!token) {
    return { ok: false, error: "TELEGRAM_CLIENT_BOT_TOKEN is not set" }
  }

  const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: params.chatId, text: params.message }),
  })

  const result: unknown = await response.json().catch(() => ({}))
  const ok = (result as { ok?: boolean } | null)?.ok === true

  if (!response.ok || !ok) {
    const description = (result as { description?: string } | null)?.description
    return { ok: false, error: description || `Telegram send failed (${response.status})` }
  }

  // Best-effort — a failed save must not turn a real, delivered send into an
  // error response (the message already went out; only our own copy of it
  // would be missing). Same tradeoff as dispatchWhatsAppMessage.
  try {
    await supabaseAdmin.from("messages").insert({
      group_id: params.groupId,
      channel_id: params.channelId,
      direction: "outbound",
      content_text: params.message,
      content_type: "text",
      status: "responded",
    })
    await supabaseAdmin
      .from("messaging_groups")
      .update({ last_message_at: new Date().toISOString() })
      .eq("id", params.groupId)
  } catch (saveErr) {
    console.warn(
      `[dispatchTelegramMessage] sent OK but failed to save the outbound copy for group ${params.groupId}:`,
      saveErr instanceof Error ? saveErr.message : String(saveErr)
    )
  }

  return { ok: true, result }
}
