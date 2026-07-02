import { describe, it, expect } from 'vitest'
import {
  pickChatSenderName,
  staffChatSenderLabel,
  formatMcpChatSenderLabel,
} from '@/lib/portal/chat-sender-name'

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

describe('staffChatSenderLabel', () => {
  it('labels an admin message "TD Team" — never a contact/member name', () => {
    expect(staffChatSenderLabel('admin')).toBe('TD Team')
  })

  it('flags a system (automated) message as an auto-reply', () => {
    expect(staffChatSenderLabel('system')).toBe('TD Team (auto-reply)')
  })

  it('returns null for client/teammate so the caller supplies its own label', () => {
    expect(staffChatSenderLabel('client')).toBeNull()
    expect(staffChatSenderLabel(undefined)).toBeNull()
    expect(staffChatSenderLabel(null)).toBeNull()
    expect(staffChatSenderLabel('')).toBeNull()
  })
})

describe('formatMcpChatSenderLabel', () => {
  it('labels admin/system as staff regardless of the routing-tag contact name', () => {
    // The contact name is the arbitrary routing tag (e.g. an unrelated member) —
    // it must NOT surface on a staff message.
    expect(formatMcpChatSenderLabel('admin', 'Gaia Pellegrinelli')).toBe('TD Team')
    expect(formatMcpChatSenderLabel('system', 'Michele Cotti')).toBe('TD Team (auto-reply)')
  })

  it('labels a client message with the contact full name', () => {
    expect(formatMcpChatSenderLabel('client', 'Michele Cotti')).toBe('Client (Michele Cotti)')
  })

  it('falls back to the teammate sender_name when there is no contact', () => {
    expect(formatMcpChatSenderLabel('client', null, 'QA Teammate')).toBe('Client (QA Teammate)')
  })

  it('uses the bare "Client" label when no name is available', () => {
    expect(formatMcpChatSenderLabel('client', null, null)).toBe('Client')
    expect(formatMcpChatSenderLabel('client', '', '')).toBe('Client')
  })
})
