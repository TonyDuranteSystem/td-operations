import { describe, it, expect } from 'vitest'
import { parseFollowUpChannel, followUpDayLabel, followUpTagText } from '@/lib/leads/follow-up-sent'

describe('parseFollowUpChannel', () => {
  it('accepts the two channels only', () => {
    expect(parseFollowUpChannel('whatsapp')).toBe('whatsapp')
    expect(parseFollowUpChannel('email')).toBe('email')
    for (const bad of ['WhatsApp', 'sms', '', null, undefined, 5, {}]) expect(parseFollowUpChannel(bad)).toBeNull()
  })
})

describe('followUpDayLabel', () => {
  it('uses the New York day, not the UTC day', () => {
    expect(followUpDayLabel('2026-11-01T23:06:17Z')).toBe('1 Nov')
    expect(followUpDayLabel('2026-11-02T02:00:00Z')).toBe('1 Nov') // still 1 Nov evening in New York
    expect(followUpDayLabel('2026-12-05T15:00:00Z')).toBe('5 Dec')
  })
  it('is empty for a missing or broken time', () => {
    expect(followUpDayLabel(null)).toBe('')
    expect(followUpDayLabel('')).toBe('')
    expect(followUpDayLabel('not a time')).toBe('')
  })
})

describe('followUpTagText', () => {
  it('names the channel and the day', () => {
    expect(followUpTagText('2026-11-01T23:06:17Z', 'whatsapp')).toBe('Follow-up sent · WhatsApp · 1 Nov')
    expect(followUpTagText('2026-11-01T23:06:17Z', 'email')).toBe('Follow-up sent · Email · 1 Nov')
  })
  it('leaves an unknown channel out and shows nothing without a time', () => {
    expect(followUpTagText('2026-11-01T23:06:17Z', 'sms')).toBe('Follow-up sent · 1 Nov')
    expect(followUpTagText(null, 'whatsapp')).toBeNull()
  })
})
