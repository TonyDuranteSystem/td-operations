import { describe, it, expect } from 'vitest'
import { isCallFreeForNewLead, readAttendees, toCallChoice, suggestLeadFromCall, type CallPickerRow } from '@/lib/leads/lead-from-call'

const base: CallPickerRow = {
  id: 'c1', meeting_name: 'Zoom Meeting', duration_seconds: 4320, created_at: '2026-11-02T14:00:00Z',
  attendees: [], lead_id: null, contact_id: null, account_id: null,
}

describe('isCallFreeForNewLead', () => {
  it('is free only when no lead, contact or company is attached', () => {
    expect(isCallFreeForNewLead(base)).toBe(true)
    expect(isCallFreeForNewLead({ ...base, lead_id: 'l' })).toBe(false)
    expect(isCallFreeForNewLead({ ...base, contact_id: 'c' })).toBe(false)
    expect(isCallFreeForNewLead({ ...base, account_id: 'a' })).toBe(false)
  })
})

describe('readAttendees', () => {
  it('reads names and emails and survives junk', () => {
    expect(readAttendees(null)).toEqual([])
    expect(readAttendees('x')).toEqual([])
    expect(readAttendees([null, 5, { name: ' Ann ', email: ' A@B.com ' }, { name: '', email: '' }])).toEqual([
      { name: 'Ann', email: 'a@b.com' },
      { name: null, email: null },
    ])
  })
})

describe('toCallChoice', () => {
  it('keeps only outside people with an email and rounds minutes', () => {
    const c = toCallChoice({ ...base, attendees: [
      { name: 'Antonio', email: 'antonio.durante@tonydurante.us' },
      { name: 'Guest', email: 'guest@example.com' },
      { name: 'No Email', email: null },
    ] })
    expect(c.outsiders).toEqual([{ name: 'Guest', email: 'guest@example.com' }])
    expect(c.durationMinutes).toBe(72)
    expect(c.title).toBe('Zoom Meeting')
  })
  it('names an untitled call and has no minutes without a duration', () => {
    const c = toCallChoice({ ...base, meeting_name: '  ', duration_seconds: null })
    expect(c.title).toBe('Untitled call')
    expect(c.durationMinutes).toBeNull()
  })
})

describe('suggestLeadFromCall', () => {
  it('suggests the one outside person', () => {
    const c = toCallChoice({ ...base, attendees: [{ name: 'Guest One', email: 'g@example.com' }] })
    expect(suggestLeadFromCall(c)).toEqual({ full_name: 'Guest One', email: 'g@example.com' })
  })
  it('suggests nothing when nobody or several outside people are on the call', () => {
    expect(suggestLeadFromCall(toCallChoice(base))).toEqual({ full_name: '', email: '' })
    const two = toCallChoice({ ...base, attendees: [{ name: 'A', email: 'a@x.com' }, { name: 'B', email: 'b@x.com' }] })
    expect(suggestLeadFromCall(two)).toEqual({ full_name: '', email: '' })
  })
})
