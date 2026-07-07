import { describe, it, expect } from 'vitest'
import { mailboxAllowedFor, PERSONAL_MAILBOX } from '@/lib/inbox/mailbox-access'

describe('mailboxAllowedFor', () => {
  it('personal mailbox requires admin', () => {
    expect(mailboxAllowedFor(PERSONAL_MAILBOX, true)).toBe(true)
    expect(mailboxAllowedFor(PERSONAL_MAILBOX, false)).toBe(false)
  })

  it('shared/support mailbox is open to any dashboard user', () => {
    expect(mailboxAllowedFor('support', false)).toBe(true)
    expect(mailboxAllowedFor(null, false)).toBe(true)
    expect(mailboxAllowedFor(undefined, false)).toBe(true)
    expect(mailboxAllowedFor('', false)).toBe(true)
  })

  it('unknown mailbox values do not accidentally grant the personal mailbox', () => {
    // Only the exact 'antonio' value selects the personal mailbox in the
    // routes (anything else resolves to support@), so gating on the exact
    // value matches the routing behavior.
    expect(mailboxAllowedFor('ANTONIO', false)).toBe(true)
    expect(mailboxAllowedFor('antonio ', false)).toBe(true)
  })
})
