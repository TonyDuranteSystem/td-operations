import { describe, it, expect } from 'vitest'
import {
  parseLeadFilters,
  filterLeads,
  quickCounts,
  matchesQuick,
  distinctValues,
  hasActiveFilters,
  todayInNewYork,
  type FilterableLead,
} from '@/lib/leads/list-filters'

const NOW = new Date('2026-10-31T15:00:00Z')

function lead(over: Partial<FilterableLead> = {}): FilterableLead {
  return {
    status: 'New',
    source: 'Calendly',
    referrer_name: null,
    call_date: null,
    current_offer_status: null,
    has_call_recording: false,
    updated_at: '2026-10-30T12:00:00Z',
    ...over,
  }
}

describe('parseLeadFilters', () => {
  it('returns empty filters for empty params', () => {
    expect(parseLeadFilters({})).toEqual({ status: '', src: '', ref: '', offer: '', call: '', follow: '', quick: '' })
  })
  it('treats status=all as no status filter', () => {
    expect(parseLeadFilters({ status: 'all' }).status).toBe('')
  })
  it('drops unknown offer, call and quick values', () => {
    const f = parseLeadFilters({ offer: 'bogus', call: 'bogus', quick: 'bogus' })
    expect(f.offer).toBe('')
    expect(f.call).toBe('')
    expect(f.quick).toBe('')
  })
  it('keeps valid values and takes the first of an array', () => {
    const f = parseLeadFilters({ status: ['Call Done', 'New'], offer: 'sent', call: 'recorded', quick: 'offer_stale', src: 'WhatsApp' })
    expect(f).toMatchObject({ status: 'Call Done', offer: 'sent', call: 'recorded', quick: 'offer_stale', src: 'WhatsApp' })
    expect(hasActiveFilters(f)).toBe(true)
  })
})

describe('filterLeads', () => {
  const rows = [
    lead({ status: 'Call Scheduled', has_call_recording: true, call_date: '2026-10-20' }),
    lead({ status: 'Call Scheduled', call_date: '2026-11-05' }),
    lead({ status: 'Call Done' }),
    lead({ status: 'Offer Sent', current_offer_status: 'sent', source: 'WhatsApp', referrer_name: 'Guido' }),
  ]
  const none = parseLeadFilters({})

  it('no filters returns everything', () => {
    expect(filterLeads(rows, none, { now: NOW })).toHaveLength(4)
  })
  it('filters by any real status', () => {
    expect(filterLeads(rows, parseLeadFilters({ status: 'Call Scheduled' }), { now: NOW })).toHaveLength(2)
  })
  it('ignores the status filter for the board', () => {
    expect(filterLeads(rows, parseLeadFilters({ status: 'Call Done' }), { now: NOW, ignoreStatus: true })).toHaveLength(4)
  })
  it('filters by source and referrer', () => {
    expect(filterLeads(rows, parseLeadFilters({ src: 'WhatsApp' }), { now: NOW })).toHaveLength(1)
    expect(filterLeads(rows, parseLeadFilters({ ref: 'Guido' }), { now: NOW })).toHaveLength(1)
  })
  it('offer=none matches leads with no offer, offer=sent only sent', () => {
    expect(filterLeads(rows, parseLeadFilters({ offer: 'none' }), { now: NOW })).toHaveLength(3)
    expect(filterLeads(rows, parseLeadFilters({ offer: 'sent' }), { now: NOW })).toHaveLength(1)
  })
  it('call filters: recorded / not recorded / date passed', () => {
    expect(filterLeads(rows, parseLeadFilters({ call: 'recorded' }), { now: NOW })).toHaveLength(1)
    expect(filterLeads(rows, parseLeadFilters({ call: 'not_recorded' }), { now: NOW })).toHaveLength(3)
    expect(filterLeads(rows, parseLeadFilters({ call: 'date_passed' }), { now: NOW })).toHaveLength(1)
  })
  it('a lead with no call date is never "date passed"', () => {
    expect(filterLeads([lead()], parseLeadFilters({ call: 'date_passed' }), { now: NOW })).toHaveLength(0)
  })
  it('combines filters with AND', () => {
    const f = parseLeadFilters({ status: 'Call Scheduled', call: 'recorded' })
    expect(filterLeads(rows, f, { now: NOW })).toHaveLength(1)
  })
})

describe('quick filters', () => {
  it('call_happened needs Call Scheduled AND a recording', () => {
    expect(matchesQuick('call_happened', lead({ status: 'Call Scheduled', has_call_recording: true }), NOW)).toBe(true)
    expect(matchesQuick('call_happened', lead({ status: 'Call Scheduled' }), NOW)).toBe(false)
    expect(matchesQuick('call_happened', lead({ status: 'Call Done', has_call_recording: true }), NOW)).toBe(false)
  })
  it('call_done_no_offer', () => {
    expect(matchesQuick('call_done_no_offer', lead({ status: 'Call Done' }), NOW)).toBe(true)
    expect(matchesQuick('call_done_no_offer', lead({ status: 'Call Done', current_offer_status: 'draft' }), NOW)).toBe(false)
  })
  it('offer_stale counts only Offer Sent leads untouched for 5+ days', () => {
    expect(matchesQuick('offer_stale', lead({ status: 'Offer Sent', updated_at: '2026-10-25T00:00:00Z' }), NOW)).toBe(true)
    expect(matchesQuick('offer_stale', lead({ status: 'Offer Sent', updated_at: '2026-10-29T00:00:00Z' }), NOW)).toBe(false)
    expect(matchesQuick('offer_stale', lead({ status: 'Offer Sent', updated_at: null }), NOW)).toBe(false)
    expect(matchesQuick('offer_stale', lead({ status: 'Call Done', updated_at: '2026-01-01T00:00:00Z' }), NOW)).toBe(false)
  })
  it('quickCounts totals each button', () => {
    const rows = [
      lead({ status: 'Call Scheduled', has_call_recording: true }),
      lead({ status: 'Call Scheduled', has_call_recording: true }),
      lead({ status: 'Call Done' }),
    ]
    expect(quickCounts(rows, NOW)).toEqual({ call_happened: 2, call_done_no_offer: 1, offer_stale: 0 })
  })
})

describe('helpers', () => {
  it('distinctValues drops blanks, dedupes and sorts', () => {
    expect(distinctValues(['b', null, 'a', 'b', ' ', 'C'])).toEqual(['a', 'b', 'C'])
  })
  it('todayInNewYork uses the New York date, not UTC', () => {
    // 02:00 UTC on Nov 1 is still Oct 31 evening in New York
    expect(todayInNewYork(new Date('2026-11-01T02:00:00Z'))).toBe('2026-10-31')
  })
})
