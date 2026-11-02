import { describe, it, expect } from 'vitest'
import {
  decideAutoCallDone,
  pickCallForRecording,
  undoOpen,
  undoHoursLeft,
  oldEventUriFromInvitee,
  MIN_AUTO_SECONDS,
  type AutoMoveInput,
  type LeadCallRow,
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
    leadCallCount: 1, leadCallDate: '2026-10-12', recordingIso: '2026-10-12T20:00:00Z', priorUndoneAutoMove: false, ...over,
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

describe('undo window and reschedule helpers', () => {
  const now = new Date('2026-11-01T12:00:00Z')
  it('undo is open until undo_until, and only if not undone', () => {
    expect(undoOpen({ undone_at: null, undo_until: '2026-11-01T16:00:00Z' }, now)).toBe(true)
    expect(undoOpen({ undone_at: null, undo_until: '2026-11-01T11:59:00Z' }, now)).toBe(false)
    expect(undoOpen({ undone_at: '2026-11-01T10:00:00Z', undo_until: '2026-11-01T16:00:00Z' }, now)).toBe(false)
    expect(undoOpen({ undone_at: null, undo_until: null }, now)).toBe(false)
  })
  it('hours left rounds up and is zero once closed', () => {
    expect(undoHoursLeft({ undone_at: null, undo_until: '2026-11-01T15:10:00Z' }, now)).toBe(4)
    expect(undoHoursLeft({ undone_at: null, undo_until: '2026-11-01T12:10:00Z' }, now)).toBe(1)
    expect(undoHoursLeft({ undone_at: null, undo_until: '2026-11-01T11:00:00Z' }, now)).toBe(0)
  })
  it('finds the old event of a reschedule from the old invitee uri', () => {
    expect(oldEventUriFromInvitee('https://api.calendly.com/scheduled_events/AAA/invitees/BBB')).toBe('https://api.calendly.com/scheduled_events/AAA')
    expect(oldEventUriFromInvitee(null)).toBeNull()
    expect(oldEventUriFromInvitee('not-a-uri')).toBeNull()
    expect(oldEventUriFromInvitee(42)).toBeNull()
  })
})
