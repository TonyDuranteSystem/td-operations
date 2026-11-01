import { describe, it, expect } from 'vitest'
import {
  buildCalls,
  buildLeadWindowData,
  nextActionText,
  offerSummary,
  currentOffer,
  parseTranscript,
  clipSummary,
  stageIndexFor,
  fmtYmd,
  buildCallsFromRows,
  daysBetween,
  type WindowCallRow,
  type WindowInput,
  type WindowOfferRow,
} from '@/lib/leads/window-data'
import type { LeadCallRow, StatusMoveRow } from '@/lib/leads/lead-calls'

const NOW = new Date('2026-11-01T15:00:00Z') // 2026-11-01 in New York

function rec(id: string, createdAt: string, over: Partial<WindowCallRow> = {}): WindowCallRow {
  return { id, meeting_name: 'Call', duration_seconds: 2460, notes: 'Wants a **Wyoming** LLC.', recording_url: 'https://rec/' + id, created_at: createdAt, ...over }
}
function offer(over: Partial<WindowOfferRow> = {}): WindowOfferRow {
  return { token: 't1', status: 'sent', version: 1, created_at: '2026-10-13T12:00:00Z', viewed_at: null, view_count: null, superseded_by: null, ...over }
}

describe('buildCalls', () => {
  it('numbers recordings oldest first and marks them Done', () => {
    const c = buildCalls({
      leadCallDate: null,
      recordings: [rec('b', '2026-10-20T15:00:00Z'), rec('a', '2026-10-12T19:00:00Z')],
      transcriptCallIds: ['a'],
      now: NOW,
    })
    expect(c.map(x => [x.title, x.state, x.callId])).toEqual([['Call 1', 'done', 'a'], ['Call 2', 'done', 'b']])
    expect(c[0].hasTranscript).toBe(true)
    expect(c[1].hasTranscript).toBe(false)
    expect(c[0].durationMin).toBe(41)
  })

  it('a recording within a day of the lead call date covers it (no extra call)', () => {
    const c = buildCalls({ leadCallDate: '2026-10-12', recordings: [rec('a', '2026-10-12T19:00:00Z')], transcriptCallIds: [], now: NOW })
    expect(c).toHaveLength(1)
    expect(c[0].scheduledFor).toBe('2026-10-12')
  })

  it('a passed call date with no recording is Not confirmed', () => {
    const c = buildCalls({ leadCallDate: '2026-10-28', recordings: [], transcriptCallIds: [], now: NOW })
    expect(c).toHaveLength(1)
    expect(c[0]).toMatchObject({ state: 'not_confirmed', chip: 'Not confirmed', title: 'Call 1' })
  })

  it('a rebooked lead: old recording stays Done, the new date is a Scheduled call 2', () => {
    const c = buildCalls({ leadCallDate: '2026-11-04', recordings: [rec('a', '2026-10-12T19:00:00Z')], transcriptCallIds: [], now: NOW })
    expect(c.map(x => [x.title, x.state])).toEqual([['Call 1', 'done'], ['Call 2', 'scheduled']])
    expect(c[1].chip).toBe('Scheduled, in 3 days')
  })

  it('today is Due today, tomorrow is "in 1 day"', () => {
    expect(buildCalls({ leadCallDate: '2026-11-01', recordings: [], transcriptCallIds: [], now: NOW })[0].state).toBe('due_today')
    expect(buildCalls({ leadCallDate: '2026-11-02', recordings: [], transcriptCallIds: [], now: NOW })[0].chip).toBe('Scheduled, in 1 day')
  })

  it('no recordings and no date gives no calls', () => {
    expect(buildCalls({ leadCallDate: null, recordings: [], transcriptCallIds: [], now: NOW })).toEqual([])
  })

  it('uses the New York date for a late-evening recording', () => {
    // 02:00 UTC on Oct 13 is still Oct 12 in New York
    const c = buildCalls({ leadCallDate: '2026-10-12', recordings: [rec('a', '2026-10-13T02:00:00Z')], transcriptCallIds: [], now: NOW })
    expect(c).toHaveLength(1)
  })
})

describe('nextActionText', () => {
  const none = [] as ReturnType<typeof buildCalls>
  it('terminal statuses', () => {
    expect(nextActionText({ status: 'Converted', offer: null, calls: none, now: NOW })).toMatch(/Converted/)
    expect(nextActionText({ status: 'Lost', offer: null, calls: none, now: NOW })).toBe('Marked lost.')
    expect(nextActionText({ status: 'Suspended', offer: null, calls: none, now: NOW })).toBe('On hold.')
  })
  it('signed offer waits for payment', () => {
    expect(nextActionText({ status: 'Offer Sent', offer: offer({ status: 'signed' }), calls: none, now: NOW })).toMatch(/Waiting for the payment/)
  })
  it('sent offer counts the quiet days from the last view', () => {
    const t = nextActionText({ status: 'Offer Sent', offer: offer({ status: 'viewed', viewed_at: '2026-10-24T12:00:00Z', view_count: 3 }), calls: none, now: NOW })
    expect(t).toBe('Offer viewed 3 times. No change for 8 days. Follow up.')
  })
  it('an unopened offer says so', () => {
    expect(nextActionText({ status: 'Offer Sent', offer: offer(), calls: none, now: NOW })).toMatch(/not opened yet/)
  })
  it('call date passed with no recording', () => {
    const calls = buildCalls({ leadCallDate: '2026-10-28', recordings: [], transcriptCallIds: [], now: NOW })
    expect(nextActionText({ status: 'Call Scheduled', offer: null, calls, now: NOW })).toMatch(/no recording came back/)
  })
  it('recording back but status still Call Scheduled', () => {
    const calls = buildCalls({ leadCallDate: null, recordings: [rec('a', '2026-10-30T15:00:00Z')], transcriptCallIds: [], now: NOW })
    expect(nextActionText({ status: 'Call Scheduled', offer: null, calls, now: NOW })).toMatch(/status still says Call Scheduled/)
  })
  it('Call Done without an offer', () => {
    expect(nextActionText({ status: 'Call Done', offer: null, calls: none, now: NOW })).toMatch(/Create the offer/)
  })
  it('an upcoming call', () => {
    const calls = buildCalls({ leadCallDate: '2026-11-04', recordings: [], transcriptCallIds: [], now: NOW })
    expect(nextActionText({ status: 'Call Scheduled', offer: null, calls, now: NOW })).toBe('Call planned for 4 Nov 2026.')
  })
})

describe('offer helpers', () => {
  it('picks the newest version that is not superseded', () => {
    const cur = currentOffer([offer({ token: 'a', version: 1, status: 'superseded' }), offer({ token: 'b', version: 2 }), offer({ token: 'c', version: 3, status: 'superseded' })])
    expect(cur?.token).toBe('b')
  })
  it('falls back to the newest when all are superseded; null when none', () => {
    expect(currentOffer([offer({ token: 'a', version: 1, status: 'superseded' }), offer({ token: 'b', version: 2, status: 'superseded' })])?.token).toBe('b')
    expect(currentOffer([])).toBeNull()
  })
  it('summarises views', () => {
    expect(offerSummary(offer({ status: 'viewed', viewed_at: '2026-10-24T12:00:00Z', view_count: 3 }))).toEqual({ line: 'Viewed, created 13 Oct 2026', sub: 'Viewed 3 times, last on 24 Oct 2026' })
    expect(offerSummary(offer())?.sub).toBe('Not opened yet')
    expect(offerSummary(null)).toBeNull()
  })
})

describe('transcript and text helpers', () => {
  it('parses the saved array, formats mm:ss, skips blanks', () => {
    const lines = parseTranscript([{ timestamp: 62, speaker: 'Luca', text: ' Hello ' }, { timestamp: 70, speaker: 'X', text: '  ' }, null, 5])
    expect(lines).toEqual([{ time: '01:02', speaker: 'Luca', text: 'Hello' }])
  })
  it('accepts the one plain-text row and ignores junk', () => {
    expect(parseTranscript('just text')).toEqual([{ time: '', speaker: '', text: 'just text' }])
    expect(parseTranscript('   ')).toEqual([])
    expect(parseTranscript({ a: 1 })).toEqual([])
    expect(parseTranscript(null)).toEqual([])
  })
  it('caps the number of lines', () => {
    const big = Array.from({ length: 50 }, (_, i) => ({ timestamp: i, speaker: 's', text: 'x' + i }))
    expect(parseTranscript(big, 10)).toHaveLength(10)
  })
  it('clips and cleans a summary', () => {
    expect(clipSummary('## Title\n**bold** text')).toBe('Title bold text')
    expect(clipSummary(null)).toBeNull()
    expect(clipSummary('a'.repeat(500), 10)).toBe('a'.repeat(10) + '…')
  })
  it('formats a date the way the window shows it', () => {
    expect(fmtYmd('2026-11-04')).toBe('4 Nov 2026')
    expect(fmtYmd('2026-10-13T12:00:00Z')).toBe('13 Oct 2026')
    expect(fmtYmd('nonsense')).toBe('nonsense')
  })
  it('stage index and day maths', () => {
    expect(stageIndexFor('Call Done')).toBe(2)
    expect(stageIndexFor('Qualified')).toBe(0)
    expect(stageIndexFor('Lost')).toBe(-1)
    expect(daysBetween('2026-10-24', '2026-11-01')).toBe(8)
  })
})

describe('buildLeadWindowData', () => {
  const lead: WindowInput['lead'] = {
    id: 'l1', full_name: 'Sofia Marchetti', email: 's@example.com', phone: '+39 1', language: 'Italian', source: 'Calendly', referrer_name: 'Guido',
    status: 'Offer Sent', call_date: '2026-11-04', notes: ' prefers two payments ', created_at: '2026-10-02T10:00:00Z', updated_at: '2026-10-24T10:00:00Z',
    existing_client_contact_id: null, converted_to_contact_id: null,
  }
  const base: WindowInput = {
    lead, offers: [offer({ status: 'viewed', viewed_at: '2026-10-24T12:00:00Z', view_count: 3 })],
    calls: [rec('a', '2026-10-12T19:00:00Z')], transcriptCallIds: ['a'], emails: [], contracts: [], activation: null, isLiveClient: false, now: NOW,
  }

  it('assembles header, calls, offer, notes and a newest-first story', () => {
    const d = buildLeadWindowData(base)
    expect(d.lead.stageIndex).toBe(3)
    expect(d.calls.map(c => c.title)).toEqual(['Call 1', 'Call 2'])
    expect(d.offer?.line).toBe('Viewed, created 13 Oct 2026')
    expect(d.notes).toBe('prefers two payments')
    const dates = d.story.map(e => e.date)
    expect([...dates].sort().reverse()).toEqual(dates)
    expect(d.story.find(e => e.title === 'Call 1 recorded')?.group).toBe('calls')
    expect(d.story.find(e => e.type === 'offer_viewed')?.group).toBe('offer')
    expect(d.story.find(e => e.type === 'lead_created')?.group).toBe('other')
  })

  it('does not invent a call from the call date alone', () => {
    const d = buildLeadWindowData({ ...base, calls: [] })
    expect(d.story.some(e => e.type === 'call_completed')).toBe(false)
  })

  it('badges: tagged beats live match; Converted never gets Already a client', () => {
    expect(buildLeadWindowData({ ...base, lead: { ...lead, existing_client_contact_id: 'c1' }, isLiveClient: true }).lead.badges).toEqual(['Existing client'])
    expect(buildLeadWindowData({ ...base, isLiveClient: true }).lead.badges).toEqual(['Already a client'])
    expect(buildLeadWindowData({ ...base, lead: { ...lead, status: 'Converted' }, isLiveClient: true }).lead.badges).toEqual([])
  })

  it('empty notes become null', () => {
    expect(buildLeadWindowData({ ...base, lead: { ...lead, notes: '   ' } }).notes).toBeNull()
  })
})

function row(over: Partial<LeadCallRow> = {}): LeadCallRow {
  return {
    id: 'r1', lead_id: 'l1', booked_at: '2026-10-02T10:00:00Z', scheduled_start: '2026-10-12T19:00:00Z', scheduled_date: '2026-10-12',
    state: 'scheduled', happened_at: null, call_summary_id: null, calendly_event_uri: 'e1', moved_to: null, source: 'calendly',
    confirmed_by: null, created_at: '2026-10-02T10:00:00Z', ...over,
  }
}

describe('buildCallsFromRows', () => {
  it('numbers calls by date and shows booked, planned and happened', () => {
    const calls = buildCallsFromRows({
      rows: [
        row({ id: 'r2', scheduled_date: '2026-11-04', scheduled_start: '2026-11-04T20:00:00Z', booked_at: '2026-10-28T10:00:00Z' }),
        row({ id: 'r1', state: 'done', happened_at: '2026-10-12T20:00:00Z', call_summary_id: 'a', confirmed_by: 'recording' }),
      ],
      recordings: [rec('a', '2026-10-12T20:00:00Z')],
      transcriptCallIds: ['a'],
      now: NOW,
    })
    expect(calls.map(c => [c.title, c.state, c.rowId])).toEqual([['Call 1', 'done', 'r1'], ['Call 2', 'scheduled', 'r2']])
    expect(calls[0]).toMatchObject({ hasTranscript: true, callId: 'a', durationMin: 41, canConfirm: false })
    expect(calls[1]).toMatchObject({ chip: 'Scheduled, in 3 days', bookedAt: '2026-10-28T10:00:00Z', canConfirm: false })
  })

  it('a passed date with no recording asks staff; no-show, moved, cancelled keep their label', () => {
    const calls = buildCallsFromRows({
      leadStatus: 'Call Scheduled',
      rows: [
        row({ id: 'a', scheduled_date: '2026-10-20', scheduled_start: '2026-10-20T19:00:00Z' }),
        row({ id: 'b', scheduled_date: '2026-10-21', scheduled_start: '2026-10-21T19:00:00Z', state: 'no_show' }),
        row({ id: 'c', scheduled_date: '2026-10-22', scheduled_start: '2026-10-22T19:00:00Z', state: 'moved' }),
        row({ id: 'd', scheduled_date: '2026-10-23', scheduled_start: '2026-10-23T19:00:00Z', state: 'cancelled' }),
        row({ id: 'e', scheduled_date: '2026-11-01', scheduled_start: '2026-11-01T19:00:00Z' }),
      ],
      recordings: [], transcriptCallIds: [], now: NOW,
    })
    expect(calls.map(c => [c.state, c.canConfirm])).toEqual([
      ['not_confirmed', true], ['no_show', false], ['moved', false], ['cancelled', false], ['due_today', true],
    ])
  })

  it('a recording with no call record yet still appears as a Done call', () => {
    const calls = buildCallsFromRows({ rows: [], recordings: [rec('z', '2026-10-20T15:00:00Z')], transcriptCallIds: [], now: NOW })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ state: 'done', rowId: null, canConfirm: false, callId: 'z' })
  })

  it('a call confirmed by staff has no recording and says so', () => {
    const calls = buildCallsFromRows({ rows: [row({ state: 'done', happened_at: '2026-10-13T10:00:00Z', confirmed_by: 'luca' })], recordings: [], transcriptCallIds: [], now: NOW })
    expect(calls[0]).toMatchObject({ state: 'done', chip: 'Done, confirmed by staff', callId: null })
  })
})

describe('old bookings on later-stage leads and dry-run moves', () => {
  it('a passed date with no recording on a lead past Call Scheduled is history, not a question', () => {
    const calls = buildCallsFromRows({ leadStatus: 'Offer Sent', rows: [row({ scheduled_date: '2026-09-01', scheduled_start: '2026-09-01T19:00:00Z' })], recordings: [], transcriptCallIds: [], now: NOW })
    expect(calls[0]).toMatchObject({ state: 'unrecorded', chip: 'No recording', canConfirm: false })
  })
  it('the same row on a Call Scheduled lead still asks', () => {
    const calls = buildCallsFromRows({ leadStatus: 'Call Scheduled', rows: [row({ scheduled_date: '2026-10-20', scheduled_start: '2026-10-20T19:00:00Z' })], recordings: [], transcriptCallIds: [], now: NOW })
    expect(calls[0]).toMatchObject({ state: 'not_confirmed', canConfirm: true })
  })
  it('a future call is never turned into history', () => {
    const calls = buildCallsFromRows({ leadStatus: 'Offer Sent', rows: [row({ scheduled_date: '2026-11-04' })], recordings: [], transcriptCallIds: [], now: NOW })
    expect(calls[0].state).toBe('scheduled')
  })
  it('a dry-run record shows as "would have moved" with no undo', () => {
    const lead: WindowInput['lead'] = {
      id: 'l1', full_name: 'S', email: null, phone: null, language: null, source: null, referrer_name: null, status: 'Call Scheduled', call_date: null,
      notes: null, created_at: '2026-10-02T10:00:00Z', updated_at: null, existing_client_contact_id: null, converted_to_contact_id: null,
    }
    const d = buildLeadWindowData({
      lead, offers: [], calls: [], transcriptCallIds: [], emails: [], contracts: [], activation: null, isLiveClient: false, now: NOW,
      moves: [{ id: 'm', lead_id: 'l1', from_status: 'Call Scheduled', to_status: 'Call Done', reason: 'dry_run_auto_call_done', source: 'circleback', call_id: null, undo_until: null, undone_at: null, undone_by: null, created_at: '2026-10-12T20:00:00Z' }],
    })
    const ev = d.story.find(e => e.type === 'status_moved')
    expect(ev?.title).toMatch(/Would have moved to Call Done/)
    expect(ev?.undo).toBeNull()
  })
})

describe('window data with call records and moves', () => {
  const lead: WindowInput['lead'] = {
    id: 'l1', full_name: 'Sofia', email: 's@example.com', phone: null, language: 'Italian', source: 'Calendly', referrer_name: null,
    status: 'Call Done', call_date: '2026-10-12', notes: null, created_at: '2026-10-02T10:00:00Z', updated_at: null,
    existing_client_contact_id: null, converted_to_contact_id: null, owner: 'Luca', follow_up_date: '2026-11-04',
  }
  const move = (over: Partial<StatusMoveRow> = {}): StatusMoveRow => ({
    id: 'm1', lead_id: 'l1', from_status: 'Call Scheduled', to_status: 'Call Done', reason: 'auto_call_done', source: 'circleback', call_id: 'r1',
    undo_until: '2026-11-01T20:00:00Z', undone_at: null, undone_by: null, created_at: '2026-10-12T20:05:00Z', ...over,
  })
  const base: WindowInput = {
    lead, offers: [], calls: [rec('a', '2026-10-12T20:00:00Z')], transcriptCallIds: [], emails: [], contracts: [], activation: null, isLiveClient: false,
    leadCalls: [row({ state: 'done', happened_at: '2026-10-12T20:00:00Z', call_summary_id: 'a', confirmed_by: 'recording' })], moves: [move()], now: NOW,
  }

  it('passes owner and follow-up through', () => {
    const d = buildLeadWindowData(base)
    expect(d.lead.owner).toBe('Luca')
    expect(d.lead.followUpDate).toBe('2026-11-04')
  })

  it('story: booked, recorded and moved events; the open undo is offered with hours left', () => {
    const d = buildLeadWindowData(base)
    const titles = d.story.map(e => e.title)
    expect(titles).toContain('Call 1 booked')
    expect(titles).toContain('Call 1 recorded')
    const moved = d.story.find(e => e.type === 'status_moved')
    expect(moved?.title).toBe('Moved to Call Done automatically')
    expect(moved?.undo).toEqual({ moveId: 'm1', hoursLeft: 5 })
    expect(d.story.filter(e => e.type === 'call_completed')).toHaveLength(1)
  })

  it('an undone move shows both events and offers no undo', () => {
    const d = buildLeadWindowData({ ...base, moves: [move({ undone_at: '2026-10-12T21:00:00Z', undone_by: 'luca' })] })
    const moves = d.story.filter(e => e.type === 'status_moved')
    expect(moves).toHaveLength(2)
    expect(moves.every(e => !e.undo)).toBe(true)
    expect(moves.map(e => e.title).some(t => t.startsWith('Undone'))).toBe(true)
  })

  it('an expired undo window offers no undo', () => {
    const d = buildLeadWindowData({ ...base, moves: [move({ undo_until: '2026-10-13T20:00:00Z' })] })
    expect(d.story.find(e => e.type === 'status_moved')?.undo).toBeNull()
  })

  it('falls back to recordings + call date when the lead has no call records', () => {
    const d = buildLeadWindowData({ ...base, leadCalls: [], moves: [] })
    expect(d.calls.length).toBeGreaterThan(0)
    expect(d.story.some(e => e.type === 'call_booked')).toBe(false)
  })
})
