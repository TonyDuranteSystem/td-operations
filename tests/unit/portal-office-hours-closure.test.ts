import { describe, it, expect } from 'vitest'
import { getOfficeStatus, isOfficeOpen } from '@/lib/portal/office-hours'
import type { OfficeClosure } from '@/lib/portal/office-closures'

// Thanksgiving week 2026: the clock must say closed on Wed 25 and Fri 27 (normal working days that are NOT federal holidays),
// keep Thu 26 closed (now as a closure, which beats the holiday rule), and be back to normal on Mon 30.
// New York is on EST (UTC-5) from 1 Nov 2026, so 11:00 AM ET = 16:00Z.

describe('getOfficeStatus — Thanksgiving week 2026 (planned closure)', () => {
  it('Mon 23 Nov 11:00 AM → open (the heads-up does not close the office)', () => {
    expect(getOfficeStatus(new Date('2026-11-23T16:00:00Z'))).toEqual({ open: true, reason: 'open' })
  })
  it('Tue 24 Nov 11:00 AM → open', () => {
    expect(getOfficeStatus(new Date('2026-11-24T16:00:00Z'))).toEqual({ open: true, reason: 'open' })
  })
  it('Tue 24 Nov 4:00 PM → after_hours (normal rule, not a closure)', () => {
    expect(getOfficeStatus(new Date('2026-11-24T21:00:00Z'))).toEqual({ open: false, reason: 'after_hours' })
  })
  it('Wed 25 Nov 11:00 AM → closed by the planned closure', () => {
    expect(getOfficeStatus(new Date('2026-11-25T16:00:00Z'))).toEqual({ open: false, reason: 'closure' })
  })
  it('Thu 26 Nov (Thanksgiving) → closure beats the holiday reason', () => {
    expect(getOfficeStatus(new Date('2026-11-26T17:00:00Z'))).toEqual({ open: false, reason: 'closure' })
  })
  it('Fri 27 Nov 11:00 AM → closed by the planned closure', () => {
    expect(getOfficeStatus(new Date('2026-11-27T16:00:00Z'))).toEqual({ open: false, reason: 'closure' })
  })
  it('Sat 28 and Sun 29 Nov → closed (inside the closure, not just "weekend")', () => {
    expect(getOfficeStatus(new Date('2026-11-28T16:00:00Z')).reason).toBe('closure')
    expect(getOfficeStatus(new Date('2026-11-29T16:00:00Z')).reason).toBe('closure')
  })
  it('Mon 30 Nov 8:00 AM → before_hours; 10:00 AM → open again', () => {
    expect(getOfficeStatus(new Date('2026-11-30T13:00:00Z'))).toEqual({ open: false, reason: 'before_hours' })
    expect(getOfficeStatus(new Date('2026-11-30T15:00:00Z'))).toEqual({ open: true, reason: 'open' })
  })
  it('flips at New York midnight, not UTC midnight', () => {
    expect(getOfficeStatus(new Date('2026-11-25T04:30:00Z')).reason).toBe('after_hours') // Tue 11:30 PM ET
    expect(getOfficeStatus(new Date('2026-11-25T05:30:00Z')).reason).toBe('closure') // Wed 12:30 AM ET
    expect(getOfficeStatus(new Date('2026-11-30T04:30:00Z')).reason).toBe('closure') // Sun 11:30 PM ET
    expect(getOfficeStatus(new Date('2026-11-30T05:30:00Z')).reason).toBe('before_hours') // Mon 12:30 AM ET
  })
  it('isOfficeOpen agrees with the status (the chat reply uses it)', () => {
    expect(isOfficeOpen(new Date('2026-11-25T16:00:00Z'))).toBe(false)
    expect(isOfficeOpen(new Date('2026-11-27T16:00:00Z'))).toBe(false)
    expect(isOfficeOpen(new Date('2026-11-24T16:00:00Z'))).toBe(true)
  })
  it('the rest of the year is untouched (a normal Wednesday in May is still open)', () => {
    expect(getOfficeStatus(new Date('2026-05-20T17:00:00Z'))).toEqual({ open: true, reason: 'open' })
  })
})

describe('getOfficeStatus — closures argument', () => {
  const custom: OfficeClosure = {
    id: 'test', noticeFrom: '2026-05-18', closedFrom: '2026-05-20', closedUntil: '2026-05-21', reopens: '2026-05-22',
    copy: { en: {} as never, it: {} as never },
  }
  it('an empty list switches planned closures off (the normal rule only)', () => {
    expect(getOfficeStatus(new Date('2026-11-25T16:00:00Z'), [])).toEqual({ open: true, reason: 'open' })
  })
  it('a custom list closes its own days', () => {
    expect(getOfficeStatus(new Date('2026-05-20T17:00:00Z'), [custom])).toEqual({ open: false, reason: 'closure' })
    expect(getOfficeStatus(new Date('2026-05-19T17:00:00Z'), [custom])).toEqual({ open: true, reason: 'open' })
    expect(getOfficeStatus(new Date('2026-05-22T17:00:00Z'), [custom])).toEqual({ open: true, reason: 'open' })
  })
})
