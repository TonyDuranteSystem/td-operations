import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: { from: vi.fn() },
}))

vi.mock('@/lib/settings', () => ({
  getAppSetting: vi.fn(),
}))

vi.mock('@/lib/portal/notifications', () => ({
  createPortalNotification: vi.fn().mockResolvedValue(undefined),
}))

import {
  isNewDocumentAlertEnabled,
  notifyClientsOfNewDocument,
  getNewDocumentIds,
  getUnopenedDocsCount,
} from '@/lib/portal/document-alerts'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { getAppSetting } from '@/lib/settings'
import { createPortalNotification } from '@/lib/portal/notifications'

/**
 * Chainable Supabase mock. Builder methods return the chain; `.single()` resolves
 * `single` and awaiting the chain resolves `list`. The documents chain flips to
 * `updated` once `.update()` is called (so select-then-single returns the doc, but
 * update-then-single returns the claimed row).
 */
function chain(opts: { single?: unknown; list?: unknown[]; updated?: unknown }) {
  let isUpdate = false
  const c: Record<string, unknown> = {
    select: vi.fn(() => c),
    update: vi.fn(() => { isUpdate = true; return c }),
    upsert: vi.fn(() => Promise.resolve({ data: null, error: null })),
    eq: vi.fn(() => c),
    is: vi.fn(() => c),
    in: vi.fn(() => c),
    not: vi.fn(() => c),
    or: vi.fn(() => c),
    single: vi.fn(() => Promise.resolve({ data: isUpdate ? (opts.updated ?? null) : (opts.single ?? null), error: null })),
    then: (resolve: (v: { data: unknown[]; error: null }) => unknown) => resolve({ data: opts.list ?? [], error: null }),
  }
  return c
}

function mockTables(map: Record<string, ReturnType<typeof chain>>) {
  const impl = (table: string) => map[table] ?? chain({})
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  vi.mocked(supabaseAdmin.from).mockImplementation(impl as any)
}

describe('isNewDocumentAlertEnabled', () => {
  beforeEach(() => vi.clearAllMocks())

  it('defaults on, off only when explicitly false', async () => {
    vi.mocked(getAppSetting).mockResolvedValueOnce(true)
    expect(await isNewDocumentAlertEnabled()).toBe(true)
    vi.mocked(getAppSetting).mockResolvedValueOnce(false)
    expect(await isNewDocumentAlertEnabled()).toBe(false)
  })
})

describe('notifyClientsOfNewDocument', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getAppSetting).mockResolvedValue(true) // feature on
  })

  it('skips when the feature is disabled', async () => {
    vi.mocked(getAppSetting).mockResolvedValue(false)
    const r = await notifyClientsOfNewDocument('doc-1')
    expect(r).toEqual({ notified: false, reason: 'feature_disabled' })
    expect(createPortalNotification).not.toHaveBeenCalled()
  })

  it('skips a document that is not portal-visible', async () => {
    mockTables({ documents: chain({ single: { id: 'd', portal_visible: false, notify_client: true, client_notified_at: null } }) })
    const r = await notifyClientsOfNewDocument('d')
    expect(r.reason).toBe('not_visible')
    expect(createPortalNotification).not.toHaveBeenCalled()
  })

  it('skips when notify_client is false (quiet upload)', async () => {
    mockTables({ documents: chain({ single: { id: 'd', portal_visible: true, notify_client: false, client_notified_at: null } }) })
    const r = await notifyClientsOfNewDocument('d')
    expect(r.reason).toBe('notify_disabled')
    expect(createPortalNotification).not.toHaveBeenCalled()
  })

  it('skips a document already notified (idempotent)', async () => {
    mockTables({ documents: chain({ single: { id: 'd', portal_visible: true, notify_client: true, client_notified_at: '2026-06-06T00:00:00Z' } }) })
    const r = await notifyClientsOfNewDocument('d')
    expect(r.reason).toBe('already_notified')
    expect(createPortalNotification).not.toHaveBeenCalled()
  })

  it('notifies the ACCOUNT for a company document (category 1)', async () => {
    mockTables({
      documents: chain({
        single: { id: 'd', file_name: 'OA.pdf', account_id: 'acct-1', contact_id: null, category: 1, portal_visible: true, notify_client: true, client_notified_at: null },
        updated: { id: 'd' },
      }),
      account_contacts: chain({ list: [{ role: 'owner', contacts: { language: 'en' } }] }),
    })
    const r = await notifyClientsOfNewDocument('d')
    expect(r).toEqual({ notified: true })
    expect(createPortalNotification).toHaveBeenCalledTimes(1)
    const arg = vi.mocked(createPortalNotification).mock.calls[0][0]
    expect(arg.account_id).toBe('acct-1')
    expect(arg.type).toBe('new_document')
    expect(arg.link).toBe('/portal/documents')
  })

  it('notifies the CONTACT for a personal document (category 2) in their language', async () => {
    mockTables({
      documents: chain({
        single: { id: 'd', file_name: 'Passport.pdf', account_id: 'acct-1', contact_id: 'c-1', category: 2, portal_visible: true, notify_client: true, client_notified_at: null },
        updated: { id: 'd' },
      }),
      contacts: chain({ single: { language: 'it' } }),
    })
    const r = await notifyClientsOfNewDocument('d')
    expect(r).toEqual({ notified: true })
    const arg = vi.mocked(createPortalNotification).mock.calls[0][0]
    expect(arg.contact_id).toBe('c-1')
    expect(arg.title).toBe('Nuovo documento disponibile') // Italian
  })

  it('does not notify twice when the claim is lost (race)', async () => {
    mockTables({
      documents: chain({
        single: { id: 'd', file_name: 'x.pdf', account_id: 'acct-1', contact_id: null, category: 1, portal_visible: true, notify_client: true, client_notified_at: null },
        updated: null, // update's .single() returns null -> claim lost
      }),
    })
    const r = await notifyClientsOfNewDocument('d')
    expect(r.reason).toBe('race_lost')
    expect(createPortalNotification).not.toHaveBeenCalled()
  })
})

describe('getNewDocumentIds', () => {
  beforeEach(() => vi.clearAllMocks())

  it('returns eligible docs minus the ones the contact has viewed', async () => {
    mockTables({
      documents: chain({ list: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] }), // eligible (notified)
      portal_document_views: chain({ list: [{ document_id: 'b' }] }), // viewed
    })
    const out = await getNewDocumentIds(['a', 'b', 'c'], 'contact-1')
    expect(Array.from(out).sort()).toEqual(['a', 'c'])
  })

  it('returns empty for no documents', async () => {
    expect((await getNewDocumentIds([], 'contact-1')).size).toBe(0)
  })
})

describe('getUnopenedDocsCount', () => {
  beforeEach(() => vi.clearAllMocks())

  it('counts eligible company + personal docs minus viewed', async () => {
    // documents.from is called twice (company, then personal). Return company
    // docs first, personal second via a sequence.
    const company = chain({ list: [{ id: 'a', category: 1 }, { id: 'b', category: 2 }] }) // 'b' is personal -> excluded from company
    const personal = chain({ list: [{ id: 'p' }] })
    let docCall = 0
    const impl = (table: string) => {
      if (table === 'documents') return (docCall++ === 0 ? company : personal)
      if (table === 'portal_document_views') return chain({ list: [{ document_id: 'a' }] }) // 'a' already viewed
      return chain({})
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(supabaseAdmin.from).mockImplementation(impl as any)

    // eligible = {a (company), p (personal)}; viewed = {a}; unopened = {p} -> 1
    const n = await getUnopenedDocsCount('contact-1', ['acct-1'])
    expect(n).toBe(1)
  })

  it('returns 0 for no contact', async () => {
    expect(await getUnopenedDocsCount('', ['acct-1'])).toBe(0)
  })
})
