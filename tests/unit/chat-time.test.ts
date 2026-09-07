/**
 * Shared message-timestamp formatting — extracted (2026-09-07) so the full Team
 * Chat page and the floating chat widget can never drift onto two different
 * clocks for the same message (the mistake DELETED_MESSAGE_TEXT's own header
 * warns this codebase has already made once).
 */
import { describe, it, expect } from 'vitest'
import { msgTime } from '@/lib/team/chat-time'

describe('msgTime', () => {
  it('formats a time from today as HH:mm', () => {
    const now = new Date()
    now.setHours(14, 5, 0, 0)
    expect(msgTime(now.toISOString())).toBe('14:05')
  })

  it('formats a time from yesterday with a "Yesterday" prefix', () => {
    const y = new Date()
    y.setDate(y.getDate() - 1)
    y.setHours(9, 30, 0, 0)
    expect(msgTime(y.toISOString())).toMatch(/^Yesterday \d{2}:\d{2}$/)
  })

  it('formats an older date with month/day', () => {
    expect(msgTime('2026-01-05T10:00:00Z')).toMatch(/Jan 5/)
  })

  it('THE WIDGET GAP: never throws on the nullable timestamps its own type allows', () => {
    // page.tsx's stricter TeamMsg.created_at is non-nullable; the floating
    // widget's ChatMessage.created_at is `string | null`, and msgTime is now
    // shared by both — it must handle exactly what the widget can hand it.
    expect(msgTime(null)).toBe('')
    expect(msgTime(undefined)).toBe('')
    expect(msgTime('')).toBe('')
  })

  it('returns empty rather than "Invalid Date" for unparsable input', () => {
    expect(msgTime('not-a-date')).toBe('')
  })
})
