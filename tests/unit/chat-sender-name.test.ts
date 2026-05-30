import { describe, it, expect } from 'vitest'
import { pickChatSenderName } from '@/lib/portal/chat-sender-name'

describe('pickChatSenderName', () => {
  it('prefers the contact full name (normal client/owner message)', () => {
    expect(pickChatSenderName('Uxio Test', 'ignored')).toBe('Uxio Test')
  })

  it('uses the stored sender_name when there is no contact (teammate message)', () => {
    expect(pickChatSenderName(null, 'QA Teammate')).toBe('QA Teammate')
    expect(pickChatSenderName(undefined, 'QA Teammate')).toBe('QA Teammate')
  })

  it('returns null when neither is present (UI shows its generic label)', () => {
    expect(pickChatSenderName(null, null)).toBeNull()
    expect(pickChatSenderName(undefined, undefined)).toBeNull()
  })

  it('treats empty/whitespace as absent (column default is empty string)', () => {
    expect(pickChatSenderName('', '')).toBeNull()
    expect(pickChatSenderName('   ', 'Teammate Name')).toBe('Teammate Name')
    expect(pickChatSenderName('', '  ')).toBeNull()
  })

  it('trims the returned name', () => {
    expect(pickChatSenderName('  Marco Rossi  ', null)).toBe('Marco Rossi')
    expect(pickChatSenderName(null, '  QA Teammate ')).toBe('QA Teammate')
  })
})
