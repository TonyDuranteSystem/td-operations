/**
 * Voice notes in the client-portal chat (dev job 753b2909). Pure rules shared by the chat screen, the staff screens
 * (Portal Chats page, contact chat), the "Show text" route and the staff alerts, so they never disagree about what a
 * voice note is, what to show when a message has no words, or who may open one.
 */

type AttLike = { url?: string | null; name?: string | null; mime_type?: string | null }

/** What a staff alert / reply preview says for a message that is only a voice note. */
export const VOICE_PREVIEW = '🎤 Voice note'

// .mp4 and .webm are deliberately NOT here: without a mime type they could be a video. A note recorded in the portal always carries `audio/...`.
const AUDIO_EXT = /\.(m4a|mp3|ogg|oga|opus|wav|aac)(\?|$)/i

/** True when this attachment is a voice note / audio file (shown with a player instead of a download link). */
export function isVoiceAttachment(a: AttLike | null | undefined): boolean {
  if (!a || typeof a.url !== 'string' || !a.url) return false
  const mime = (a.mime_type || '').toLowerCase()
  if (mime) return mime.startsWith('audio/')
  return AUDIO_EXT.test(a.name || '') || AUDIO_EXT.test(a.url)
}

export function hasVoiceAttachment(attachments: unknown): boolean {
  return Array.isArray(attachments) && attachments.some(a => isVoiceAttachment(a as AttLike))
}

/**
 * The one line staff alerts and reply previews show for a message. A message with words shows its words; one that is only a
 * voice note says so (instead of an empty line or "[Attachment]"). Anything else returns what was written, possibly '' — the caller keeps its own fallback.
 */
export function chatPreviewText(message: string | null | undefined, attachments: unknown): string {
  const text = (message || '').trim()
  if (text) return text
  return hasVoiceAttachment(attachments) ? VOICE_PREVIEW : text
}

/**
 * The "Show text" result is written onto the attachment by OUR route only. A sender (a browser) may hand over a file, never the text a
 * machine supposedly heard in it — so these two fields are dropped from anything a sender submits.
 */
export function stripSenderTranscripts<T>(attachments: T[]): T[] {
  return attachments.map(a => {
    if (!a || typeof a !== 'object') return a
    const copy = { ...(a as Record<string, unknown>) }
    delete copy.transcript
    delete copy.flattened_at
    return copy as T
  })
}

/**
 * Who may open "Show text" on a portal message. Staff: any message. A client: a message of a company they may use chat for, or — when the
 * message belongs to no company — only their own message thread. Everyone else (marketing logins, partners, signed-out) never.
 * `accountAllowed` is the answer of canAccessAccount for the message's company; the route computes it.
 */
export function decideMessageVoiceAccess(i: {
  isStaff: boolean
  isClient: boolean
  accountAllowed: boolean
  authContactId: string | null
  message: { account_id: string | null; contact_id: string | null }
}): boolean {
  if (i.isStaff) return true
  if (!i.isClient) return false
  if (i.message.account_id) return i.accountAllowed
  return !!i.authContactId && i.message.contact_id === i.authContactId
}

/** The voice-note addresses inside a message's attachments, in order. Used to recognise a send that is being tried a second time. */
export function voiceUrls(attachments: unknown): string[] {
  if (!Array.isArray(attachments)) return []
  const urls: string[] = []
  for (const a of attachments) {
    if (isVoiceAttachment(a as AttLike) && typeof (a as AttLike).url === 'string') urls.push((a as { url: string }).url)
  }
  return urls
}

/**
 * A voice note that did not go out stays held for the company it was being sent to (`heldFor`, null while no company was chosen yet).
 * When the "which company?" window is answered, does the waiting note go out for the company just picked? Only if it was never
 * bound to a company, or the pick is its own company — picking another company only moves the view, the note stays put.
 */
export function heldVoiceGoesOut(heldFor: string | null, pickedId: string): boolean {
  return !heldFor || heldFor === pickedId
}

/**
 * Where a click on a link would take the client, as an in-app address — or null when it would not leave this page for another one
 * (opens a new tab, downloads, goes to another site, or only changes the #fragment). The chat uses it to ask before a click on the menu
 * throws away a voice note that has not been sent.
 */
export function leavingHref(
  anchor: { href: string; target?: string | null; download?: boolean },
  current: { origin: string; pathname: string; search: string },
): string | null {
  if (anchor.download) return null
  if (anchor.target && anchor.target !== '_self') return null
  let url: URL
  try { url = new URL(anchor.href, current.origin) } catch { return null }
  if (url.origin !== current.origin) return null
  if (url.pathname === current.pathname && url.search === current.search) return null
  return `${url.pathname}${url.search}${url.hash}`
}

/**
 * The staff conversation list shows the last message's words; a voice-only last message would be an empty line. Given the list rows
 * and the (few) latest messages that have no words, returns the rows with "🎤 Voice note" filled in where the last message really
 * is a voice note. Matched on the exact moment the message was written.
 */
export function fillVoiceListPreviews<T extends { last_message: string; last_message_at: string }>(
  threads: T[],
  wordless: Array<{ created_at: string; attachments: unknown }>,
): T[] {
  const voiceAt = new Set<number>()
  for (const m of wordless) if (hasVoiceAttachment(m.attachments)) voiceAt.add(Date.parse(m.created_at))
  if (voiceAt.size === 0) return threads
  return threads.map(t =>
    !t.last_message.trim() && voiceAt.has(Date.parse(t.last_message_at)) ? { ...t, last_message: VOICE_PREVIEW } : t,
  )
}
