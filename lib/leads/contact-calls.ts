// Calls booked by someone who is ALREADY A CONTACT, through a made booking link whose kind says "attach" (Booking page, Stage 1a).
// lead_calls cannot hold them: its lead_id is NOT NULL and lead-only. contact_calls is a thin APPEND-ONLY LOG — one row per booked call, with a state
// (scheduled | moved | cancelled). Deliberately NO "done" state and NO recording matching: calls that really happened are already shown from call_summaries;
// the contact page lists a log row as a "Booked call" only while no call summary exists for that day, and the Zoom filing reads the log so a client call
// that overlaps a marketing window is not filed as marketing.
//
// Every function takes the service client as an argument, NEVER throws into a webhook or a page, and treats a missing table (the code is deployed before
// Antonio applies the migration on production) as "nothing here".

import { nyDate } from '@/lib/leads/ny-date'
import { oldEventUriFromInvitee } from '@/lib/leads/lead-calls'
import { isMissingTable, isUniqueViolation } from '@/lib/booking-links/missing-table'

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- contact_calls is not in the generated database types until the production migration is applied
type Db = any

export type ContactCallState = 'scheduled' | 'moved' | 'cancelled'

export interface ContactCallRow {
  id: string
  contact_id: string
  account_id: string | null
  booking_link_id: string | null
  booked_at: string | null
  scheduled_start: string | null
  scheduled_date: string | null
  calendly_event_uri: string | null
  event_type_name: string | null
  state: ContactCallState | string
  moved_to: string | null
}

export interface ContactBookingInput {
  contactId: string
  accountId?: string | null
  linkId?: string | null
  bookedAt: string
  scheduledStart: string | null
  eventUri: string | null
  eventTypeName: string | null
  /** on a reschedule: the invitee URI of the booking that was replaced */
  oldInvitee?: unknown
}

export interface ContactBookingResult { ok: boolean; callId?: string; created?: boolean; error?: string }

/** Mark the replaced booking as moved to the new one. Safe to repeat: only a call still 'scheduled' changes. */
async function markOldMoved(db: Db, oldInvitee: unknown, callId: string, nowIso: string): Promise<void> {
  const oldUri = oldEventUriFromInvitee(oldInvitee)
  if (!oldUri) return
  await db.from('contact_calls').update({ state: 'moved', moved_to: callId, updated_at: nowIso }).eq('calendly_event_uri', oldUri).eq('state', 'scheduled').neq('id', callId)
}

/** A booking by an existing contact arrived. Idempotent on the Calendly event URI (a re-delivery finds the row and only repeats the harmless "mark the old call moved"). */
export async function recordContactBooking(db: Db, b: ContactBookingInput): Promise<ContactBookingResult> {
  try {
    const nowIso = new Date().toISOString()
    if (b.eventUri) {
      const { data: existing, error: readErr } = await db.from('contact_calls').select('id').eq('calendly_event_uri', b.eventUri).maybeSingle()
      if (readErr) return { ok: false, error: isMissingTable(readErr) ? 'the contact_calls table does not exist' : String(readErr.message ?? 'read failed') }
      if (existing) {
        await markOldMoved(db, b.oldInvitee, existing.id as string, nowIso)
        return { ok: true, callId: existing.id as string, created: false }
      }
    }
    const row = {
      contact_id: b.contactId,
      account_id: b.accountId ?? null,
      booking_link_id: b.linkId ?? null,
      booked_at: b.bookedAt,
      scheduled_start: b.scheduledStart,
      scheduled_date: b.scheduledStart ? nyDate(b.scheduledStart) : null,
      calendly_event_uri: b.eventUri,
      event_type_name: b.eventTypeName,
      state: 'scheduled',
      source: 'calendly',
    }
    const ins = await db.from('contact_calls').insert(row).select('id').single()
    if (ins.error) {
      if (isUniqueViolation(ins.error) && b.eventUri) {
        // a parallel delivery of the same booking inserted it first: read it back
        const { data: again } = await db.from('contact_calls').select('id').eq('calendly_event_uri', b.eventUri).maybeSingle()
        if (again) {
          await markOldMoved(db, b.oldInvitee, again.id as string, nowIso)
          return { ok: true, callId: again.id as string, created: false }
        }
      }
      return { ok: false, error: isMissingTable(ins.error) ? 'the contact_calls table does not exist' : String(ins.error.message ?? 'insert failed') }
    }
    const callId = ins.data.id as string
    await markOldMoved(db, b.oldInvitee, callId, nowIso)
    return { ok: true, callId, created: true }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

const COLUMNS = 'id, contact_id, account_id, booking_link_id, booked_at, scheduled_start, scheduled_date, calendly_event_uri, event_type_name, state, moved_to'

/** The contact's logged calls, newest first. Missing table or any error = none (logged). */
export async function listContactCalls(db: Db, contactId: string, limit = 25): Promise<ContactCallRow[]> {
  try {
    const { data, error } = await db.from('contact_calls').select(COLUMNS).eq('contact_id', contactId).order('scheduled_start', { ascending: false }).limit(limit)
    if (error) {
      if (!isMissingTable(error)) console.error('[contact-calls] could not read the list:', error.message)
      return []
    }
    return (data ?? []) as ContactCallRow[]
  } catch (err) {
    console.error('[contact-calls] could not read the list:', err instanceof Error ? err.message : String(err))
    return []
  }
}

/** For the Zoom filing: logged, still-scheduled calls that start inside a time window, with the contact's name. Any error = none (a read error must never stop the filing). */
export async function listContactCallsInWindow(db: Db, fromIso: string, toIso: string): Promise<Array<{ start: string; who: string | null }>> {
  try {
    const { data, error } = await db.from('contact_calls').select('contact_id, scheduled_start').eq('state', 'scheduled').not('scheduled_start', 'is', null).gte('scheduled_start', fromIso).lte('scheduled_start', toIso)
    if (error) {
      if (!isMissingTable(error)) console.error('[contact-calls] could not read the window:', error.message)
      return []
    }
    const rows = (data ?? []) as Array<{ contact_id: string; scheduled_start: string }>
    const names = new Map<string, string>()
    const ids = Array.from(new Set(rows.map((r) => r.contact_id)))
    for (let i = 0; i < ids.length; i += 100) {
      const { data: people } = await db.from('contacts').select('id, full_name').in('id', ids.slice(i, i + 100))
      for (const p of (people ?? []) as Array<{ id: string; full_name: string | null }>) names.set(p.id, (p.full_name ?? '').trim())
    }
    return rows.map((r) => ({ start: r.scheduled_start, who: names.get(r.contact_id) || null }))
  } catch (err) {
    console.error('[contact-calls] could not read the window:', err instanceof Error ? err.message : String(err))
    return []
  }
}

/** Pure: which logged calls the contact page shows — those with no call summary on the same New York day (a summary means the call is already shown there). */
export function bookedCallsToShow(rows: readonly ContactCallRow[], summaryIsoDates: readonly string[]): ContactCallRow[] {
  const summaryDays = new Set(summaryIsoDates.map((iso) => nyDate(iso)))
  return rows.filter((r) => !(r.scheduled_date && summaryDays.has(r.scheduled_date)))
}

/** Pure: the short label next to a logged call. A past call still 'scheduled' is "Not confirmed", never "Scheduled": nothing tells us it happened. */
export function contactCallChip(row: Pick<ContactCallRow, 'state' | 'scheduled_date'>, todayNy: string): string {
  if (row.state === 'moved') return 'Moved'
  if (row.state === 'cancelled') return 'Cancelled'
  if (row.scheduled_date && row.scheduled_date < todayNy) return 'Not confirmed'
  return 'Scheduled'
}
