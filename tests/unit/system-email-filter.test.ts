import { describe, it, expect } from 'vitest'
import { isSystemNotificationSubject } from '@/lib/inbox/system-email-filter'

describe('isSystemNotificationSubject', () => {
  it('matches the portal digest subjects (EN + IT, singular + plural)', () => {
    expect(isSystemNotificationSubject('1 new update in your portal')).toBe(true)
    expect(isSystemNotificationSubject('2 new updates in your portal')).toBe(true)
    expect(isSystemNotificationSubject('1 nuovo aggiornamento nel tuo portale')).toBe(true)
    expect(isSystemNotificationSubject('3 nuovi aggiornamenti nel tuo portale')).toBe(true)
  })

  it('matches the chat-notify subjects (EN + IT, with Re:)', () => {
    expect(isSystemNotificationSubject('New message from the Tony Durante team')).toBe(true)
    expect(isSystemNotificationSubject('Re: New message from the Tony Durante team')).toBe(true)
    expect(isSystemNotificationSubject('Nuovo messaggio dal team Tony Durante')).toBe(true)
  })

  it('never filters real correspondence', () => {
    expect(isSystemNotificationSubject('Re: Urgent: ITIN Application')).toBe(false)
    expect(isSystemNotificationSubject('Invoice INV-002227 — Tony Durante LLC')).toBe(false)
    expect(isSystemNotificationSubject('Your LLC formation documents')).toBe(false)
    expect(isSystemNotificationSubject('Portal update needed for my account')).toBe(false)
    expect(isSystemNotificationSubject('')).toBe(false)
    expect(isSystemNotificationSubject(null)).toBe(false)
  })
})
