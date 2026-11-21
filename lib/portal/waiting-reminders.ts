/**
 * Automatic reminder for conversations staff marked "waiting for client" (2026-11-21, dev job 954af5db).
 * Backed by the daily /api/cron/waiting-for-client-reminders.
 *
 * For every mark where the client has NOT written since it was made, 3 days after the mark (then 3 days after each
 * reminder, at most 2) the client gets the portal's usual three-channel notice through `notifyClientActionRequired`:
 * a line in their portal chat, an immediate email (their language), and the bell/push. Decisions are in the pure
 * functions of lib/portal-chats/waiting.ts. Clients the portal cannot reach (closed company, no email on file) are
 * counted in `unreachable` so staff can follow up by hand — WhatsApp is NOT used here (the bridge can only reply
 * to someone who wrote to that number first, and is approval-only).
 */

import { supabaseAdmin } from '@/lib/supabase-admin'
import { notifyClientActionRequired } from './action-required'
import { buildPortalChatLink } from './chat-link'
import { decideWaitingReminder, isStillWaiting } from '@/lib/portal-chats/waiting'

/** Bound each sweep so a backlog can never blow the cron budget. */
const SWEEP_LIMIT = 100

export interface WaitingSweepResult {
  scanned: number
  dispatched: number
  skipped: number
  /** Marks whose client the portal cannot reach (closed company or no email on file) — staff follow up by hand. */
  unreachable: number
  errors: string[]
}

type WaitRow = { id: string; account_id: string | null; contact_id: string | null; marked_at: string; reminders_sent: number; last_reminder_at: string | null }

export async function runWaitingReminderSweep(now: Date = new Date()): Promise<WaitingSweepResult> {
  const result: WaitingSweepResult = { scanned: 0, dispatched: 0, skipped: 0, unreachable: 0, errors: [] }

  // New table — not in generated types until the migration is promoted and types regenerate (same cast as the routes).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { data: rows, error } = await (supabaseAdmin as any)
    .from('portal_chat_waiting_threads')
    .select('id, account_id, contact_id, marked_at, reminders_sent, last_reminder_at')
    .order('marked_at', { ascending: true })
    .limit(SWEEP_LIMIT) as { data: WaitRow[] | null; error: { message: string } | null }
  if (error) {
    result.errors.push(`mark query: ${error.message}`)
    return result
  }

  for (const row of rows ?? []) {
    result.scanned++
    try {
      // Cheap decision first (time only) — most marks are not due yet.
      const decision = decideWaitingReminder({ markedAt: row.marked_at, remindersSent: row.reminders_sent, lastReminderAt: row.last_reminder_at, now })
      if (!decision.send) { result.skipped++; continue }

      // Has the client written since the mark? Then they answered: nothing to remind (the chip already dropped it).
      const key = (row.account_id ?? row.contact_id) as string
      const { data: msgs, error: msgErr } = await supabaseAdmin
        .from('portal_messages')
        .select('created_at')
        .eq('sender_type', 'client')
        .is('deleted_at', null)
        .gte('created_at', row.marked_at)
        .eq(row.account_id ? 'account_id' : 'contact_id', key)
        .limit(1)
      if (msgErr) { result.errors.push(`mark ${row.id} messages: ${msgErr.message}`); continue }
      if (!isStillWaiting(row.marked_at, (msgs ?? []).map(m => m.created_at as string))) { result.skipped++; continue }

      // Test companies never get client mail; a company the portal hides (not Active/Suspended) cannot be reached by it.
      if (row.account_id) {
        const { data: acct } = await supabaseAdmin.from('accounts').select('status, is_test').eq('id', row.account_id).maybeSingle()
        if (acct?.is_test === true) { result.skipped++; continue }
        if (acct && acct.status !== 'Active' && acct.status !== 'Suspended') { result.unreachable++; continue }
      }

      const dispatch = await notifyClientActionRequired({
        account_id: row.account_id,
        contact_id: row.account_id ? null : row.contact_id,
        title: {
          en: 'You have a message waiting for your answer',
          it: 'Hai un messaggio in attesa di una tua risposta',
        },
        message: {
          en: 'Our team is waiting for your reply to their last message in your portal chat. Please take a moment to answer.',
          it: 'Il nostro team è in attesa della tua risposta al loro ultimo messaggio nella chat del portale. Ti chiediamo di rispondere appena puoi.',
        },
        link: buildPortalChatLink({ accountId: row.account_id }),
        ctaLabel: { en: 'Open your chat', it: 'Apri la chat' },
        // An ordinary chat-kind notice: the client can dismiss it, and the phone lock screen shows the fixed "New message" words.
        bellType: 'chat',
      })

      // `dispatched` is true even when every channel failed, so look at the channels themselves. A double-fire guard hit
      // (same notice within minutes) is a skip. If nothing at all went out, count it unreachable and leave the counters
      // alone so the next run tries again.
      const channelOk = (s: string) => s.startsWith('ok')
      if (![dispatch.chat, dispatch.notification, dispatch.email].some(channelOk)) {
        if (dispatch.chat.includes('duplicate')) result.skipped++
        else result.unreachable++
        continue
      }
      // The notice went into the portal (chat/bell) but no email left: the client may not see it until they open the portal.
      if (!channelOk(dispatch.email)) result.unreachable++

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { error: updErr } = await (supabaseAdmin as any)
        .from('portal_chat_waiting_threads')
        .update({ reminders_sent: row.reminders_sent + 1, last_reminder_at: now.toISOString() })
        .eq('id', row.id)
      if (updErr) result.errors.push(`mark ${row.id} bookkeeping: ${updErr.message}`)
      result.dispatched++
    } catch (e) {
      result.errors.push(`mark ${row.id}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }
  return result
}
