import { describe, it, expect } from 'vitest'
import { clientLoginContactIds, clientLoginNeedsSetupIds } from '@/lib/portal/client-login-index'

describe('clientLoginContactIds', () => {
  it('keeps only CLIENT logins that carry a contact id', () => {
    const ids = clientLoginContactIds([
      { app_metadata: { role: 'client', contact_id: 'c1' } },
      { app_metadata: { role: 'client', contact_id: 'c2' } },
      { app_metadata: { role: 'admin', contact_id: 'staff' } },
      { app_metadata: { role: 'partner', contact_id: 'p1' } },
      { app_metadata: { role: 'client' } }, // legacy login, no contact link
      { app_metadata: { role: 'client', contact_id: '' } },
      { app_metadata: null },
      {},
    ])
    expect([...ids].sort()).toEqual(['c1', 'c2'])
  })

  it('collapses duplicate logins on the same contact', () => {
    const ids = clientLoginContactIds([
      { app_metadata: { role: 'client', contact_id: 'same' } },
      { app_metadata: { role: 'client', contact_id: 'same' } },
    ])
    expect(ids.size).toBe(1)
    expect(ids.has('same')).toBe(true)
  })

  it('returns an empty set for an empty list', () => {
    expect(clientLoginContactIds([]).size).toBe(0)
  })

  it('never treats a staff-only user base as having client logins', () => {
    const ids = clientLoginContactIds([
      { app_metadata: { role: 'admin' } },
      { app_metadata: { role: 'team', contact_id: 'x' } },
    ])
    expect(ids.size).toBe(0)
  })
})

describe('clientLoginNeedsSetupIds', () => {
  it('flags client logins with a truthy must_change_password, matching the real password gate exactly', () => {
    const ids = clientLoginNeedsSetupIds([
      { app_metadata: { role: 'client', contact_id: 'stuck' }, user_metadata: { must_change_password: true } },
      { app_metadata: { role: 'client', contact_id: 'done' }, user_metadata: { must_change_password: false } },
      { app_metadata: { role: 'client', contact_id: 'legacy' }, user_metadata: {} },
      { app_metadata: { role: 'client', contact_id: 'nometa' } },
    ])
    expect([...ids]).toEqual(['stuck'])
  })

  it('never flags a non-client role even if the flag is true', () => {
    const ids = clientLoginNeedsSetupIds([
      { app_metadata: { role: 'admin', contact_id: 'staff' }, user_metadata: { must_change_password: true } },
    ])
    expect(ids.size).toBe(0)
  })

  it('flags any truthy value, not just the literal boolean true — same coercion as the real password gate (!!user.user_metadata?.must_change_password in app/portal/layout.tsx), so this can never silently disagree with what PasswordGate actually shows the client', () => {
    const ids = clientLoginNeedsSetupIds([
      { app_metadata: { role: 'client', contact_id: 'c1' }, user_metadata: { must_change_password: 'true' as unknown as boolean } },
    ])
    expect([...ids]).toEqual(['c1'])
  })

  it('returns an empty set for an empty list', () => {
    expect(clientLoginNeedsSetupIds([]).size).toBe(0)
  })
})
