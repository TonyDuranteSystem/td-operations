import { describe, it, expect } from 'vitest'
import {
  decideAutoCallDone,
  pickCallForRecording,
  undoAvailable,
  oldEventUriFromInvitee,
  MIN_AUTO_SECONDS,
  type AutoMoveInput,
  type LeadCallRow,
  type StatusMoveRow,
} from '@/lib/leads/lead-calls'

function call(over: Partial<LeadCallRow> = {}): LeadCallRow {
  return {
    id: 'c1', lead_id: 'l1', booked_at: '2026-10-02T10:00:00Z', scheduled_start: '2026-10-12T19:00:00Z', scheduled_date: '2026-10-12',
    state: 'scheduled', happened_at: null, call_summary_id: null, calendly_event_uri: 'ev1', moved_to: null, source: 'calendly',
    confirmed_by: null, created_at: '2026-10-02T10:00:00Z', ...over,
  }
}

function input(over: Partial<AutoMoveInput> = {}): AutoMoveInput {
  return {
    leadStatus: 'Call Scheduled', existingClientTag: false, linkReview: null, durationSeconds: 2400, matchedCall: call(),
    leadCallCount: 1, leadCallDate: '2026-10-12', recordingIso: '2026-10-12T20:00:00Z', priorUndoneAutoMove: false,
    substance: { enough: true, voices: [], reason: 'Pierre L and the team both spoke at length.' }, ...over,
  }
}

describe('pickCallForRecording', () => {
  it('picks the booked call within a day of the recording', () => {
    expect(pickCallForRecording([call()], '2026-10-12T20:00:00Z')?.id).toBe('c1')
    expect(pickCallForRecording([call()], '2026-10-13T03:00:00Z')?.id).toBe('c1') // still Oct 12 in New York... or the next day: both within 1
  })
  it('does not pick a call more than a day away (a rebooked lead keeps its new call open)', () => {
    expect(pickCallForRecording([call({ scheduled_date: '2026-11-04' })], '2026-10-12T20:00:00Z')).toBeNull()
  })
  it('skips calls that already have a recording or are not open', () => {
    expect(pickCallForRecording([call({ call_summary_id: 's1' })], '2026-10-12T20:00:00Z')).toBeNull()
    expect(pickCallForRecording([call({ state: 'no_show' })], '2026-10-12T20:00:00Z')).toBeNull()
    expect(pickCallForRecording([call({ state: 'done' })], '2026-10-12T20:00:00Z')).toBeNull()
  })
  it('never matches a call that was moved to another date (a recording near its old date is another meeting)', () => {
    expect(pickCallForRecording([call({ state: 'moved' })], '2026-10-12T20:00:00Z')).toBeNull()
  })
  it('prefers the nearest date, then the earlier start', () => {
    const a = call({ id: 'a', scheduled_date: '2026-10-11', scheduled_start: '2026-10-11T19:00:00Z' })
    const b = call({ id: 'b', scheduled_date: '2026-10-12', scheduled_start: '2026-10-12T19:00:00Z' })
    expect(pickCallForRecording([a, b], '2026-10-12T20:00:00Z')?.id).toBe('b')
  })
  it('ignores a call with no planned date', () => {
    expect(pickCallForRecording([call({ scheduled_date: null })], '2026-10-12T20:00:00Z')).toBeNull()
  })
})

describe('decideAutoCallDone', () => {
  it('moves a Call Scheduled lead when a recording matches a booked call', () => {
    expect(decideAutoCallDone(input())).toMatchObject({ move: true })
  })
  it('only the exact status Call Scheduled moves', () => {
    for (const s of ['New', 'Call Done', 'Offer Sent', 'Negotiating', 'Converted', 'Lost', 'Suspended', null]) {
      expect(decideAutoCallDone(input({ leadStatus: s })).move).toBe(false)
    }
  })
  it('never moves an existing client', () => {
    expect(decideAutoCallDone(input({ existingClientTag: true })).move).toBe(false)
  })
  it('waits while the question "already a client?" is open', () => {
    const d = decideAutoCallDone(input({ clientQuestionOpen: true }))
    expect(d.move).toBe(false)
    expect(d.reason).toMatch(/already a client/)
    expect(decideAutoCallDone(input({ clientQuestionOpen: false })).move).toBe(true)
  })
  it('never moves again after an undone automatic move', () => {
    expect(decideAutoCallDone(input({ priorUndoneAutoMove: true })).move).toBe(false)
  })
  it('does not move a recording waiting for review or a very short one', () => {
    expect(decideAutoCallDone(input({ linkReview: 'ambiguous match' })).move).toBe(false)
    expect(decideAutoCallDone(input({ durationSeconds: MIN_AUTO_SECONDS - 1 })).move).toBe(false)
    expect(decideAutoCallDone(input({ durationSeconds: MIN_AUTO_SECONDS })).move).toBe(true)
  })
  it('an unknown duration does not block the move', () => {
    expect(decideAutoCallDone(input({ durationSeconds: null })).move).toBe(true)
  })
  it('a recording with no real conversation does not move the lead, and says why', () => {
    const d = decideAutoCallDone(input({ substance: { enough: false, voices: [], reason: 'Only one voice said anything substantial on this recording.' } }))
    expect(d.move).toBe(false)
    expect(d.reason).toMatch(/Only one voice/)
  })
  it('a recording that cannot be judged (no transcript) does not move the lead', () => {
    expect(decideAutoCallDone(input({ substance: null })).move).toBe(false)
  })
  it('the length alone never moves a lead any more', () => {
    expect(decideAutoCallDone(input({ durationSeconds: 5000, substance: { enough: false, voices: [], reason: 'x' } })).move).toBe(false)
  })
  it('a call a person already answered is not overruled by a later copy of the recording', () => {
    expect(decideAutoCallDone(input({ staffAnswered: true })).move).toBe(false)
  })
  it('the move reason tells what happened in plain words', () => {
    expect(decideAutoCallDone(input()).reason).toMatch(/A real conversation took place/)
  })
  it('no matched call: only a lead with NO call rows may fall back to its call date', () => {
    expect(decideAutoCallDone(input({ matchedCall: null, leadCallCount: 0, leadCallDate: '2026-10-12' })).move).toBe(true)
    expect(decideAutoCallDone(input({ matchedCall: null, leadCallCount: 0, leadCallDate: '2026-11-04' })).move).toBe(false)
    expect(decideAutoCallDone(input({ matchedCall: null, leadCallCount: 2, leadCallDate: '2026-10-12' })).move).toBe(false)
    expect(decideAutoCallDone(input({ matchedCall: null, leadCallCount: 0, leadCallDate: null })).move).toBe(false)
  })
  it('a recording of an OLD call does not close a rebooked call (no match, lead has rows)', () => {
    const d = decideAutoCallDone(input({ matchedCall: null, leadCallCount: 2, leadCallDate: '2026-11-04', recordingIso: '2026-10-12T20:00:00Z' }))
    expect(d.move).toBe(false)
  })
})

describe('undo (no clock) and reschedule helpers', () => {
  const mv = (over: Partial<StatusMoveRow> = {}): StatusMoveRow => ({
    id: 'm1', lead_id: 'l1', from_status: 'Call Scheduled', to_status: 'Call Done', reason: 'auto_call_done', source: 'circleback', call_id: 'c1',
    undo_until: null, undone_at: null, undone_by: null, created_at: '2026-10-12T20:05:00Z', ...over,
  })
  it('undo is open while the lead is still where the system put it, however long ago', () => {
    expect(undoAvailable(mv({ created_at: '2025-01-01T00:00:00Z' }), 'Call Done', [mv({ created_at: '2025-01-01T00:00:00Z' })])).toBe(true)
  })
  it('not once undone, not for a staff move, not when the lead is somewhere else', () => {
    expect(undoAvailable(mv({ undone_at: '2026-10-13T00:00:00Z' }), 'Call Done', [])).toBe(false)
    expect(undoAvailable(mv({ reason: 'staff_confirmed_call' }), 'Call Done', [])).toBe(false)
    expect(undoAvailable(mv(), 'Offer Sent', [])).toBe(false)
  })
  it('a later move of any kind closes the older undo (hand-confirmed Call Done after a rebook)', () => {
    const a = mv()
    const later = mv({ id: 'm2', reason: 'staff_confirmed_call', created_at: '2026-10-20T10:00:00Z' })
    expect(undoAvailable(a, 'Call Done', [a, later])).toBe(false)
    expect(undoAvailable(later, 'Call Done', [a, later])).toBe(false) // staff move itself is never undoable here
  })
  it('a dry-run record or an undone later move does not close it', () => {
    const a = mv()
    const dry = mv({ id: 'd', reason: 'dry_run_auto_call_done', created_at: '2026-10-21T10:00:00Z' })
    const undoneLater = mv({ id: 'u', created_at: '2026-10-22T10:00:00Z', undone_at: '2026-10-22T11:00:00Z' })
    expect(undoAvailable(a, 'Call Done', [a, dry, undoneLater])).toBe(true)
  })
  it('finds the old event of a reschedule from the old invitee uri', () => {
    expect(oldEventUriFromInvitee('https://api.calendly.com/scheduled_events/AAA/invitees/BBB')).toBe('https://api.calendly.com/scheduled_events/AAA')
    expect(oldEventUriFromInvitee(null)).toBeNull()
    expect(oldEventUriFromInvitee('not-a-uri')).toBeNull()
    expect(oldEventUriFromInvitee(42)).toBeNull()
  })
})
