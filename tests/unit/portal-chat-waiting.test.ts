/** "Waiting for client" rules (lib/portal-chats/waiting) — 2026-11-21. */
import { describe, expect, it } from 'vitest'
import { daysWaiting, decideWaitingReminder, isStillWaiting, WAITING_MAX_REMINDERS } from '@/lib/portal-chats/waiting'

const d = (s: string) => new Date(s)

describe('isStillWaiting', () => {
  it('is waiting when the client has not written since the mark', () => {
    expect(isStillWaiting('2026-11-18T10:00:00Z', [])).toBe(true)
    expect(isStillWaiting('2026-11-18T10:00:00Z', ['2026-11-17T09:00:00Z'])).toBe(true)
  })
  it('ends when the client writes after the mark (even at the same moment)', () => {
    expect(isStillWaiting('2026-11-18T10:00:00Z', ['2026-11-18T10:00:01Z'])).toBe(false)
    expect(isStillWaiting('2026-11-18T10:00:00Z', ['2026-11-18T10:00:00Z'])).toBe(false)
  })
  it('a bad mark time is never "waiting"', () => {
    expect(isStillWaiting('not a date', [])).toBe(false)
  })
})

describe('daysWaiting', () => {
  it('counts whole days, never negative', () => {
    expect(daysWaiting('2026-11-18T10:00:00Z', d('2026-11-21T09:00:00Z'))).toBe(2)
    expect(daysWaiting('2026-11-18T10:00:00Z', d('2026-11-21T10:00:00Z'))).toBe(3)
    expect(daysWaiting('2026-11-22T10:00:00Z', d('2026-11-21T10:00:00Z'))).toBe(0)
    expect(daysWaiting('garbage', d('2026-11-21T10:00:00Z'))).toBe(0)
  })
})

describe('decideWaitingReminder', () => {
  const marked = '2026-11-10T10:00:00Z'
  it('first reminder only after 3 days of silence', () => {
    expect(decideWaitingReminder({ markedAt: marked, remindersSent: 0, lastReminderAt: null, now: d('2026-11-13T09:59:00Z') }).send).toBe(false)
    expect(decideWaitingReminder({ markedAt: marked, remindersSent: 0, lastReminderAt: null, now: d('2026-11-13T10:00:00Z') })).toEqual({ send: true, reminderNumber: 1 })
  })
  it('second reminder 3 days after the first', () => {
    expect(decideWaitingReminder({ markedAt: marked, remindersSent: 1, lastReminderAt: '2026-11-13T10:00:00Z', now: d('2026-11-15T10:00:00Z') }).send).toBe(false)
    expect(decideWaitingReminder({ markedAt: marked, remindersSent: 1, lastReminderAt: '2026-11-13T10:00:00Z', now: d('2026-11-16T10:00:00Z') })).toEqual({ send: true, reminderNumber: 2 })
  })
  it('stops after the maximum', () => {
    const r = decideWaitingReminder({ markedAt: marked, remindersSent: WAITING_MAX_REMINDERS, lastReminderAt: '2026-11-16T10:00:00Z', now: d('2026-12-30T10:00:00Z') })
    expect(r.send).toBe(false)
  })
  it('a follow-up with no recorded time never sends blindly', () => {
    expect(decideWaitingReminder({ markedAt: marked, remindersSent: 1, lastReminderAt: null, now: d('2026-12-30T10:00:00Z') }).send).toBe(false)
  })
})
