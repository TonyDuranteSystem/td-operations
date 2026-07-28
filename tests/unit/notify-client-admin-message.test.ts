import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: {
    from: vi.fn(),
  },
}))

vi.mock('@/lib/config', () => ({
  PORTAL_BASE_URL: 'https://portal.tonydurante.us',
}))

vi.mock('@/lib/gmail', () => ({
  gmailPost: vi.fn().mockResolvedValue({}),
}))

vi.mock('@/lib/portal/web-push', () => ({
  sendPushToAccount: vi.fn(),
  sendPushToContact: vi.fn(),
}))

vi.mock('@/lib/gmail-labels', () => ({
  labelPortalChatNotification: vi.fn(),
}))

import { notifyClientOfAdminMessage, dedupeRecipientsByEmail } from '@/lib/portal/notifications'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { gmailPost } from '@/lib/gmail'
import { labelPortalChatNotification } from '@/lib/gmail-labels'

function extractMimeSubject(raw: string): string {
  const mime = Buffer.from(raw, 'base64url').toString('utf-8')
  for (const line of mime.split('\r\n')) {
    if (line.startsWith('Subject: ')) {
      const val = line.slice('Subject: '.length)
      const match = val.match(/=\?utf-8\?B\?(.+?)\?=/)
      if (match) return Buffer.from(match[1], 'base64').toString('utf-8')
      return val
    }
  }
  return ''
}

function extractMimeHtmlBody(raw: string): string {
  const mime = Buffer.from(raw, 'base64url').toString('utf-8')
  const lines = mime.split('\r\n')
  let afterEncHeader = false
  let afterBlank = false
  for (const line of lines) {
    if (line === 'Content-Transfer-Encoding: base64') { afterEncHeader = true; continue }
    if (afterEncHeader && line === '') { afterBlank = true; continue }
    if (afterBlank && line && !line.startsWith('--')) {
      return Buffer.from(line, 'base64').toString('utf-8')
    }
    if (afterBlank && line.startsWith('--')) break
  }
  return ''
}

function extractMimeTo(raw: string): string {
  const mime = Buffer.from(raw, 'base64url').toString('utf-8')
  for (const line of mime.split('\r\n')) {
    if (line.startsWith('To: ')) return line.slice('To: '.length)
  }
  return ''
}

// A chainable + awaitable Supabase mock chain. Supports .select().eq()...,
// chained .eq().eq(), terminal .single(), and `await chain` (thenable) — so it
// works for the contact_id (.single()) path AND both array paths (account_contacts,
// portal_team_members) which await the builder directly.
function makeChain(data: unknown, count?: number) {
  const result = { data, error: null, count: count ?? null }
  const chain: Record<string, unknown> = {
    select: vi.fn(() => chain),
    eq: vi.fn(() => chain),
    single: vi.fn().mockResolvedValue(result),
    then: (resolve: (v: typeof result) => unknown) => resolve(result),
  }
  return chain
}

// A push_subscriptions chain that answers differently for the contact-level
// (.eq('contact_id',…)) and account-level (.eq('account_id',…)) count checks.
function makePushChain(counts: { contact?: number; account?: number }) {
  let col: string | null = null
  const chain: Record<string, unknown> = {
    select: vi.fn(() => chain),
    eq: vi.fn((c: string) => { col = c; return chain }),
    then: (resolve: (v: { data: null; error: null; count: number }) => unknown) =>
      resolve({ data: null, error: null, count: col === 'contact_id' ? (counts.contact ?? 0) : (counts.account ?? 0) }),
  }
  return chain
}

// Dispatch the mocked supabaseAdmin.from(table) to per-table data.
// pushSubs simulates the push_subscriptions count check (0 = no push → email sent).
// pushSubsByCol distinguishes contact-level vs account-level subscription counts.
function mockDb(opts: { contact?: unknown; accountContacts?: unknown[]; teammates?: unknown[]; pushSubs?: number; pushSubsByCol?: { contact?: number; account?: number } }) {
  vi.mocked(supabaseAdmin.from).mockImplementation(((table: string) => {
    if (table === 'contacts') return makeChain(opts.contact ?? null)
    if (table === 'account_contacts') return makeChain(opts.accountContacts ?? [])
    if (table === 'portal_team_members') return makeChain(opts.teammates ?? [])
    if (table === 'push_subscriptions') {
      if (opts.pushSubsByCol) return makePushChain(opts.pushSubsByCol)
      return makeChain(null, opts.pushSubs ?? 0)
    }
    return makeChain(null)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any)
}

describe('dedupeRecipientsByEmail', () => {
  it('keeps the first occurrence and drops later duplicates (case-insensitive)', () => {
    const out = dedupeRecipientsByEmail([
      { email: 'a@x.com', tag: 'first' },
      { email: 'A@X.com', tag: 'dup' },
      { email: 'b@x.com', tag: 'keep' },
    ])
    expect(out.map(r => r.tag)).toEqual(['first', 'keep'])
  })

  it('returns empty for empty input', () => {
    expect(dedupeRecipientsByEmail([])).toEqual([])
  })
})

describe('notifyClientOfAdminMessage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('sends one email when contact_id is provided', async () => {
    mockDb({ contact: { email: 'test@example.com', full_name: 'Mario Rossi', language: 'en' } })

    await notifyClientOfAdminMessage({ contact_id: 'contact-123', messagePreview: 'Hello, your invoice is ready.' })

    expect(gmailPost).toHaveBeenCalledOnce()
    const { raw } = vi.mocked(gmailPost).mock.calls[0][1] as { raw: string }
    expect(extractMimeTo(raw)).toBe('test@example.com')
  })

  it('files the sent copy under the portal chat label', async () => {
    mockDb({ contact: { email: 'label@example.com', full_name: 'Label Test', language: 'en' } })
    vi.mocked(gmailPost).mockResolvedValue({ id: 'sent-msg-1' })

    await notifyClientOfAdminMessage({ contact_id: 'contact-label-1', messagePreview: 'Label me.' })

    expect(labelPortalChatNotification).toHaveBeenCalledWith('sent-msg-1')
  })

  it('sends Italian subject when contact language is it', async () => {
    mockDb({ contact: { email: 'mario@example.com', full_name: 'Mario Rossi', language: 'it' } })

    await notifyClientOfAdminMessage({ contact_id: 'contact-456', messagePreview: 'Ciao.' })

    const { raw } = vi.mocked(gmailPost).mock.calls[0][1] as { raw: string }
    expect(extractMimeSubject(raw)).toBe('Nuovo messaggio dal team Tony Durante')
  })

  it('does not send when contact has no email', async () => {
    mockDb({ contact: { email: null, full_name: 'No Email', language: 'en' } })

    await notifyClientOfAdminMessage({ contact_id: 'contact-789', messagePreview: 'Test' })

    expect(gmailPost).not.toHaveBeenCalled()
  })

  it('does nothing when neither account_id nor contact_id provided', async () => {
    await notifyClientOfAdminMessage({ messagePreview: 'Test' })

    expect(gmailPost).not.toHaveBeenCalled()
    expect(supabaseAdmin.from).not.toHaveBeenCalled()
  })

  it('truncates long message preview to 200 chars', async () => {
    mockDb({ contact: { email: 'test@example.com', full_name: 'Test User', language: 'en' } })

    await notifyClientOfAdminMessage({ contact_id: 'contact-trunc', messagePreview: 'A'.repeat(500) })

    const { raw } = vi.mocked(gmailPost).mock.calls[0][1] as { raw: string }
    const html = extractMimeHtmlBody(raw)
    expect(html).toContain('A'.repeat(200))
    expect(html).not.toContain('A'.repeat(201))
  })

  // ── Multi-Member LLC tests (account_id path) ────────────────────────────

  it('sends one email for single-contact account', async () => {
    mockDb({ accountContacts: [{ contacts: { email: 'bence@example.com', full_name: 'Bence Koncz', language: 'en' } }] })

    await notifyClientOfAdminMessage({ account_id: 'account-abc', messagePreview: 'Hello' })

    expect(gmailPost).toHaveBeenCalledOnce()
    const { raw } = vi.mocked(gmailPost).mock.calls[0][1] as { raw: string }
    expect(extractMimeTo(raw)).toBe('bence@example.com')
  })

  it('sends separate emails to ALL contacts for Multi-Member LLC', async () => {
    mockDb({ accountContacts: [
      { contacts: { email: 'bence@example.com', full_name: 'Bence Koncz', language: 'en' } },
      { contacts: { email: 'donat@example.com', full_name: 'Donat Percsi', language: 'en' } },
    ] })

    await notifyClientOfAdminMessage({ account_id: 'account-mmllc', messagePreview: 'New message' })

    expect(gmailPost).toHaveBeenCalledTimes(2)
    const recipients = vi.mocked(gmailPost).mock.calls.map(c => extractMimeTo((c[1] as { raw: string }).raw))
    expect(recipients).toContain('bence@example.com')
    expect(recipients).toContain('donat@example.com')
  })

  it('personalizes greeting per recipient in MMLLC', async () => {
    mockDb({ accountContacts: [
      { contacts: { email: 'bence@example.com', full_name: 'Bence Koncz', language: 'en' } },
      { contacts: { email: 'donat@example.com', full_name: 'Donat Tamas Percsi', language: 'en' } },
    ] })

    await notifyClientOfAdminMessage({ account_id: 'account-mmllc-greet', messagePreview: 'Test' })

    const htmls = vi.mocked(gmailPost).mock.calls.map(c => extractMimeHtmlBody((c[1] as { raw: string }).raw))
    const benceHtml = htmls.find(h => h.includes('Bence'))
    const donatHtml = htmls.find(h => h.includes('Donat'))
    expect(benceHtml).toBeTruthy()
    expect(donatHtml).toBeTruthy()
    expect(benceHtml).not.toContain('Donat')
    expect(donatHtml).not.toContain('Bence')
  })

  it('skips contacts with null email in MMLLC, sends to the rest', async () => {
    mockDb({ accountContacts: [
      { contacts: { email: 'bence@example.com', full_name: 'Bence Koncz', language: 'en' } },
      { contacts: null },
      { contacts: { email: null, full_name: 'No Email', language: 'en' } },
    ] })

    await notifyClientOfAdminMessage({ account_id: 'account-partial', messagePreview: 'Test' })

    expect(gmailPost).toHaveBeenCalledOnce()
    const { raw } = vi.mocked(gmailPost).mock.calls[0][1] as { raw: string }
    expect(extractMimeTo(raw)).toBe('bence@example.com')
  })

  it('does nothing when account has no contacts with emails and no teammates', async () => {
    mockDb({ accountContacts: [] })

    await notifyClientOfAdminMessage({ account_id: 'account-empty', messagePreview: 'Test' })

    expect(gmailPost).not.toHaveBeenCalled()
  })

  it('sends Italian to Italian contacts and English to English in mixed MMLLC', async () => {
    mockDb({ accountContacts: [
      { contacts: { email: 'en@example.com', full_name: 'English Member', language: 'en' } },
      { contacts: { email: 'it@example.com', full_name: 'Membro Italiano', language: 'it' } },
    ] })

    await notifyClientOfAdminMessage({ account_id: 'account-mixed-lang', messagePreview: 'Test' })

    expect(gmailPost).toHaveBeenCalledTimes(2)
    const subjects = vi.mocked(gmailPost).mock.calls.map(c => extractMimeSubject((c[1] as { raw: string }).raw))
    expect(subjects).toContain('New message from the Tony Durante team')
    expect(subjects).toContain('Nuovo messaggio dal team Tony Durante')
  })

  // ── Portal Team Access teammate notifications (account_id path) ──────────

  it('also emails an active teammate with chat capability and a real email', async () => {
    mockDb({
      accountContacts: [{ contacts: { email: 'owner@example.com', full_name: 'Owner One', language: 'en' } }],
      teammates: [{ email: 'teammate@example.com', display_name: 'QA Teammate', capabilities: { chat: true, documents: true }, status: 'active' }],
    })

    await notifyClientOfAdminMessage({ account_id: 'account-team-1', messagePreview: 'Reply' })

    expect(gmailPost).toHaveBeenCalledTimes(2)
    const recipients = vi.mocked(gmailPost).mock.calls.map(c => extractMimeTo((c[1] as { raw: string }).raw))
    expect(recipients).toContain('owner@example.com')
    expect(recipients).toContain('teammate@example.com')
  })

  it('does NOT email a teammate without the chat capability', async () => {
    mockDb({
      accountContacts: [{ contacts: { email: 'owner@example.com', full_name: 'Owner', language: 'en' } }],
      teammates: [{ email: 'docsonly@example.com', display_name: 'Docs Only', capabilities: { documents: true }, status: 'active' }],
    })

    await notifyClientOfAdminMessage({ account_id: 'account-team-2', messagePreview: 'Reply' })

    expect(gmailPost).toHaveBeenCalledOnce()
    expect(extractMimeTo((vi.mocked(gmailPost).mock.calls[0][1] as { raw: string }).raw)).toBe('owner@example.com')
  })

  it('does NOT email a revoked teammate even with chat capability', async () => {
    mockDb({
      accountContacts: [{ contacts: { email: 'owner@example.com', full_name: 'Owner', language: 'en' } }],
      teammates: [{ email: 'revoked@example.com', display_name: 'Revoked', capabilities: { chat: true }, status: 'revoked' }],
    })

    await notifyClientOfAdminMessage({ account_id: 'account-team-3', messagePreview: 'Reply' })

    expect(gmailPost).toHaveBeenCalledOnce()
    expect(extractMimeTo((vi.mocked(gmailPost).mock.calls[0][1] as { raw: string }).raw)).toBe('owner@example.com')
  })

  it('does NOT email a chat teammate with a null (owner-omitted) email', async () => {
    mockDb({
      accountContacts: [{ contacts: { email: 'owner@example.com', full_name: 'Owner', language: 'en' } }],
      teammates: [{ email: null, display_name: 'No Email', capabilities: { chat: true }, status: 'active' }],
    })

    await notifyClientOfAdminMessage({ account_id: 'account-team-4', messagePreview: 'Reply' })

    expect(gmailPost).toHaveBeenCalledOnce()
    expect(extractMimeTo((vi.mocked(gmailPost).mock.calls[0][1] as { raw: string }).raw)).toBe('owner@example.com')
  })

  it('emails a chat teammate even when the account has no contacts', async () => {
    mockDb({
      accountContacts: [],
      teammates: [{ email: 'solo.teammate@example.com', display_name: 'Solo', capabilities: { chat: true }, status: 'active' }],
    })

    await notifyClientOfAdminMessage({ account_id: 'account-team-5', messagePreview: 'Reply' })

    expect(gmailPost).toHaveBeenCalledOnce()
    expect(extractMimeTo((vi.mocked(gmailPost).mock.calls[0][1] as { raw: string }).raw)).toBe('solo.teammate@example.com')
  })

  it('dedupes a teammate sharing a contact email (one email, not two)', async () => {
    mockDb({
      accountContacts: [{ contacts: { email: 'shared@example.com', full_name: 'Shared Person', language: 'en' } }],
      teammates: [{ email: 'Shared@example.com', display_name: 'Shared Teammate', capabilities: { chat: true }, status: 'active' }],
    })

    await notifyClientOfAdminMessage({ account_id: 'account-team-6', messagePreview: 'Reply' })

    expect(gmailPost).toHaveBeenCalledOnce()
    expect(extractMimeTo((vi.mocked(gmailPost).mock.calls[0][1] as { raw: string }).raw)).toBe('shared@example.com')
  })

  it("emails the teammate in the OWNER's language (Italian owner -> Italian teammate)", async () => {
    mockDb({
      accountContacts: [{ role: 'owner', contacts: { email: 'owner@example.com', full_name: 'Proprietario', language: 'it' } }],
      teammates: [{ email: 'teammate@example.com', display_name: 'Collega', capabilities: { chat: true }, status: 'active' }],
    })

    await notifyClientOfAdminMessage({ account_id: 'account-team-lang-it', messagePreview: 'Reply' })

    expect(gmailPost).toHaveBeenCalledTimes(2)
    const teammateCall = vi.mocked(gmailPost).mock.calls.find(c => extractMimeTo((c[1] as { raw: string }).raw) === 'teammate@example.com')!
    expect(teammateCall).toBeTruthy()
    expect(extractMimeSubject((teammateCall[1] as { raw: string }).raw)).toBe('Nuovo messaggio dal team Tony Durante')
  })

  it("emails the teammate in the OWNER's language (English owner -> English teammate)", async () => {
    mockDb({
      accountContacts: [{ role: 'owner', contacts: { email: 'owner@example.com', full_name: 'Owner', language: 'en' } }],
      teammates: [{ email: 'teammate@example.com', display_name: 'Mate', capabilities: { chat: true }, status: 'active' }],
    })

    await notifyClientOfAdminMessage({ account_id: 'account-team-lang-en', messagePreview: 'Reply' })

    const teammateCall = vi.mocked(gmailPost).mock.calls.find(c => extractMimeTo((c[1] as { raw: string }).raw) === 'teammate@example.com')!
    expect(teammateCall).toBeTruthy()
    expect(extractMimeSubject((teammateCall[1] as { raw: string }).raw)).toBe('New message from the Tony Durante team')
  })

  it('teammate follows owner language even when a non-owner contact has a different language', async () => {
    mockDb({
      accountContacts: [
        { role: 'member', contacts: { email: 'member@example.com', full_name: 'Membro', language: 'en' } },
        { role: 'owner', contacts: { email: 'owner@example.com', full_name: 'Proprietario', language: 'it' } },
      ],
      teammates: [{ email: 'teammate@example.com', display_name: 'Collega', capabilities: { chat: true }, status: 'active' }],
    })

    await notifyClientOfAdminMessage({ account_id: 'account-team-lang-mixed', messagePreview: 'Reply' })

    const teammateCall = vi.mocked(gmailPost).mock.calls.find(c => extractMimeTo((c[1] as { raw: string }).raw) === 'teammate@example.com')!
    expect(extractMimeSubject((teammateCall[1] as { raw: string }).raw)).toBe('Nuovo messaggio dal team Tony Durante')
  })

  // ── Push-subscription skip (PWA installed → email is redundant) ──────────

  it('skips the email when the contact has an active push subscription', async () => {
    mockDb({
      contact: { email: 'pwa@example.com', full_name: 'PWA User', language: 'en' },
      pushSubs: 1,
    })

    await notifyClientOfAdminMessage({ contact_id: 'contact-pwa', messagePreview: 'You have a new message.' })

    expect(gmailPost).not.toHaveBeenCalled()
  })

  it('sends the email when the contact has no push subscription', async () => {
    mockDb({
      contact: { email: 'nopwa@example.com', full_name: 'No PWA', language: 'en' },
      pushSubs: 0,
    })

    await notifyClientOfAdminMessage({ contact_id: 'contact-nopwa', messagePreview: 'You have a new message.' })

    expect(gmailPost).toHaveBeenCalledOnce()
    expect(extractMimeTo((vi.mocked(gmailPost).mock.calls[0][1] as { raw: string }).raw)).toBe('nopwa@example.com')
  })

  it('skips the email via the contact-level push check (account path)', async () => {
    mockDb({
      accountContacts: [{ contacts: { id: 'c-pwa', email: 'acct@example.com', full_name: 'Acct Owner', language: 'en' } }],
      pushSubs: 1,
    })

    await notifyClientOfAdminMessage({ account_id: 'account-pwa', messagePreview: 'New message' })

    expect(gmailPost).not.toHaveBeenCalled()
  })

  it('multi-member: one member\'s account-level subscription does NOT silence the other member\'s email', async () => {
    // Council bug-hunter regression (2026-07-28): on an MMLLC, member A
    // subscribing must not cut member B off from both push AND email. The
    // account-level subscription is unattributable, so with >1 recipient each
    // person needs their OWN contact-level subscription to skip the email.
    mockDb({
      accountContacts: [
        { contacts: { id: 'c-a', email: 'member-a@example.com', full_name: 'Member A', language: 'en' } },
        { contacts: { id: 'c-b', email: 'member-b@example.com', full_name: 'Member B', language: 'en' } },
      ],
      pushSubsByCol: { contact: 0, account: 1 },
    })

    await notifyClientOfAdminMessage({ account_id: 'account-mmllc-blackout', messagePreview: 'New message' })

    const tos = vi.mocked(gmailPost).mock.calls.map(c => extractMimeTo((c[1] as { raw: string }).raw))
    expect(tos.sort()).toEqual(['member-a@example.com', 'member-b@example.com'])
  })

  it('solo owner: a legacy account-level subscription still skips the email', async () => {
    mockDb({
      accountContacts: [
        { contacts: { id: 'c-solo', email: 'solo@example.com', full_name: 'Solo Owner', language: 'en' } },
      ],
      pushSubsByCol: { contact: 0, account: 1 },
    })

    await notifyClientOfAdminMessage({ account_id: 'account-solo-legacy', messagePreview: 'New message' })

    expect(gmailPost).not.toHaveBeenCalled()
  })

  it('skips the email via the account-level push check when the recipient has no contact id (teammate)', async () => {
    mockDb({
      accountContacts: [],
      teammates: [{ email: 'teammate@example.com', display_name: 'Mate', capabilities: { chat: true }, status: 'active' }],
      pushSubs: 1,
    })

    await notifyClientOfAdminMessage({ account_id: 'account-team-pwa', messagePreview: 'New message' })

    expect(gmailPost).not.toHaveBeenCalled()
  })
})
