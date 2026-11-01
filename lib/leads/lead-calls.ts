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
import { todayInNewYork } from '@/lib/leads/list-filters'
import { autoCallDoneEnabled } from '@/lib/leads/flags'

export type LeadCallState = 'scheduled' | 'done' | 'no_show' | 'moved' | 'cancelled'

export const MIN_AUTO_SECONDS = 180
export const UNDO_WINDOW_HOURS = 24
export const AUTO_REASON = 'auto_call_done'
export const STAFF_REASON = 'staff_confirmed_call'
export const DRY_RUN_REASON = 'dry_run_auto_call_done'

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
    // A call that was moved to another date is not matched: a recording near its OLD date is more likely another meeting.
    if (c.state !== 'scheduled') continue
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
  /** the automatic move made for THIS call was undone — a re-delivery of the same recording must not move it again */
  priorUndoneAutoMove: boolean
}

export interface AutoMoveDecision { move: boolean; reason: string }

export function decideAutoCallDone(i: AutoMoveInput): AutoMoveDecision {
  if (i.leadStatus !== 'Call Scheduled') return { move: false, reason: 'the lead is not on Call Scheduled' }
  if (i.existingClientTag) return { move: false, reason: 'the lead is an existing client' }
  if (i.priorUndoneAutoMove) return { move: false, reason: 'the automatic move for this call was undone' }
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
  // Before the migration has been run the tables do not exist: the window then falls back to recordings + call date.
  return { calls: calls.error ? [] : ((calls.data ?? []) as LeadCallRow[]), moves: moves.error ? [] : ((moves.data ?? []) as StatusMoveRow[]) }
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

export interface RecordingResult { ok: boolean; moved: boolean; reason: string; callId?: string; error?: string; dryRun?: boolean }

/** Put the lead back where it was after a failed log write, so a status never changes without its undo record. */
async function revertStatus(sb: Db, leadId: string, from: string, to: string): Promise<void> {
  await updateLeadColumnGuarded(sb as unknown as LeadDb, { leadId, column: 'status', newValue: from, expected: to, hasExpected: true })
}

/**
 * A recording was saved and linked to a lead: confirm its call, and move the lead to Call Done when the rules allow
 * AND the switch (LEAD_AUTO_CALL_DONE) is on. With the switch off the decision is only logged as a dry run.
 * Safe to run twice for the same recording (Circleback re-delivers): the call is found by its summary id and the
 * move decision is re-evaluated, so a move that failed the first time is retried and one already made is not repeated.
 */
export async function applyRecording(db: unknown, r: RecordingInput, opts: { now?: Date; autoMove?: boolean } = {}): Promise<RecordingResult> {
  const now = opts.now ?? new Date()
  const autoMove = opts.autoMove ?? autoCallDoneEnabled()
  try {
    const sb = asDb(db)
    const { data: lead } = await sb.from('leads').select('id, status, call_date, existing_client_contact_id').eq('id', r.leadId).maybeSingle()
    if (!lead) return { ok: false, moved: false, reason: 'lead not found' }

    const { data: callsData } = await sb.from('lead_calls').select('*').eq('lead_id', r.leadId)
    const calls = (callsData ?? []) as LeadCallRow[]

    let call = calls.find(c => c.call_summary_id === r.summaryId) ?? null
    let matched: LeadCallRow | null = call
    if (!call) {
      // A recording too short to count as the call (a test, a no-show that opened the room) must not close the booked call.
      const tooShort = r.durationSeconds !== null && r.durationSeconds < MIN_AUTO_SECONDS
      matched = tooShort ? null : pickCallForRecording(calls, r.recordingIso)
      if (matched) {
        const up = await sb.from('lead_calls')
          .update({ state: 'done', happened_at: r.recordingIso, call_summary_id: r.summaryId, confirmed_by: 'recording', updated_at: now.toISOString() })
          .eq('id', matched.id).is('call_summary_id', null).select('id')
        if (up.error) return { ok: false, moved: false, reason: 'could not update the call', error: up.error.message }
        if (up.data && up.data.length > 0) call = { ...matched, state: 'done', call_summary_id: r.summaryId }
        else matched = null // someone else claimed that call first: this recording gets a row of its own
      }
      if (!call) {
        const ins = await sb.from('lead_calls')
          .insert({ lead_id: r.leadId, state: 'done', happened_at: r.recordingIso, call_summary_id: r.summaryId, source: 'recording', confirmed_by: 'recording' })
          .select('*').single()
        if (ins.error) {
          // A parallel delivery may have just inserted it (unique index on the summary): read it back.
          const again = await sb.from('lead_calls').select('*').eq('call_summary_id', r.summaryId).maybeSingle()
          if (!again.data) return { ok: false, moved: false, reason: 'could not save the call', error: ins.error.message }
          call = again.data as LeadCallRow
        } else call = ins.data as LeadCallRow
      }
    }
    const callId = (call as LeadCallRow).id

    // Only a move made for THIS call that was undone blocks this call; a later call is judged on its own.
    const { data: undone } = await sb.from('lead_status_moves')
      .select('id').eq('lead_id', r.leadId).eq('reason', AUTO_REASON).eq('call_id', callId).not('undone_at', 'is', null).limit(1)

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

    if (!autoMove) {
      const { data: seen } = await sb.from('lead_status_moves').select('id').eq('lead_id', r.leadId).eq('call_id', callId).eq('reason', DRY_RUN_REASON).limit(1)
      if (!seen || seen.length === 0) {
        await sb.from('lead_status_moves').insert({ lead_id: r.leadId, from_status: 'Call Scheduled', to_status: 'Call Done', reason: DRY_RUN_REASON, source: 'circleback', call_id: callId })
      }
      return { ok: true, moved: false, dryRun: true, reason: 'the automatic move is switched off; logged only', callId }
    }

    const moved = await updateLeadColumnGuarded(sb as unknown as LeadDb, {
      leadId: r.leadId, column: 'status', newValue: 'Call Done', expected: 'Call Scheduled', hasExpected: true,
    })
    if (isGuardedFailure(moved)) return { ok: true, moved: false, reason: `the status changed meanwhile (${moved.reason})`, callId }

    const log = await sb.from('lead_status_moves').insert({
      lead_id: r.leadId, from_status: 'Call Scheduled', to_status: 'Call Done', reason: AUTO_REASON, source: 'circleback',
      call_id: callId, undo_until: new Date(now.getTime() + UNDO_WINDOW_HOURS * 3_600_000).toISOString(),
    })
    if (log.error) {
      await revertStatus(sb, r.leadId, 'Call Scheduled', 'Call Done')
      return { ok: false, moved: false, reason: 'could not log the move, so it was not made', error: log.error.message, callId }
    }
    return { ok: true, moved: true, reason: decision.reason, callId }
  } catch (err) {
    return { ok: false, moved: false, reason: 'unexpected error', error: err instanceof Error ? err.message : String(err) }
  }
}

export type ConfirmAction = 'happened' | 'no_show' | 'rebook'

export interface ConfirmResult { ok: boolean; status: number; message: string; moved?: boolean }

/** Staff answer "Did this call happen?" for a booked call with no recording. */
export async function confirmCall(db: unknown, args: { leadId: string; callId: string; action: ConfirmAction; actor: string }, now: Date = new Date()): Promise<ConfirmResult> {
  const sb = asDb(db)
  const { data: call } = await sb.from('lead_calls').select('*').eq('id', args.callId).eq('lead_id', args.leadId).maybeSingle()
  if (!call) return { ok: false, status: 404, message: 'Call not found for this lead.' }
  const row = call as LeadCallRow
  if (row.state !== 'scheduled') return { ok: false, status: 409, message: 'This call was already answered. Reload to see the latest.' }
  if (row.scheduled_date && daysBetween(todayInNewYork(now), row.scheduled_date) > 0) {
    return { ok: false, status: 409, message: 'This call is still in the future, so there is nothing to confirm yet.' }
  }

  const stamp = now.toISOString()
  if (args.action === 'no_show' || args.action === 'rebook') {
    const up = await sb.from('lead_calls')
      .update({ state: args.action === 'no_show' ? 'no_show' : 'moved', confirmed_by: args.actor, updated_at: stamp })
      .eq('id', row.id).eq('state', 'scheduled').select('id')
    if (up.error || !up.data?.length) return { ok: false, status: 409, message: 'This call changed meanwhile. Reload to see the latest.' }
    return { ok: true, status: 200, message: args.action === 'no_show' ? 'Marked as a no-show.' : 'Marked as moved. The new date arrives with its booking.' }
  }

  const up = await sb.from('lead_calls')
    .update({ state: 'done', happened_at: stamp, confirmed_by: args.actor, updated_at: stamp })
    .eq('id', row.id).eq('state', 'scheduled').select('id')
  if (up.error || !up.data?.length) return { ok: false, status: 409, message: 'This call changed meanwhile. Reload to see the latest.' }

  const { data: lead } = await sb.from('leads').select('status').eq('id', args.leadId).maybeSingle()
  if ((lead?.status as string | null) !== 'Call Scheduled') return { ok: true, status: 200, message: 'Marked as happened.', moved: false }
  const moved = await updateLeadColumnGuarded(sb as unknown as LeadDb, {
    leadId: args.leadId, column: 'status', newValue: 'Call Done', expected: 'Call Scheduled', hasExpected: true,
  })
  if (isGuardedFailure(moved)) return { ok: true, status: 200, message: 'Marked as happened. The lead status changed meanwhile, so it was left alone.', moved: false }
  const log = await sb.from('lead_status_moves').insert({
    lead_id: args.leadId, from_status: 'Call Scheduled', to_status: 'Call Done', reason: STAFF_REASON, source: args.actor, call_id: row.id,
  })
  if (log.error) {
    await revertStatus(sb, args.leadId, 'Call Scheduled', 'Call Done')
    // Re-open the call too, so the same answer can be given again instead of "already answered".
    await sb.from('lead_calls').update({ state: 'scheduled', happened_at: null, confirmed_by: null, updated_at: new Date().toISOString() }).eq('id', row.id).eq('state', 'done')
    return { ok: false, status: 500, message: 'The move could not be logged, so nothing was changed. Please try again.' }
  }
  return { ok: true, status: 200, message: 'Marked as happened. The lead moved to Call Done.', moved: true }
}

/** Undo an automatic move within its window; the lead goes back to where it was and this call is never moved automatically again. */
export async function undoMove(db: unknown, args: { leadId: string; moveId: string; actor: string }, now: Date = new Date()): Promise<ConfirmResult> {
  const sb = asDb(db)
  const { data } = await sb.from('lead_status_moves').select('*').eq('id', args.moveId).eq('lead_id', args.leadId).maybeSingle()
  if (!data) return { ok: false, status: 404, message: 'Move not found for this lead.' }
  const m = data as StatusMoveRow
  if (m.reason !== AUTO_REASON) return { ok: false, status: 400, message: 'Only an automatic move can be undone here.' }
  if (m.undone_at) return { ok: false, status: 409, message: 'This move was already undone.' }
  if (!undoOpen(m, now)) return { ok: false, status: 410, message: 'The 24-hour undo window has closed. Change the status by hand if needed.' }

  // Mark it undone FIRST (only if nobody did meanwhile): the stickiness marker must exist before the status changes back.
  const mark = await sb.from('lead_status_moves')
    .update({ undone_at: now.toISOString(), undone_by: args.actor }).eq('id', m.id).is('undone_at', null).select('id')
  if (mark.error || !mark.data?.length) return { ok: false, status: 409, message: 'This move was already undone.' }

  const back = await updateLeadColumnGuarded(sb as unknown as LeadDb, {
    leadId: args.leadId, column: 'status', newValue: m.from_status ?? 'Call Scheduled', expected: m.to_status, hasExpected: true,
  })
  if (isGuardedFailure(back)) {
    await sb.from('lead_status_moves').update({ undone_at: null, undone_by: null }).eq('id', m.id)
    return { ok: false, status: back.reason === 'conflict' ? 409 : 500, message: back.reason === 'conflict' ? 'The lead status changed since. Nothing was undone.' : back.message }
  }
  return { ok: true, status: 200, message: 'Undone. The lead is back on its earlier status and this call will not move it again.' }
}
