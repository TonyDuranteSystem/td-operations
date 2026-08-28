/**
 * The "Discuss with AI" offer-narrative box's read-only email lookup
 * (dev job 3c1bb5fa, 2026-08-28) — Antonio asked it to "read the email from
 * francesco" and it correctly said it had nothing to read, since the box
 * never received any lead/contact/account link or email-reading capability
 * at all. This pins the fix: resolveSubjectEmail() finds who the offer is
 * for, and findRelevantEmailContext() only calls out to Gmail (via the same
 * read-only tools the dashboard's AI worker already uses) when the
 * instruction actually needs it — and degrades to "no context" on anything
 * unresolved or any failure, never throwing into the caller.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  contactsRow: null as { email: string } | null,
  leadsRow: null as { email: string } | null,
  primaryContactResult: { outcome: 'not_found' } as
    | { outcome: 'not_found' }
    | { outcome: 'resolved'; contact: { id: string; full_name: string; email: string | null; portal_tier: string | null; portal_role: string | null }; source: 'members' | 'account_contacts' },
  classifyResponse: '{"needs_email": false}',
  searchResponse: JSON.stringify({ results: [], total: 0, message: 'No emails found matching the search query.' }),
  threadResponse: JSON.stringify({ thread_id: 't1', messages: [] }),
  toolCalls: [] as Array<{ name: string; params: unknown }>,
  throwOnClassify: false,
}))

vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: {
    from: vi.fn((table: string) => ({
      select: vi.fn(() => ({
        eq: vi.fn(() => ({
          maybeSingle: vi.fn(async () => ({
            data: table === 'contacts' ? h.contactsRow : table === 'leads' ? h.leadsRow : null,
            error: null,
          })),
        })),
      })),
    })),
  },
}))

vi.mock('@/lib/members/resolve-primary-contact', () => ({
  resolvePrimaryContact: vi.fn(async () => h.primaryContactResult),
}))

vi.mock('@/lib/portal/ai-provider', () => ({
  callAI: vi.fn(async () => {
    if (h.throwOnClassify) throw new Error('AI provider unavailable')
    return { text: h.classifyResponse }
  }),
}))

vi.mock('@/lib/ai-agent/tools', () => ({
  executeTool: vi.fn(async (name: string, params: unknown) => {
    h.toolCalls.push({ name, params })
    if (name === 'gmail_search') return h.searchResponse
    if (name === 'gmail_read_thread') return h.threadResponse
    return JSON.stringify({ error: `unexpected tool ${name}` })
  }),
}))

import { resolveSubjectEmail, findRelevantEmailContext } from '@/lib/offers/narrative-email-context'

beforeEach(() => {
  h.contactsRow = null
  h.leadsRow = null
  h.primaryContactResult = { outcome: 'not_found' }
  h.classifyResponse = '{"needs_email": false}'
  h.searchResponse = JSON.stringify({ results: [], total: 0, message: 'No emails found matching the search query.' })
  h.threadResponse = JSON.stringify({ thread_id: 't1', messages: [] })
  h.toolCalls = []
  h.throwOnClassify = false
  vi.clearAllMocks()
})

describe('resolveSubjectEmail', () => {
  it('prefers the contact email when a contact_id is given', async () => {
    h.contactsRow = { email: 'francesco@example.com' }
    h.leadsRow = { email: 'lead@example.com' }
    const email = await resolveSubjectEmail({ contactId: 'c1', leadId: 'l1', accountId: 'a1' })
    expect(email).toBe('francesco@example.com')
  })

  it('falls back to the lead email when there is no contact', async () => {
    h.leadsRow = { email: 'lead@example.com' }
    const email = await resolveSubjectEmail({ contactId: null, leadId: 'l1', accountId: null })
    expect(email).toBe('lead@example.com')
  })

  it('falls back to the account\'s primary contact when there is no contact or lead', async () => {
    h.primaryContactResult = {
      outcome: 'resolved',
      contact: { id: 'c2', full_name: 'Primary Person', email: 'primary@example.com', portal_tier: 'active', portal_role: null },
      source: 'members',
    }
    const email = await resolveSubjectEmail({ contactId: null, leadId: null, accountId: 'a1' })
    expect(email).toBe('primary@example.com')
  })

  it('returns undefined when nothing resolves', async () => {
    const email = await resolveSubjectEmail({ contactId: null, leadId: null, accountId: null })
    expect(email).toBeUndefined()
  })

  it('returns undefined instead of throwing when the primary-contact lookup errors', async () => {
    const { resolvePrimaryContact } = await import('@/lib/members/resolve-primary-contact')
    vi.mocked(resolvePrimaryContact).mockRejectedValueOnce(new Error('db down'))
    const email = await resolveSubjectEmail({ contactId: null, leadId: null, accountId: 'a1' })
    expect(email).toBeUndefined()
  })
})

describe('findRelevantEmailContext', () => {
  it('returns undefined immediately with no subject email — never calls the AI or Gmail', async () => {
    const result = await findRelevantEmailContext('read the email from francesco', undefined)
    expect(result).toBeUndefined()
    expect(h.toolCalls).toEqual([])
  })

  it('skips the Gmail lookup entirely when the classifier says none is needed', async () => {
    h.classifyResponse = '{"needs_email": false}'
    const result = await findRelevantEmailContext('shorten the intro', 'francesco@example.com')
    expect(result).toBeUndefined()
    expect(h.toolCalls).toEqual([])
  })

  it('searches scoped to the subject email and reads the top matching thread', async () => {
    h.classifyResponse = '{"needs_email": true, "query": "company type"}'
    h.searchResponse = JSON.stringify({
      results: [{ id: 'm1', thread_id: 'thread-123', subject: 'Re: LLC setup' }],
      total: 1,
    })
    h.threadResponse = JSON.stringify({
      thread_id: 'thread-123',
      messages: [
        { from: 'Francesco <francesco@example.com>', to: 'support@tonydurante.us', subject: 'Re: LLC setup', date: 'Mon', body: 'I want a multi-member LLC in Wyoming.' },
      ],
    })
    const result = await findRelevantEmailContext('read the email from francesco', 'francesco@example.com')
    expect(result).toContain('multi-member LLC in Wyoming')

    const searchCall = h.toolCalls.find((c) => c.name === 'gmail_search')
    expect(searchCall).toBeDefined()
    const searchParams = searchCall!.params as { query: string }
    expect(searchParams.query).toContain('from:francesco@example.com OR to:francesco@example.com')

    const threadCall = h.toolCalls.find((c) => c.name === 'gmail_read_thread')
    expect(threadCall!.params).toEqual({ thread_id: 'thread-123' })
  })

  it('returns undefined when the search finds nothing, without calling gmail_read_thread', async () => {
    h.classifyResponse = '{"needs_email": true, "query": "company type"}'
    h.searchResponse = JSON.stringify({ results: [], total: 0, message: 'No emails found matching the search query.' })
    const result = await findRelevantEmailContext('read the email from francesco', 'francesco@example.com')
    expect(result).toBeUndefined()
    expect(h.toolCalls.some((c) => c.name === 'gmail_read_thread')).toBe(false)
  })

  it('degrades to no context, never throwing, when the classifier call fails', async () => {
    h.throwOnClassify = true
    const result = await findRelevantEmailContext('read the email from francesco', 'francesco@example.com')
    expect(result).toBeUndefined()
  })

  it('truncates a very long thread so the refine prompt stays bounded', async () => {
    h.classifyResponse = '{"needs_email": true, "query": "pricing"}'
    h.searchResponse = JSON.stringify({ results: [{ id: 'm1', thread_id: 'thread-long' }], total: 1 })
    h.threadResponse = JSON.stringify({
      thread_id: 'thread-long',
      messages: [{ from: 'a@b.com', to: 'c@d.com', subject: 'x', date: 'y', body: 'z'.repeat(10000) }],
    })
    const result = await findRelevantEmailContext('summarize what was said', 'a@b.com')
    expect(result!.length).toBeLessThanOrEqual(6000)
  })
})
