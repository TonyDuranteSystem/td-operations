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

import { notifyClientOfAdminMessage } from '@/lib/portal/notifications'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { gmailPost } from '@/lib/gmail'

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

// Builds a mock Supabase chain for single() queries (contact_id path)
function mockSingleContact(data: unknown, error: unknown = null) {
  return {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    single: vi.fn().mockResolvedValue({ data, error }),
    insert: vi.fn().mockResolvedValue({ data, error }),
  }
}

// Builds a mock Supabase chain for array queries (account_id path — no .single())
function mockContactArray(rows: unknown[], error: unknown = null) {
  return {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockResolvedValue({ data: rows, error }),
  }
}

describe('notifyClientOfAdminMessage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('sends one email when contact_id is provided', async () => {
    const chain = mockSingleContact({ email: 'test@example.com', full_name: 'Mario Rossi', language: 'en' })
    vi.mocked(supabaseAdmin.from).mockReturnValue(chain as any)

    await notifyClientOfAdminMessage({ contact_id: 'contact-123', messagePreview: 'Hello, your invoice is ready.' })

    expect(gmailPost).toHaveBeenCalledOnce()
    const { raw } = vi.mocked(gmailPost).mock.calls[0][1] as { raw: string }
    expect(extractMimeTo(raw)).toBe('test@example.com')
  })

  it('sends Italian subject when contact language is it', async () => {
    const chain = mockSingleContact({ email: 'mario@example.com', full_name: 'Mario Rossi', language: 'it' })
    vi.mocked(supabaseAdmin.from).mockReturnValue(chain as any)

    await notifyClientOfAdminMessage({ contact_id: 'contact-456', messagePreview: 'Ciao.' })

    const { raw } = vi.mocked(gmailPost).mock.calls[0][1] as { raw: string }
    expect(extractMimeSubject(raw)).toBe('Nuovo messaggio dal team Tony Durante')
  })

  it('does not send when contact has no email', async () => {
    const chain = mockSingleContact({ email: null, full_name: 'No Email', language: 'en' })
    vi.mocked(supabaseAdmin.from).mockReturnValue(chain as any)

    await notifyClientOfAdminMessage({ contact_id: 'contact-789', messagePreview: 'Test' })

    expect(gmailPost).not.toHaveBeenCalled()
  })

  it('does nothing when neither account_id nor contact_id provided', async () => {
    await notifyClientOfAdminMessage({ messagePreview: 'Test' })

    expect(gmailPost).not.toHaveBeenCalled()
    expect(supabaseAdmin.from).not.toHaveBeenCalled()
  })

  it('truncates long message preview to 200 chars', async () => {
    const chain = mockSingleContact({ email: 'test@example.com', full_name: 'Test User', language: 'en' })
    vi.mocked(supabaseAdmin.from).mockReturnValue(chain as any)

    await notifyClientOfAdminMessage({ contact_id: 'contact-trunc', messagePreview: 'A'.repeat(500) })

    const { raw } = vi.mocked(gmailPost).mock.calls[0][1] as { raw: string }
    const html = extractMimeHtmlBody(raw)
    expect(html).toContain('A'.repeat(200))
    expect(html).not.toContain('A'.repeat(201))
  })

  // ── Multi-Member LLC tests (account_id path) ────────────────────────────

  it('sends one email for single-contact account', async () => {
    const chain = mockContactArray([
      { contacts: { email: 'bence@example.com', full_name: 'Bence Koncz', language: 'en' } },
    ])
    vi.mocked(supabaseAdmin.from).mockReturnValue(chain as any)

    await notifyClientOfAdminMessage({ account_id: 'account-abc', messagePreview: 'Hello' })

    expect(gmailPost).toHaveBeenCalledOnce()
    const { raw } = vi.mocked(gmailPost).mock.calls[0][1] as { raw: string }
    expect(extractMimeTo(raw)).toBe('bence@example.com')
  })

  it('sends separate emails to ALL contacts for Multi-Member LLC', async () => {
    const chain = mockContactArray([
      { contacts: { email: 'bence@example.com', full_name: 'Bence Koncz', language: 'en' } },
      { contacts: { email: 'donat@example.com', full_name: 'Donat Percsi', language: 'en' } },
    ])
    vi.mocked(supabaseAdmin.from).mockReturnValue(chain as any)

    await notifyClientOfAdminMessage({ account_id: 'account-mmllc', messagePreview: 'New message' })

    expect(gmailPost).toHaveBeenCalledTimes(2)
    const recipients = vi.mocked(gmailPost).mock.calls.map(c => extractMimeTo((c[1] as { raw: string }).raw))
    expect(recipients).toContain('bence@example.com')
    expect(recipients).toContain('donat@example.com')
  })

  it('personalizes greeting per recipient in MMLLC', async () => {
    const chain = mockContactArray([
      { contacts: { email: 'bence@example.com', full_name: 'Bence Koncz', language: 'en' } },
      { contacts: { email: 'donat@example.com', full_name: 'Donat Tamas Percsi', language: 'en' } },
    ])
    vi.mocked(supabaseAdmin.from).mockReturnValue(chain as any)

    // Different account_id than other tests to avoid in-memory throttle collision
    await notifyClientOfAdminMessage({ account_id: 'account-mmllc-greet', messagePreview: 'Test' })

    const htmls = vi.mocked(gmailPost).mock.calls.map(c => extractMimeHtmlBody((c[1] as { raw: string }).raw))
    const benceHtml = htmls.find(h => h.includes('Bence'))
    const donatHtml = htmls.find(h => h.includes('Donat'))
    expect(benceHtml).toBeTruthy()
    expect(donatHtml).toBeTruthy()
    // Each recipient gets their own greeting
    expect(benceHtml).not.toContain('Donat')
    expect(donatHtml).not.toContain('Bence')
  })

  it('skips contacts with null email in MMLLC, sends to the rest', async () => {
    const chain = mockContactArray([
      { contacts: { email: 'bence@example.com', full_name: 'Bence Koncz', language: 'en' } },
      { contacts: null },
      { contacts: { email: null, full_name: 'No Email', language: 'en' } },
    ])
    vi.mocked(supabaseAdmin.from).mockReturnValue(chain as any)

    await notifyClientOfAdminMessage({ account_id: 'account-partial', messagePreview: 'Test' })

    expect(gmailPost).toHaveBeenCalledOnce()
    const { raw } = vi.mocked(gmailPost).mock.calls[0][1] as { raw: string }
    expect(extractMimeTo(raw)).toBe('bence@example.com')
  })

  it('does nothing when account has no contacts with emails', async () => {
    const chain = mockContactArray([])
    vi.mocked(supabaseAdmin.from).mockReturnValue(chain as any)

    await notifyClientOfAdminMessage({ account_id: 'account-empty', messagePreview: 'Test' })

    expect(gmailPost).not.toHaveBeenCalled()
  })

  it('sends Italian to Italian contacts and English to English in mixed MMLLC', async () => {
    const chain = mockContactArray([
      { contacts: { email: 'en@example.com', full_name: 'English Member', language: 'en' } },
      { contacts: { email: 'it@example.com', full_name: 'Membro Italiano', language: 'it' } },
    ])
    vi.mocked(supabaseAdmin.from).mockReturnValue(chain as any)

    await notifyClientOfAdminMessage({ account_id: 'account-mixed-lang', messagePreview: 'Test' })

    expect(gmailPost).toHaveBeenCalledTimes(2)
    const calls = vi.mocked(gmailPost).mock.calls
    const subjects = calls.map(c => extractMimeSubject((c[1] as { raw: string }).raw))
    expect(subjects).toContain('New message from the Tony Durante team')
    expect(subjects).toContain('Nuovo messaggio dal team Tony Durante')
  })
})
