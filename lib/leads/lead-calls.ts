// Calls of a lead (dev job 6fc63c52, phase B): one row per call in lead_calls, the automatic move
// to Call Done when a recording arrives, and the staff actions that confirm or undo it.
//
// The RULES are pure and unit-tested (decideAutoCallDone, pickCallForRecording, ...). The functions
// that touch the database take the service client as an argument and never throw into a webhook:
// a failure here must never lose a booking or a recording.
//
// Safety rules, each one from a real way this could go wrong (counselor orientation, 2026-11-01):
//  - Only the exact status 'Call Scheduled' ever moves, and only to 'Call Done'. Never Converted (R094),
//    never backwards, never from Offer Sent / Negotiating.
//  - A lead tagged as an existing client is never moved: its recording may be a client call, not a sales call.
//  - The recording must land within one day (New York) of a call the lead actually booked. A rebooked lead's
//    old recording must not close the NEW call.
//  - A recording the matcher flagged for review (link_review) or a very short one (< 3 min) is recorded but
//    does not move the lead.
//  - Every automatic move is logged with a 24-hour undo; an UNDONE move stops that lead ever being moved
//    automatically again (re-delivered webhooks re-run this code).

import type { SupabaseClient } from '@supabase/supabase-js'
import { updateLeadColumnGuarded, isGuardedFailure, type LeadDb } from '@/lib/leads/guarded-update'
import { nyDate, daysBetween } from '@/lib/leads/ny-date'

export type LeadCallState = 'scheduled' | 'done' | 'no_show' | 'moved' | 'cancelled'

export const MIN_AUTO_SECONDS = 180
export const UNDO_WINDOW_HOURS = 24
export const AUTO_REASON = 'auto_call_done'
export const STAFF_REASON = 'staff_confirmed_call'

export interface LeadCallRow {
  id: string
  lead_id: string
  booked_at: string | null
  scheduled_start: string | null
  scheduled_date: string | null
  state: LeadCallState | string
  happened_at: string | null
  call_summary_id: string | null
  calendly_event_uri: string | null
  moved_to: string | null
  source: string
  confirmed_by: string | null
  created_at: string
}

export interface StatusMoveRow {
  id: string
  lead_id: string
  from_status: string | null
  to_status: string
  reason: string
  source: string | null
  call_id: string | null
  undo_until: string | null
  undone_at: string | null
  undone_by: string | null
  created_at: string
}

// ── pure rules ───────────────────────────────────────────────────────────

/** The booked call a recording belongs to: nearest planned date within a day (New York), still unconfirmed. */
export function pickCallForRecording(calls: LeadCallRow[], recordingIso: string): LeadCallRow | null {
  const rec = nyDate(recordingIso)
  let best: { c: LeadCallRow; d: number } | null = null
  for (const c of calls) {
    if (c.call_summary_id || !c.scheduled_date) continue
    if (c.state !== 'scheduled' && c.state !== 'moved') continue
    const d = Math.abs(daysBetween(c.scheduled_date, rec))
    if (d > 1) continue
    if (!best || d < best.d || (d === best.d && (c.scheduled_start ?? '') < (best.c.scheduled_start ?? ''))) best = { c, d }
  }
  return best ? best.c : null
}

export interface AutoMoveInput {
  leadStatus: string | null
  existingClientTag: boolean
  linkReview: string | null
  durationSeconds: number | null
  /** the booked call the recording matched, if any */
  matchedCall: LeadCallRow | null
  /** how many calls the lead already has on record (before this recording) */
  leadCallCount: number
  /** the lead's own latest call date, used only when it has no call rows at all */
  leadCallDate: string | null
  recordingIso: string
  /** an automatic move of this lead was undone before — never move it automatically again */
  priorUndoneAutoMove: boolean
}

export interface AutoMoveDecision { move: boolean; reason: string }

export function decideAutoCallDone(i: AutoMoveInput): AutoMoveDecision {
  if (i.leadStatus !== 'Call Scheduled') return { move: false, reason: 'the lead is not on Call Scheduled' }
  if (i.existingClientTag) return { move: false, reason: 'the lead is an existing client' }
  if (i.priorUndoneAutoMove) return { move: false, reason: 'an automatic move was undone before' }
  if (i.linkReview) return { move: false, reason: 'the recording is waiting for a link review' }
  if (i.durationSeconds !== null && i.durationSeconds < MIN_AUTO_SECONDS) return { move: false, reason: 'the recording is shorter than 3 minutes' }
  if (i.matchedCall) return { move: true, reason: 'a recording came back within a day of the booked call' }
  // No booked call matched. Only a lead with NO call rows at all may fall back to its own call date.
  if (i.leadCallCount === 0 && i.leadCallDate && Math.abs(daysBetween(i.leadCallDate.slice(0, 10), nyDate(i.recordingIso))) <= 1) {
    return { move: true, reason: 'a recording came back within a day of the lead call date' }
  }
  return { move: false, reason: 'the recording does not match a booked call date' }
}

export function undoOpen(move: Pick<StatusMoveRow, 'undone_at' | 'undo_until'>, now: Date = new Date()): boolean {
  return !move.undone_at && !!move.undo_until && new Date(move.undo_until).getTime() > now.getTime()
}

/** Hours left on an open undo window, rounded up, for the label ("4 hours left"). */
export function undoHoursLeft(move: Pick<StatusMoveRow, 'undone_at' | 'undo_until'>, now: Date = new Date()): number {
  if (!undoOpen(move, now)) return 0
  return Math.max(1, Math.ceil((new Date(move.undo_until as string).getTime() - now.getTime()) / 3_600_000))
}

/** Calendly names the old booking of a reschedule as an invitee URI; its event is the part before /invitees/. */
export function oldEventUriFromInvitee(oldInvitee: unknown): string | null {
  if (typeof oldInvitee !== 'string' || !oldInvitee) return null
  const i = oldInvitee.indexOf('/invitees/')
  return i > 0 ? oldInvitee.slice(0, i) : null
}

// ── database actions (service client) ────────────────────────────────────

type Db = SupabaseClient
const asDb = (db: unknown) => db as Db

/** The lead's call records and status moves, for the window (new tables: read through the untyped client). */
export async function fetchLeadCallData(db: unknown, leadId: string): Promise<{ calls: LeadCallRow[]; moves: StatusMoveRow[] }> {
  const sb = asDb(db)
  const [calls, moves] = await Promise.all([
    sb.from('lead_calls').select('*').eq('lead_id', leadId),
    sb.from('lead_status_moves').select('*').eq('lead_id', leadId).order('created_at', { ascending: true }),
  ])
  return { calls: (calls.data ?? []) as LeadCallRow[], moves: (moves.data ?? []) as StatusMoveRow[] }
}

export interface BookingInput {
  leadId: string
  bookedAt: string
  scheduledStart: string | null
  eventUri: string | null
  oldInvitee?: unknown
}

/** A booking arrived (Calendly invitee.created). Idempotent on the event URI; a reschedule marks the old call moved. */
export async function recordBooking(db: unknown, b: BookingInput): Promise<{ ok: boolean; callId?: string; error?: string }> {
  try {
    const sb = asDb(db)
    const start = b.scheduledStart
    const row = {
      lead_id: b.leadId,
      booked_at: b.bookedAt,
      scheduled_start: start,
      scheduled_date: start ? nyDate(start) : null,
      state: 'scheduled',
      source: 'calendly',
      calendly_event_uri: b.eventUri,
    }
    if (b.eventUri) {
      const { data: existing } = await sb.from('lead_calls').select('id').eq('calendly_event_uri', b.eventUri).maybeSingle()
      if (existing) return { ok: true, callId: existing.id as string }
    }
    const ins = await sb.from('lead_calls').insert(row).select('id').single()
    if (ins.error) return { ok: false, error: ins.error.message }
    const callId = ins.data.id as string
    const oldUri = oldEventUriFromInvitee(b.oldInvitee)
    if (oldUri) {
      await sb.from('lead_calls')
        .update({ state: 'moved', moved_to: callId, updated_at: new Date().toISOString() })
        .eq('calendly_event_uri', oldUri).eq('state', 'scheduled')
    }
    return { ok: true, callId }
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) }
  }
}

export interface RecordingInput {
  leadId: string
  summaryId: string
  recordingIso: string
  durationSeconds: number | null
  linkReview: string | null
}

export interface RecordingResult { ok: boolean; moved: boolean; reason: string; callId?: string; error?: string }

/** A recording was saved and linked to a lead: confirm its call, and move the lead to Call Done when the rules allow. */
export async function applyRecording(db: unknown, r: RecordingInput, now: Date = new Date()): Promise<RecordingResult> {
  try {
    const sb = asDb(db)
    const { data: lead } = await sb.from('leads').select('id, status, call_date, existing_client_contact_id').eq('id', r.leadId).maybeSingle()
    if (!lead) return { ok: false, moved: false, reason: 'lead not found' }

    // Already confirmed for this recording (re-delivery)? Nothing to do twice.
    const { data: already } = await sb.from('lead_calls').select('id').eq('call_summary_id', r.summaryId).maybeSingle()
    if (already) return { ok: true, moved: false, reason: 'already recorded', callId: already.id as string }

    const { data: callsData } = await sb.from('lead_calls').select('*').eq('lead_id', r.leadId)
    const calls = (callsData ?? []) as LeadCallRow[]
    const matched = pickCallForRecording(calls, r.recordingIso)

    let callId: string
    if (matched) {
      const up = await sb.from('lead_calls')
        .update({ state: 'done', happened_at: r.recordingIso, call_summary_id: r.summaryId, confirmed_by: 'recording', updated_at: now.toISOString() })
        .eq('id', matched.id).is('call_summary_id', null).select('id')
      if (up.error) return { ok: false, moved: false, reason: 'could not update the call', error: up.error.message }
      callId = matched.id
    } else {
      const ins = await sb.from('lead_calls')
        .insert({ lead_id: r.leadId, state: 'done', happened_at: r.recordingIso, call_summary_id: r.summaryId, source: 'recording', confirmed_by: 'recording' })
        .select('id').single()
      if (ins.error) return { ok: false, moved: false, reason: 'could not save the call', error: ins.error.message }
      callId = ins.data.id as string
    }

    const { data: undone } = await sb.from('lead_status_moves')
      .select('id').eq('lead_id', r.leadId).eq('reason', AUTO_REASON).not('undone_at', 'is', null).limit(1)

    const decision = decideAutoCallDone({
      leadStatus: (lead.status as string | null) ?? null,
      existingClientTag: !!lead.existing_client_contact_id,
      linkReview: r.linkReview,
      durationSeconds: r.durationSeconds,
      matchedCall: matched,
      leadCallCount: calls.length,
      leadCallDate: (lead.call_date as string | null) ?? null,
      recordingIso: r.recordingIso,
      priorUndoneAutoMove: (undone ?? []).length > 0,
    })
    if (!decision.move) return { ok: true, moved: false, reason: decision.reason, callId }

    const moved = await updateLeadColumnGuarded(sb as unknown as LeadDb, {
      leadId: r.leadId, column: 'status', newValue: 'Call Done', expected: 'Call Scheduled', hasExpected: true,
    })
    if (isGuardedFailure(moved)) return { ok: true, moved: false, reason: `the status changed meanwhile (${moved.reason})`, callId }

    await sb.from('lead_status_moves').insert({
      lead_id: r.leadId, from_status: 'Call Scheduled', to_status: 'Call Done', reason: AUTO_REASON, source: 'circleback',
      call_id: callId, undo_until: new Date(now.getTime() + UNDO_WINDOW_HOURS * 3_600_000).toISOString(),
    })
    return { ok: true, moved: true, reason: decision.reason, callId }
  } catch (err) {
    return { ok: false, moved: false, reason: 'unexpected error', error: err instanceof Error ? err.message : String(err) }
  }
}

export type ConfirmAction = 'happened' | 'no_show' | 'rebook'

export interface ConfirmResult { ok: boolean; status: number; message: string; moved?: boolean }

/** Staff answer "Did this call happen?" for a booked call with no recording. */
export async function confirmCall(db: unknown, args: { leadId: string; callId: string; action: ConfirmAction; actor: string }): Promise<ConfirmResult> {
  const sb = asDb(db)
  const { data: call } = await sb.from('lead_calls').select('*').eq('id', args.callId).eq('lead_id', args.leadId).maybeSingle()
  if (!call) return { ok: false, status: 404, message: 'Call not found for this lead.' }
  const row = call as LeadCallRow
  if (row.state !== 'scheduled') return { ok: false, status: 409, message: 'This call was already answered. Reload to see the latest.' }

  const now = new Date().toISOString()
  if (args.action === 'no_show' || args.action === 'rebook') {
    const up = await sb.from('lead_calls')
      .update({ state: args.action === 'no_show' ? 'no_show' : 'moved', confirmed_by: args.actor, updated_at: now })
      .eq('id', row.id).eq('state', 'scheduled').select('id')
    if (up.error || !up.data?.length) return { ok: false, status: 409, message: 'This call changed meanwhile. Reload to see the latest.' }
    return { ok: true, status: 200, message: args.action === 'no_show' ? 'Marked as a no-show.' : 'Marked as moved. The new date arrives with its booking.' }
  }

  const up = await sb.from('lead_calls')
    .update({ state: 'done', happened_at: now, confirmed_by: args.actor, updated_at: now })
    .eq('id', row.id).eq('state', 'scheduled').select('id')
  if (up.error || !up.data?.length) return { ok: false, status: 409, message: 'This call changed meanwhile. Reload to see the latest.' }

  const { data: lead } = await sb.from('leads').select('status').eq('id', args.leadId).maybeSingle()
  if ((lead?.status as string | null) !== 'Call Scheduled') return { ok: true, status: 200, message: 'Marked as happened.', moved: false }
  const moved = await updateLeadColumnGuarded(sb as unknown as LeadDb, {
    leadId: args.leadId, column: 'status', newValue: 'Call Done', expected: 'Call Scheduled', hasExpected: true,
  })
  if (isGuardedFailure(moved)) return { ok: true, status: 200, message: 'Marked as happened. The lead status changed meanwhile, so it was left alone.', moved: false }
  await sb.from('lead_status_moves').insert({
    lead_id: args.leadId, from_status: 'Call Scheduled', to_status: 'Call Done', reason: STAFF_REASON, source: args.actor, call_id: row.id,
  })
  return { ok: true, status: 200, message: 'Marked as happened. The lead moved to Call Done.', moved: true }
}

/** Undo an automatic move within its window; the lead goes back to where it was and is never moved automatically again. */
export async function undoMove(db: unknown, args: { leadId: string; moveId: string; actor: string }, now: Date = new Date()): Promise<ConfirmResult> {
  const sb = asDb(db)
  const { data } = await sb.from('lead_status_moves').select('*').eq('id', args.moveId).eq('lead_id', args.leadId).maybeSingle()
  if (!data) return { ok: false, status: 404, message: 'Move not found for this lead.' }
  const m = data as StatusMoveRow
  if (m.reason !== AUTO_REASON) return { ok: false, status: 400, message: 'Only an automatic move can be undone here.' }
  if (m.undone_at) return { ok: false, status: 409, message: 'This move was already undone.' }
  if (!undoOpen(m, now)) return { ok: false, status: 410, message: 'The 24-hour undo window has closed. Change the status by hand if needed.' }
  const back = await updateLeadColumnGuarded(sb as unknown as LeadDb, {
    leadId: args.leadId, column: 'status', newValue: m.from_status ?? 'Call Scheduled', expected: m.to_status, hasExpected: true,
  })
  if (isGuardedFailure(back)) {
    return { ok: false, status: back.reason === 'conflict' ? 409 : 500, message: back.reason === 'conflict' ? 'The lead status changed since. Nothing was undone.' : back.message }
  }
  await sb.from('lead_status_moves').update({ undone_at: now.toISOString(), undone_by: args.actor }).eq('id', m.id)
  return { ok: true, status: 200, message: 'Undone. The lead is back on its earlier status and will not move automatically again.' }
}
