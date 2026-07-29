import { describe, it, expect } from 'vitest'
import {
  snoozePresets,
  decideWakeAction,
  isValidSnoozeUntil,
  MIN_SNOOZE_LEAD_MS,
} from '@/lib/inbox/email-snooze'

// A Wednesday morning: 2026-07-29 is a Wednesday.
const wedMorning = new Date('2026-07-29T09:00:00')

describe('snoozePresets', () => {
  it('morning: all three presets, each strictly in the future', () => {
    const presets = snoozePresets(wedMorning)
    expect(presets.map((p) => p.key)).toEqual(['later_today', 'tomorrow', 'next_monday'])
    for (const p of presets) {
      expect(p.until.getTime()).toBeGreaterThan(wedMorning.getTime() + MIN_SNOOZE_LEAD_MS)
    }
  })

  it('after 18:00 the "later today" preset disappears instead of waking instantly', () => {
    const evening = new Date('2026-07-29T19:30:00')
    expect(snoozePresets(evening).map((p) => p.key)).toEqual(['tomorrow', 'next_monday'])
  })

  it('clicked AT 18:00 exactly, later-today is dropped (lead margin)', () => {
    const atSix = new Date('2026-07-29T18:00:00')
    expect(snoozePresets(atSix).map((p) => p.key)).not.toContain('later_today')
  })

  it('next Monday is strictly 1..7 days ahead — on a Monday it means NEXT week', () => {
    const monday = new Date('2026-07-27T09:00:00') // a Monday
    const preset = snoozePresets(monday).find((p) => p.key === 'next_monday')!
    expect(preset.until.getDay()).toBe(1)
    const days = (preset.until.getTime() - monday.getTime()) / 86_400_000
    expect(days).toBeGreaterThan(6)
    expect(days).toBeLessThanOrEqual(7)
  })

  it('tomorrow 08:00 is tomorrow at 08:00', () => {
    const p = snoozePresets(wedMorning).find((x) => x.key === 'tomorrow')!
    expect(p.until.getDate()).toBe(30)
    expect(p.until.getHours()).toBe(8)
  })
})

describe('decideWakeAction', () => {
  const msg = (id: string, labels: string[]) => ({ id, labelIds: labels })

  it('wakes a plain snoozed thread (no INBOX is the normal snoozed state)', () => {
    expect(
      decideWakeAction({
        threadFound: true,
        messages: [msg('m1', ['Snoozed'])],
        snoozedLastMessageId: 'm1',
      })
    ).toEqual({ kind: 'wake' })
  })

  it('cancels when the thread is gone (404 / empty)', () => {
    expect(
      decideWakeAction({ threadFound: false, messages: [], snoozedLastMessageId: 'm1' })
    ).toEqual({ kind: 'cancel', reason: 'gone' })
    expect(
      decideWakeAction({ threadFound: true, messages: [], snoozedLastMessageId: 'm1' })
    ).toEqual({ kind: 'cancel', reason: 'gone' })
  })

  it('cancels a thread trashed while snoozed — never resurrect deleted mail', () => {
    expect(
      decideWakeAction({
        threadFound: true,
        messages: [msg('m1', ['TRASH'])],
        snoozedLastMessageId: 'm1',
      })
    ).toEqual({ kind: 'cancel', reason: 'trashed' })
  })

  it('cancels when new mail arrived after the snooze (reply already surfaced it)', () => {
    expect(
      decideWakeAction({
        threadFound: true,
        messages: [msg('m1', ['Snoozed']), msg('m2', ['INBOX', 'UNREAD'])],
        snoozedLastMessageId: 'm1',
      })
    ).toEqual({ kind: 'cancel', reason: 'new_mail' })
  })

  it('cancels when new mail arrived and staff already archived the thread', () => {
    expect(
      decideWakeAction({
        threadFound: true,
        messages: [msg('m1', []), msg('m2', [])],
        snoozedLastMessageId: 'm1',
      })
    ).toEqual({ kind: 'cancel', reason: 'new_mail' })
  })

  it('unknown snoozed-last id (message deleted) counts as newer mail, not a crash', () => {
    expect(
      decideWakeAction({
        threadFound: true,
        messages: [msg('m9', [])],
        snoozedLastMessageId: 'm1',
      })
    ).toEqual({ kind: 'cancel', reason: 'new_mail' })
  })

  it('no recorded last-message id → wake (legacy rows fail open to waking)', () => {
    expect(
      decideWakeAction({
        threadFound: true,
        messages: [msg('m1', []), msg('m2', [])],
        snoozedLastMessageId: null,
      })
    ).toEqual({ kind: 'wake' })
  })
})

describe('isValidSnoozeUntil', () => {
  it('accepts a future instant, rejects past/near-past/garbage', () => {
    const now = new Date('2026-07-29T09:00:00Z')
    expect(isValidSnoozeUntil('2026-07-29T18:00:00Z', now)).toBe(true)
    expect(isValidSnoozeUntil('2026-07-29T08:59:00Z', now)).toBe(false)
    expect(isValidSnoozeUntil(new Date(now.getTime() + 30_000).toISOString(), now)).toBe(false)
    expect(isValidSnoozeUntil('not-a-date', now)).toBe(false)
    expect(isValidSnoozeUntil('', now)).toBe(false)
  })
})
