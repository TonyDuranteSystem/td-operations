/**
 * WhatsApp provider dispatch layer.
 *
 * Architecture: read `provider` from messaging_channels → route to the registered
 * handler → if provider is NULL (not configured) or unknown, return a clear error.
 *
 * Adding a new provider = register one handler in PROVIDER_HANDLERS below.
 * No provider name is hardcoded outside this file.
 *
 * This is also the ONE place an outbound send gets recorded into `messages` —
 * every caller (Inbox reply, new-conversation, anything future) goes through
 * `dispatchWhatsAppMessage`, so none of them can forget to save what was sent.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import { jidToE164 } from "@/lib/messaging/phone"

export type SendResult = { ok: true; result: unknown } | { ok: false; error: string }

export interface SendOptions {
  /** A publicly (or time-boxed-publicly) fetchable URL for an attached file/image. */
  mediaUrl?: string
}

type ProviderHandler = (
  chatId: string,
  message: string,
  channelId: string,
  options: SendOptions
) => Promise<SendResult>

// TODO: implement Meta WABA send
async function sendViaMeta(
  _chatId: string,
  _message: string,
  _channelId: string,
  _options: SendOptions
): Promise<SendResult> {
  throw new Error("Meta WABA provider not yet implemented")
}

// TODO: implement Twilio send
async function sendViaTwilio(
  _chatId: string,
  _message: string,
  _channelId: string,
  _options: SendOptions
): Promise<SendResult> {
  throw new Error("Twilio provider not yet implemented")
}

// 2Chat.co — QR-linked WhatsApp Web session, no Business API conversion.
// https://developers.2chat.co/docs/API/WhatsApp/Web/send-message
async function sendVia2Chat(
  chatId: string,
  message: string,
  channelId: string,
  options: SendOptions
): Promise<SendResult> {
  const apiKey = process.env.TWOCHAT_API_KEY
  if (!apiKey) {
    return { ok: false, error: "TWOCHAT_API_KEY is not set" }
  }

  const { data: channel, error } = await supabaseAdmin
    .from("messaging_channels")
    .select("phone_number")
    .eq("id", channelId)
    .single()

  if (error || !channel?.phone_number) {
    return {
      ok: false,
      error: `messaging_channels: no phone_number for channel ${channelId}`,
    }
  }

  const response = await fetch("https://api.p.2chat.io/open/whatsapp/send-message", {
    method: "POST",
    headers: {
      "X-User-API-Key": apiKey,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from_number: jidToE164(channel.phone_number as string),
      to_number: jidToE164(chatId),
      text: message,
      ...(options.mediaUrl ? { url: options.mediaUrl } : {}),
    }),
  })

  const result: unknown = await response.json().catch(() => ({}))
  const succeeded = (result as { success?: boolean } | null)?.success === true

  if (!response.ok || !succeeded) {
    return {
      ok: false,
      error: `2Chat send failed (${response.status}): ${JSON.stringify(result)}`,
    }
  }

  return { ok: true, result }
}

// Self-hosted linked-device bridge (GOWA on the Mac Mini). This inline path NEVER sends: replies in the CRM inbox are queued by
// /api/inbox/reply through wabridge_enqueue_reply (reply-only, paused by default) and sent by the Mac's own sender. Everything that
// still lands here — the "new WhatsApp conversation" dialog, the MCP msg_send tool — would be FIRST CONTACT, which Antonio decided
// stays on the phone. Fail loudly rather than silently pretend to send.
async function sendViaWabridge(
  _chatId: string,
  _message: string,
  _channelId: string,
  _options: SendOptions
): Promise<SendResult> {
  throw new Error(
    "Starting a new WhatsApp conversation from the CRM is not allowed on this line — first contact is made from the phone. (Replying to a chat that has written to you is done from that chat in the Inbox.)"
  )
}

const PROVIDER_HANDLERS: Record<string, ProviderHandler> = {
  meta: sendViaMeta,
  twilio: sendViaTwilio,
  twochat: sendVia2Chat,
  wabridge: sendViaWabridge,
}

export interface DispatchParams {
  chatId: string
  message: string
  channelId: string
  /** The messaging_groups row this send belongs to — required to record it. */
  groupId: string
  mediaUrl?: string
}

/**
 * Dispatch a WhatsApp message via the channel's configured provider, and
 * record it as an outbound `messages` row on success. Returns
 * `{ ok: false, error }` for any failure rather than throwing, so callers can
 * surface the exact reason to the user.
 */
export async function dispatchWhatsAppMessage(params: DispatchParams): Promise<SendResult> {
  const { chatId, message, channelId, groupId, mediaUrl } = params

  const { data: channel, error } = await supabaseAdmin
    .from("messaging_channels")
    .select("provider")
    .eq("id", channelId)
    .single()

  if (error || !channel) {
    return { ok: false, error: `messaging_channels: channel ${channelId} not found` }
  }

  const { provider } = channel as { provider: string | null }

  if (!provider) {
    return {
      ok: false,
      error:
        "WhatsApp provider not configured. Set provider in messaging_channels.",
    }
  }

  const handler = PROVIDER_HANDLERS[provider]
  if (!handler) {
    return {
      ok: false,
      error: `Unknown WhatsApp provider "${provider}". Supported: ${Object.keys(PROVIDER_HANDLERS).join(", ")}.`,
    }
  }

  let result: SendResult
  try {
    result = await handler(chatId, message, channelId, { mediaUrl })
  } catch (err: unknown) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }

  if (result.ok) {
    // Best-effort — a failed save must not turn a real, delivered send into
    // an error response (the message already went out; only our own copy
    // of it would be missing).
    try {
      await supabaseAdmin.from("messages").insert({
        group_id: groupId,
        channel_id: channelId,
        direction: "outbound",
        content_text: message,
        content_type: mediaUrl ? "media" : "text",
        media_url: mediaUrl ?? null,
        status: "responded",
      })
      await supabaseAdmin
        .from("messaging_groups")
        .update({ last_message_at: new Date().toISOString() })
        .eq("id", groupId)
    } catch (saveErr) {
      console.warn(
        `[dispatchWhatsAppMessage] sent OK but failed to save the outbound copy for group ${groupId}:`,
        saveErr instanceof Error ? saveErr.message : String(saveErr)
      )
    }
  }

  return result
}
