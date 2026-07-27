import { describe, it, expect } from 'vitest'
import { clientLoginContactIds } from '@/lib/portal/client-login-index'

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
