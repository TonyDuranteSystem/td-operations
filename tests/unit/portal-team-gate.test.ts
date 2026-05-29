import { describe, it, expect } from 'vitest'
import { requirePortalCapability, teammateNavCapability } from '@/lib/portal/team/gate'
import type { PortalIdentity } from '@/lib/portal/resolve-portal-identity'
import type { User } from '@supabase/supabase-js'

const user = { id: 'u1', app_metadata: {} } as unknown as User
const resolver = (identity: PortalIdentity) => async () => identity

describe('requirePortalCapability', () => {
  it('unauthenticated when no user', async () => {
    expect(await requirePortalCapability(null, 'documents')).toEqual({ allowed: false, reason: 'unauthenticated' })
  })

  it('contact is always allowed (capability not checked)', async () => {
    const r = await requirePortalCapability(user, 'documents', resolver({ kind: 'contact', contactId: 'c1', accountIds: ['a1'] }))
    expect(r).toMatchObject({ allowed: true, kind: 'contact', contactId: 'c1' })
  })

  it('teammate allowed only when the capability is granted', async () => {
    const granted = resolver({ kind: 'teammate', teamMemberId: 't1', accountId: 'a9', displayName: 'M', email: null, capabilities: { documents: true } })
    const ok = await requirePortalCapability(user, 'documents', granted)
    expect(ok).toMatchObject({ allowed: true, kind: 'teammate', accountId: 'a9' })

    const denied = await requirePortalCapability(user, 'invoices_billing', granted)
    expect(denied).toEqual({ allowed: false, reason: 'denied' })
  })

  it('teammate with no capabilities is denied (default-deny)', async () => {
    const r = await requirePortalCapability(user, 'documents', resolver({ kind: 'teammate', teamMemberId: 't1', accountId: 'a9', displayName: 'M', email: null, capabilities: {} }))
    expect(r).toEqual({ allowed: false, reason: 'denied' })
  })

  it('unresolved identity is denied', async () => {
    expect(await requirePortalCapability(user, 'documents', resolver({ kind: 'none' }))).toEqual({ allowed: false, reason: 'denied' })
  })
})

describe('teammateNavCapability', () => {
  it('maps granted sections to their capability', () => {
    expect(teammateNavCapability('nav.documents')).toBe('documents')
    expect(teammateNavCapability('nav.generateDocuments')).toBe('documents')
    expect(teammateNavCapability('nav.invoices')).toBe('invoices_billing')
    expect(teammateNavCapability('nav.tdBilling')).toBe('invoices_billing')
    expect(teammateNavCapability('nav.chat')).toBe('chat')
    expect(teammateNavCapability('nav.myCompany')).toBe('company_services')
    expect(teammateNavCapability('nav.myClients')).toBe('sales_customers')
  })
  it('always-on items', () => {
    expect(teammateNavCapability('nav.overview')).toBe('always')
    expect(teammateNavCapability('nav.guide')).toBe('always')
  })
  it('owner-only / non-delegable items are hidden (null)', () => {
    for (const k of ['nav.team', 'nav.signDocuments', 'nav.requestService', 'nav.referrals', 'nav.profile', 'nav.offer', 'nav.partnerClients']) {
      expect(teammateNavCapability(k)).toBeNull()
    }
  })
})
