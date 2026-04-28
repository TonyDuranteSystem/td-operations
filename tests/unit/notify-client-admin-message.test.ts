import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock supabase-admin before importing the module under test
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

// web-push is a side-effect only dep — mock it away
vi.mock('@/lib/portal/web-push', () => ({
  sendPushToAccount: vi.fn(),
  sendPushToContact: vi.fn(),
}))

import { notifyClientOfAdminMessage } from '@/lib/portal/notifications'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { gmailPost } from '@/lib/gmail'

// The raw email is base64url(MIME). The MIME Subject header is RFC 2047 encoded,
// and the HTML body is itself base64 encoded inside the MIME part.
// These helpers decode both layers so assertions can check readable content.

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

const mockFrom = (data: unknown, error: unknown = null) => {
  const chain = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    limit: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue({ data, error }),
    single: vi.fn().mockResolvedValue({ data, error }),
    insert: vi.fn().mockResolvedValue({ data, error }),
  }
  return chain
}

describe('notifyClientOfAdminMessage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('sends email to contact when contact_id provided', async () => {
    const contactChain = mockFrom({ email: 'test@example.com', full_name: 'Mario Rossi', language: 'en' })
    vi.mocked(supabaseAdmin.from).mockReturnValue(contactChain as any)

    await notifyClientOfAdminMessage({
      contact_id: 'contact-123',
      messagePreview: 'Hello, your invoice is ready.',
    })

    expect(gmailPost).toHaveBeenCalledOnce()
    const call = vi.mocked(gmailPost).mock.calls[0]
    expect(call[0]).toBe('/messages/send')
    expect(call[1]).toHaveProperty('raw')
  })

  it('sends Italian email when contact language is it', async () => {
    const contactChain = mockFrom({ email: 'mario@example.com', full_name: 'Mario Rossi', language: 'it' })
    vi.mocked(supabaseAdmin.from).mockReturnValue(contactChain as any)

    await notifyClientOfAdminMessage({
      contact_id: 'contact-456',
      messagePreview: 'Ciao, il tuo documento è pronto.',
    })

    expect(gmailPost).toHaveBeenCalledOnce()
    const { raw } = vi.mocked(gmailPost).mock.calls[0][1] as { raw: string }
    const subject = extractMimeSubject(raw)
    expect(subject).toBe('Nuovo messaggio dal team Tony Durante')
  })

  it('does not send email when no email found', async () => {
    const contactChain = mockFrom({ email: null, full_name: 'No Email', language: 'en' })
    vi.mocked(supabaseAdmin.from).mockReturnValue(contactChain as any)

    await notifyClientOfAdminMessage({
      contact_id: 'contact-789',
      messagePreview: 'Test',
    })

    expect(gmailPost).not.toHaveBeenCalled()
  })

  it('does nothing when neither account_id nor contact_id provided', async () => {
    await notifyClientOfAdminMessage({ messagePreview: 'Test' })
    expect(gmailPost).not.toHaveBeenCalled()
    expect(supabaseAdmin.from).not.toHaveBeenCalled()
  })

  it('truncates long message preview to 200 chars', async () => {
    const contactChain = mockFrom({ email: 'test@example.com', full_name: 'Test User', language: 'en' })
    vi.mocked(supabaseAdmin.from).mockReturnValue(contactChain as any)

    const longMessage = 'A'.repeat(500)
    await notifyClientOfAdminMessage({
      contact_id: 'contact-trunc',
      messagePreview: longMessage,
    })

    expect(gmailPost).toHaveBeenCalledOnce()
    const { raw } = vi.mocked(gmailPost).mock.calls[0][1] as { raw: string }
    const html = extractMimeHtmlBody(raw)
    expect(html).toContain('A'.repeat(200))
    expect(html).not.toContain('A'.repeat(201))
  })
})
