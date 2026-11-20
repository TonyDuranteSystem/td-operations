/**
 * Sends the weekly voice-note test (I/O half; the rules are in wabridge-voice-check.ts). It uses the SAME path a person's voice note
 * takes: the recording is stored where the send queue expects it, then `wabridge_enqueue_send` checks every rule (line healthy, sending
 * live, reply-only…) and queues it for the Mac. Nothing is written as "sent" unless the queue accepted it.
 */
import { createHash, randomBytes } from "crypto"
import { supabaseAdmin } from "@/lib/supabase-admin"
import { WA_OUTBOUND_BUCKET, buildOutboundPath } from "@/lib/messaging/wabridge-attachment"
import { parseEnqueueResult } from "@/lib/messaging/wabridge-outbox"
import { VOICE_CHECK_AUDIO_BASE64, VOICE_CHECK_AUDIO_MIME } from "@/lib/messaging/wabridge-voice-check-audio"
import { isoWeekKey, type VoiceCheck } from "@/lib/messaging/wabridge-voice-check"

/** `wa_bridge_state` columns added after the generated types — written through an untyped handle. */
type UntypedState = {
  from: (t: string) => { update: (p: Record<string, unknown>) => { eq: (k: string, v: string) => Promise<{ error: { message: string } | null }> } }
}

export async function saveVoiceCheck(channelId: string, vc: VoiceCheck | null): Promise<boolean> {
  const untyped = supabaseAdmin as unknown as UntypedState
  const { error } = await untyped.from("wa_bridge_state").update({ voice_check: vc }).eq("channel_id", channelId)
  return !error
}

export async function sendVoiceCheck(channelId: string, testChatId: string, now: Date = new Date()): Promise<VoiceCheck> {
  const week = isoWeekKey(now)
  const sentAt = now.toISOString()
  const clientMsgId = `voice-check-${week}-${randomBytes(4).toString("hex")}`
  const failed = (error: string): VoiceCheck => ({ week, status: "send_failed", sent_at: sentAt, client_msg_id: clientMsgId, error })

  const bytes = Buffer.from(VOICE_CHECK_AUDIO_BASE64, "base64")
  const path = buildOutboundPath(channelId, clientMsgId, VOICE_CHECK_AUDIO_MIME)
  const { error: uploadError } = await supabaseAdmin.storage.from(WA_OUTBOUND_BUCKET).upload(path, bytes, { contentType: VOICE_CHECK_AUDIO_MIME, upsert: true })
  if (uploadError) return failed("The test recording could not be stored.")

  const { data, error } = await supabaseAdmin.rpc("wabridge_enqueue_send", {
    p_group_id: testChatId,
    p_kind: "voice",
    p_caption: null,
    p_client_msg_id: clientMsgId,
    p_media_mime: VOICE_CHECK_AUDIO_MIME,
    p_media_size: bytes.length,
    p_content_hash: createHash("sha256").update(bytes).digest("hex"),
    p_created_by: null,
  })
  const result = error ? parseEnqueueResult(null) : parseEnqueueResult(data)
  if (result.ok === false) return failed(result.message)
  return { week, status: "sent", sent_at: sentAt, client_msg_id: clientMsgId, outbox_id: result.id }
}
