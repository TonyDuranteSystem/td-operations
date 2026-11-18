import { describe, it, expect } from 'vitest'
import { auditAccountIdFor } from '@/lib/portal/audit-scope'
import type { PortalIdentity } from '@/lib/portal/resolve-portal-identity'

const contact = (accountIds: string[]): PortalIdentity => ({ kind: 'contact', contactId: 'C1', accountIds })
const teammate = (accountId: string): PortalIdentity =>
  ({ kind: 'teammate', accountId, teamMemberId: 'tm-1', displayName: 'T', email: null, capabilities: {} })
const none: PortalIdentity = { kind: 'none' }

describe('auditAccountIdFor', () => {
  it('keeps a company the client is part of', () => {
    expect(auditAccountIdFor(contact(['A', 'B']), 'B', false)).toBe('B')
  })

  it('REFUSES a company the client is not part of — falls back to their own first company', () => {
    expect(auditAccountIdFor(contact(['A', 'B']), 'OTHER', false)).toBe('A')
  })

  it('uses the first company when the browser names none', () => {
    expect(auditAccountIdFor(contact(['A', 'B']), undefined, false)).toBe('A')
    expect(auditAccountIdFor(contact(['A']), '', false)).toBe('A')
  })

  it('files under no company for a client with no linked company', () => {
    expect(auditAccountIdFor(contact([]), 'OTHER', false)).toBeUndefined()
  })

  it('always files a team login under its one company, whatever the browser sends', () => {
    expect(auditAccountIdFor(teammate('MINE'), 'OTHER', false)).toBe('MINE')
    expect(auditAccountIdFor(teammate('MINE'), undefined, false)).toBe('MINE')
    expect(auditAccountIdFor(teammate('MINE'), { x: 1 }, false)).toBe('MINE')
  })

  it('lets staff (a non-client login) name any company, as before', () => {
    expect(auditAccountIdFor(none, 'ANY', true)).toBe('ANY')
  })

  it('REFUSES a login with no identity that is not staff', () => {
    expect(auditAccountIdFor(none, 'ANY', false)).toBeUndefined()
  })

  it('ignores a non-text or oversized company id', () => {
    expect(auditAccountIdFor(none, 123, true)).toBeUndefined()
    expect(auditAccountIdFor(none, 'x'.repeat(65), true)).toBeUndefined()
    expect(auditAccountIdFor(contact(['A']), 'x'.repeat(65), false)).toBe('A')
  })
})
