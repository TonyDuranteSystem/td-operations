import { describe, it, expect } from 'vitest'
import { requirePortalCapability, canAccessAccount } from '@/lib/portal/team/gate'
import { teammateNavCapability } from '@/lib/portal/team/capabilities'
import type { PortalIdentity } from '@/lib/portal/resolve-portal-identity'
import type { User } from '@supabase/supabase-js'

const user = { id: 'u1', app_metadata: { role: 'client' } } as unknown as User
const staffUser = { id: 'admin1', app_metadata: { role: 'admin' } } as unknown as User
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

describe('canAccessAccount (default-deny, fixes the if(contactId) skip-leak)', () => {
  it('contact: only their linked accounts', async () => {
    const c = resolver({ kind: 'contact', contactId: 'c1', accountIds: ['a1', 'a2'] })
    expect(await canAccessAccount(user, 'a1', 'invoices_billing', c)).toBe(true)
    expect(await canAccessAccount(user, 'a9', 'invoices_billing', c)).toBe(false)
  })
  it('teammate: only their account AND only with the capability', async () => {
    const t = resolver({ kind: 'teammate', teamMemberId: 't1', accountId: 'a9', displayName: 'M', email: null, capabilities: { invoices_billing: true } })
    expect(await canAccessAccount(user, 'a9', 'invoices_billing', t)).toBe(true)
    expect(await canAccessAccount(user, 'a9', 'documents', t)).toBe(false) // capability not granted
    expect(await canAccessAccount(user, 'a1', 'invoices_billing', t)).toBe(false) // wrong account
  })
  it('staff (non-client role) bypass — authenticated admins pass', async () => {
    expect(await canAccessAccount(staffUser, 'a1', 'invoices_billing', resolver({ kind: 'none' }))).toBe(true)
  })
  it('denies null user / null account / unresolved', async () => {
    expect(await canAccessAccount(null, 'a1', 'documents')).toBe(false)
    expect(await canAccessAccount(user, null, 'documents', resolver({ kind: 'contact', contactId: 'c1', accountIds: ['a1'] }))).toBe(false)
    expect(await canAccessAccount(user, 'a1', 'documents', resolver({ kind: 'none' }))).toBe(false)
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
