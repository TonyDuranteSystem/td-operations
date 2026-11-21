/**
 * A notice about a company, addressed to ONE named person whose link to that company carries the "no portal access" mark, is never
 * sent on any channel (dev job beb43385, QA 21 Nov 2026 — the "Sign your SS-4" alert reached an unticked signer who could not open
 * the company). Company-wide senders already skipped marked links; these are the named-person paths.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({ marked: false, froms: [] as string[], inserts: [] as Array<{ table: string; row: unknown }>, gmailPost: vi.fn(async () => ({})) }))

vi.mock('@/lib/members/marked-on-company', () => ({
  isMarkedOnCompany: vi.fn(async () => h.marked),
  markedContactIds: vi.fn(async () => new Set<string>()),
}))
vi.mock('@/lib/portal/web-push', () => ({
  sendPushToContact: vi.fn().mockResolvedValue(undefined),
  sendPushToAccount: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@/lib/gmail', () => ({ gmailPost: h.gmailPost }))
vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: {
    from: (table: string) => {
      h.froms.push(table)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const b: any = {}
      for (const m of ['select', 'eq', 'gt', 'in', 'neq', 'is', 'limit', 'order']) b[m] = () => b
      b.maybeSingle = () => Promise.resolve({ data: table === 'contacts' ? { id: 'c', email: 'm2@x.com', full_name: 'M Two', language: 'English' } : null, error: null })
      b.single = b.maybeSingle
      b.insert = (row: unknown) => { h.inserts.push({ table, row }); return Promise.resolve({ error: null }) }
      b.then = (resolve: (v: unknown) => unknown) => resolve({ data: [], count: 0, error: null })
      return b
    },
  },
}))

import { createPortalNotification, notifyClientOfAdminMessage, notifyClientOfStageAdvance } from '@/lib/portal/notifications'
import { notifyClientActionRequired } from '@/lib/portal/action-required'

beforeEach(() => { h.marked = false; h.froms = []; h.inserts = []; h.gmailPost.mockClear() })

describe('createPortalNotification', () => {
  it('a notice for a company, addressed to a marked person, is not created (no bell, no digest email, no push)', async () => {
    h.marked = true
    const r = await createPortalNotification({ account_id: 'acc', contact_id: 'c', type: 't', title: 'x' })
    expect(r).toEqual({ error: null, skipped: 'no_portal_access' })
    expect(h.inserts).toEqual([])
  })

  it('an open person gets it as before', async () => {
    const r = await createPortalNotification({ account_id: 'acc', contact_id: 'c', type: 't', title: 'x' })
    expect(r.error).toBeNull()
    expect(r.skipped).toBeUndefined()
    expect(h.inserts).toHaveLength(1)
  })

  it('a personal notice with no company is untouched (nothing to hide)', async () => {
    h.marked = true
    await createPortalNotification({ contact_id: 'c', type: 't', title: 'x' })
    expect(h.inserts).toHaveLength(1)
  })
})

describe('the email senders addressed to a named person', () => {
  it('stage-change email: a marked person gets nothing, and nothing is even looked up', async () => {
    h.marked = true
    const r = await notifyClientOfStageAdvance({ account_id: 'acc', contact_id: 'c', service_name: 'S', stage_name: 'Done' })
    expect(r).toEqual({ sent: 0, failed: 0, skippedHasApp: 0 })
    expect(h.froms).toEqual([])
  })

  it('admin chat message email: a marked person gets nothing', async () => {
    h.marked = true
    await notifyClientOfAdminMessage({ account_id: 'acc', contact_id: 'c', messagePreview: 'hi' })
    expect(h.froms).toEqual([])
  })
})

describe('notifyClientActionRequired', () => {
  const params = {
    account_id: 'acc',
    contact_id: 'c',
    link: '/portal/sign/ss4',
    title: { en: 'Sign your SS-4', it: 'Firma il tuo SS-4' },
    message: { en: 'm', it: 'm' },
  } as unknown as Parameters<typeof notifyClientActionRequired>[0]

  it('is skipped on every channel for a marked person, and nothing is written', async () => {
    h.marked = true
    const r = await notifyClientActionRequired(params)
    expect(r.dispatched).toBe(false)
    expect(r.chat).toMatch(/^skipped: this person has no portal access/)
    expect(r.notification).toBe(r.chat)
    expect(r.email).toBe(r.chat)
    expect(h.inserts).toEqual([])
    expect(h.froms).toEqual([])
  })

  // The Operating Agreement co-signer: signature rows come from the MEMBERS table, a member left out of the portal is still an owner and must
  // still sign, and the personal signing link in the email is their ONLY way to the document (Bug Hunter, QA 21 Nov 2026).
  it('a marked person with a personal signing link (emailLink) still gets that email — but no chat message and no bell', async () => {
    h.marked = true
    const r = await notifyClientActionRequired({ ...(params as object), emailLink: 'https://app.example/operating-agreement/t/c?signer=s' } as Parameters<typeof notifyClientActionRequired>[0])
    expect(h.gmailPost).toHaveBeenCalledTimes(1)
    expect(r.email).toMatch(/^ok/)
    expect(r.chat).toMatch(/^skipped: this person has no portal access/)
    expect(r.notification).toBe(r.chat)
    expect(h.inserts.filter(i => i.table === 'portal_messages' || i.table === 'portal_notifications')).toEqual([])
  })

  it('an open person with an emailed link gets everything, as before', async () => {
    const r = await notifyClientActionRequired({ ...(params as object), emailLink: 'https://app.example/operating-agreement/t/c?signer=s' } as Parameters<typeof notifyClientActionRequired>[0])
    expect(h.gmailPost).toHaveBeenCalledTimes(1)
    expect(r.chat).toBe('ok')
    expect(r.notification).toBe('ok')
  })
})
