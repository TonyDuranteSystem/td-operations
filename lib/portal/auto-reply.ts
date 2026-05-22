/**
 * Out-of-office auto-reply for portal chat.
 *
 * When a client sends a message outside office hours (Mon–Fri 9 AM–3 PM ET),
 * this module inserts a system message into their chat thread so they know
 * immediately that the office is closed and when to expect a response.
 *
 * Throttle: at most 1 auto-reply per contact (or account) per 4 hours.
 * The throttle is implemented by checking for an existing system message
 * carrying the AUTO_REPLY_MARKER in the last 4 hours — no extra table needed.
 */

import { supabaseAdmin } from '@/lib/supabase-admin'

// Deterministic placeholder UUID used by all system-authored portal messages.
// Same constant as lib/portal/chat-events.ts — sender_id is NOT NULL in the DB.
const SYSTEM_SENDER_ID = '00000000-0000-0000-0000-000000000000'

// HTML comment embedded in the message body — invisible to clients (stripped
// by renderMessageText in portal-chat.tsx) but queryable for dedup.
const AUTO_REPLY_MARKER = '<!-- auto-reply:office-closed -->'

const THROTTLE_MS = 4 * 60 * 60 * 1000 // 4 hours

const OUT_OF_OFFICE: Record<string, string> = {
  en: 'We are currently closed. Our office is open Monday to Friday, 9 AM – 3 PM Eastern Time. We will get back to you on the next business day.',
  it: 'Siamo attualmente chiusi. Il nostro ufficio è aperto dal lunedì al venerdì, dalle 9:00 alle 15:00 (ora della costa est). Ti risponderemo il prossimo giorno lavorativo.',
}

/**
 * Insert a system auto-reply into the client's chat thread, unless one was
 * already sent for this contact/account in the last 4 hours.
 *
 * Fire-and-forget: callers should `.catch(() => {})` the returned Promise.
 */
export async function sendOfficeClosedAutoReply(params: {
  account_id: string | null
  contact_id: string | null
  /** Topic of the client's original message — auto-reply appears in same thread. */
  topic: string | null
}): Promise<void> {
  const { account_id, contact_id, topic } = params

  if (!contact_id && !account_id) return

  // Throttle: has a system auto-reply already been sent in the last 4 hours?
  const cutoff = new Date(Date.now() - THROTTLE_MS).toISOString()

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let dedupQuery: any = supabaseAdmin
    .from('portal_messages')
    .select('id')
    .eq('sender_type', 'system')
    .like('message', `%${AUTO_REPLY_MARKER}%`)
    .gte('created_at', cutoff)
    .limit(1)

  if (contact_id) {
    dedupQuery = dedupQuery.eq('contact_id', contact_id)
  } else if (account_id) {
    dedupQuery = dedupQuery.eq('account_id', account_id)
  }

  const { data: recent } = await dedupQuery.maybeSingle()
  if (recent) return // Already replied within the throttle window

  // Resolve client language for bilingual message
  let language = 'en'
  if (contact_id) {
    const { data: contact } = await supabaseAdmin
      .from('contacts')
      .select('language')
      .eq('id', contact_id)
      .maybeSingle()
    language = contact?.language ?? 'en'
  }

  const messageBody =
    (OUT_OF_OFFICE[language] ?? OUT_OF_OFFICE.en) + '\n\n' + AUTO_REPLY_MARKER

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
