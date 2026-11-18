/**
 * Server-side check that a posted voice note is not a damaged file (TD Talk, 18 Nov 2026). Looks only at the first bytes of audio files on OUR
 * storage; any trouble reaching the file lets the message through (a network blip must never block a real message).
 */
import { isDamagedAudioHead, claimedAudioKind } from '@/lib/media/audio-header'

export const DAMAGED_VOICE_MESSAGE = 'That voice recording is damaged, so it was not sent. Please record it again.'

interface AttachmentLike { url?: unknown; name?: unknown; mime_type?: unknown }

/** Returns the error text when one of the audio attachments is damaged, otherwise null. */
export async function findDamagedVoiceAttachment(
  attachments: AttachmentLike[] | null | undefined,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 4000,
): Promise<string | null> {
  if (!attachments?.length) return null
  for (const a of attachments) {
    const url = typeof a?.url === 'string' ? a.url.trim() : ''
    const mime = typeof a?.mime_type === 'string' ? a.mime_type : ''
    const name = typeof a?.name === 'string' ? a.name : ''
    // only audio files: a picture or document is none of this check's business
    if (!url || !mime.toLowerCase().startsWith('audio/') || !claimedAudioKind(mime || name)) continue
    try {
      const res = await fetchImpl(url, { headers: { Range: 'bytes=0-15' }, signal: AbortSignal.timeout(timeoutMs) })
      if (!res.ok) continue
      const head = new Uint8Array(await res.arrayBuffer()).subarray(0, 16)
      if (isDamagedAudioHead(head, mime || name)) return DAMAGED_VOICE_MESSAGE
    } catch {
      /* could not look: let it through */
    }
  }
  return null
}
