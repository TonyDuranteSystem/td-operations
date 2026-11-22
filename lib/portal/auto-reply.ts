/**
 * Out-of-office auto-reply for portal chat.
 *
 * When a client sends a message outside office hours (Mon–Fri 9 AM–3 PM ET),
 * this module inserts a system message into their chat thread so they know
 * immediately that the office is closed and when to expect a response.
 *
 * Planned closures (lib/portal/office-closures.ts — a holiday week): while the office is
 * closed by one, the reply is the closure's own words (with the reopen day) instead of
 * "next business day"; in the days just before it, the normal reply carries the heads-up.
 *
 * Throttle: at most 1 auto-reply per contact (or account) per 4 hours.
 * The throttle is implemented by checking for an existing system message
 * carrying the AUTO_REPLY_MARKER in the last 4 hours — no extra table needed.
 */

import { supabaseAdmin } from '@/lib/supabase-admin'
import { localeFromLanguage, type Locale } from '@/lib/locale'
import { getActiveClosure } from '@/lib/portal/office-hours'
import { closureCopy } from '@/lib/portal/office-closures'

// Deterministic placeholder UUID used by all system-authored portal messages.
// Same constant as lib/portal/chat-events.ts — sender_id is NOT NULL in the DB.
const SYSTEM_SENDER_ID = '00000000-0000-0000-0000-000000000000'

// HTML comment embedded in the message body — invisible to clients (stripped
// by renderMessageText in portal-chat.tsx) but queryable for dedup.
export const AUTO_REPLY_MARKER = '<!-- auto-reply:office-closed -->'
// A planned closure's reply has its OWN marker: the 4 h throttle looks for one marker only, so a normal after-hours
// reply sent late the evening before must not silence the closure reply a few hours later.
export const CLOSURE_REPLY_MARKER = '<!-- auto-reply:office-closure -->'

const THROTTLE_MS = 4 * 60 * 60 * 1000 // 4 hours

const OUT_OF_OFFICE: Record<Locale, string> = {
  en: 'We are currently closed. Our office is open Monday to Friday, 9 AM – 3 PM Eastern Time. We will get back to you on the next business day.',
  it: 'Siamo attualmente chiusi. Il nostro ufficio è aperto dal lunedì al venerdì, dalle 9:00 alle 15:00 (ora della costa est). Ti risponderemo il prossimo giorno lavorativo.',
}

/** The marker (and so the throttle) a reply sent at `now` falls under. */
export function autoReplyMarker(now: Date = new Date()): string {
  return getActiveClosure(now)?.phase === 'closed' ? CLOSURE_REPLY_MARKER : AUTO_REPLY_MARKER
}

/**
 * The words of the reply for a client language at `now` (without the hidden marker).
 *   - office closed by a planned closure → the closure's own reply (reopen day included);
 *   - a closure starts in the next days (heads-up phase) → the normal reply + the heads-up, because
 *     "we will get back to you on the next business day" would promise a day we are closed;
 *   - otherwise the normal reply.
 */
export function buildAutoReplyText(locale: Locale, now: Date = new Date()): string {
  const normal = OUT_OF_OFFICE[locale] ?? OUT_OF_OFFICE.en
  const active = getActiveClosure(now)
  if (active?.phase === 'closed') return closureCopy(active.closure, locale).autoReply
  if (active?.phase === 'notice') return normal + '\n\n' + closureCopy(active.closure, locale).noticeMessage
  return normal
}

/**
 * Insert a system auto-reply into the client's chat thread, unless one was
 * already sent for this contact/account in the last 4 hours.
 *
 * The chat route waits for this (bounded) before it answers: a serverless
 * function can be stopped as soon as it has answered, and this is the message
 * a client most needs on a closed day. Callers still `.catch(() => {})` it.
 */
export async function sendOfficeClosedAutoReply(params: {
  account_id: string | null
  contact_id: string | null
  /** Topic of the client's original message — auto-reply appears in same thread. */
  topic: string | null
}): Promise<void> {
  const { account_id, contact_id, topic } = params

  if (!contact_id && !account_id) return

  const now = new Date()
  const marker = autoReplyMarker(now)

  // Throttle: has a system auto-reply of this kind already been sent in the last 4 hours?
  const cutoff = new Date(now.getTime() - THROTTLE_MS).toISOString()

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let dedupQuery: any = supabaseAdmin
    .from('portal_messages')
    .select('id')
    .eq('sender_type', 'system')
    .like('message', `%${marker}%`)
    .gte('created_at', cutoff)
    .limit(1)

  if (contact_id) {
    dedupQuery = dedupQuery.eq('contact_id', contact_id)
  } else if (account_id) {
    dedupQuery = dedupQuery.eq('account_id', account_id)
  }

  const { data: recent } = await dedupQuery.maybeSingle()
  if (recent) return // Already replied within the throttle window

  // Resolve client language for the bilingual message. contacts.language is free text ("Italian", "Italiano", "it", null …):
  // it MUST go through the shared normaliser — the old exact lookup on 'en'/'it' sent every client saved as "Italian" the English text.
  let language: string | null = null
  if (contact_id) {
    const { data: contact } = await supabaseAdmin
      .from('contacts')
      .select('language')
      .eq('id', contact_id)
      .maybeSingle()
    language = contact?.language ?? null
  }

  const messageBody = buildAutoReplyText(localeFromLanguage(language), now) + '\n\n' + marker

  const { error } = await supabaseAdmin.from('portal_messages').insert({
    account_id,
    contact_id,
    sender_type: 'system',
    sender_id: SYSTEM_SENDER_ID,
    message: messageBody,
    topic: topic ?? null,
    attachments: [],
  })

  if (error) {
    console.error('[auto-reply] Failed to insert office-closed reply:', error.message)
  }
}
