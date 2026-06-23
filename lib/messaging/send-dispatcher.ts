/**
 * WhatsApp provider dispatch layer.
 *
 * Architecture: read `provider` from messaging_channels → route to the registered
 * handler → if provider is NULL (not configured) or unknown, return a clear error.
 *
 * Adding a new provider = register one handler in PROVIDER_HANDLERS below.
 * No provider name is hardcoded outside this file.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"

export type SendResult = { ok: true; result: unknown } | { ok: false; error: string }

type ProviderHandler = (
  chatId: string,
  message: string,
  channelId: string
) => Promise<SendResult>

// TODO: implement Meta WABA send
async function sendViaMeta(
  _chatId: string,
  _message: string,
  _channelId: string
): Promise<SendResult> {
  throw new Error("Meta WABA provider not yet implemented")
}

// TODO: implement Twilio send
async function sendViaTwilio(
  _chatId: string,
  _message: string,
  _channelId: string
): Promise<SendResult> {
  throw new Error("Twilio provider not yet implemented")
}

const PROVIDER_HANDLERS: Record<string, ProviderHandler> = {
  meta: sendViaMeta,
  twilio: sendViaTwilio,
}

/**
 * Dispatch a WhatsApp message via the channel's configured provider.
 * Returns `{ ok: false, error }` for any failure rather than throwing,
 * so callers can surface the exact reason to the user.
 */
export async function dispatchWhatsAppMessage(
  chatId: string,
  message: string,
  channelId: string
): Promise<SendResult> {
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

  try {
    return await handler(chatId, message, channelId)
  } catch (err: unknown) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}
