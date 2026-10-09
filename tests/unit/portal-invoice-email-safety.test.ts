import { describe, it, expect } from 'vitest'
import { esc, headerSafe, fromHeader, safeFilename, isSafeRecipient, createRawEmail, recentlyEmailed } from '@/lib/portal/invoice-email'
import { makeFakeDb, hasOp } from './helpers/fake-supabase'

const decodeRaw = (raw: string) => Buffer.from(raw, 'base64url').toString('utf8')

describe('esc', () => {
  it('neutralises markup and quotes', () => {
    expect(esc('<script>alert("x")</script>')).toBe('&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;')
    expect(esc(`it's & that`)).toBe('it&#39;s &amp; that')
  })
  it('leaves an ordinary name readable once rendered', () => {
    expect(esc('Smith & Sons')).toBe('Smith &amp; Sons')
  })
  it('handles null / numbers', () => {
    expect(esc(null)).toBe('')
    expect(esc(42)).toBe('42')
  })
})

describe('header safety', () => {
  it('removes line breaks and control characters (no injected Bcc:)', () => {
    expect(headerSafe('Acme\r\nBcc: evil@x.com')).toBe('Acme Bcc: evil@x.com')
    expect(headerSafe('a\u0000b c')).toBe('a b c')
  })
  it('encodes the display name so accents, commas and quotes cannot break the header (R041)', () => {
    const h = fromHeader('Società "Rossi", S.r.l.', 'support@tonydurante.us')
    expect(h).toMatch(/^=\?utf-8\?B\?[A-Za-z0-9+/=]+\?= <support@tonydurante\.us>$/)
    const b64 = /\?B\?(.*?)\?=/.exec(h)![1]
    expect(Buffer.from(b64, 'base64').toString('utf8')).toBe('Società "Rossi", S.r.l.')
  })
  it('falls back to a neutral name', () => {
    expect(fromHeader('', 'a@b.co')).toContain('<a@b.co>')
  })
})

describe('isSafeRecipient', () => {
  it('accepts one plain address', () => {
    expect(isSafeRecipient('mario@rossi.it')).toBe(true)
    expect(isSafeRecipient('  mario+tag@sub.rossi.it ')).toBe(true)
  })
  it.each([
    ['a@b.co\r\nBcc: x@y.z'], ['a@b.co, c@d.co'], ['Mario <a@b.co>'], ['a b@c.co'], ['no-at-sign'], ['a@b'], [''], [null],
  ])('refuses %s', (v) => {
    expect(isSafeRecipient(v as string)).toBe(false)
  })
})

describe('safeFilename', () => {
  it('keeps letters, digits, dot, dash, underscore', () => {
    expect(safeFilename('INV-000123')).toBe('INV-000123')
    expect(safeFilename('../../etc/passwd"; x')).toBe('etc_passwd_x')
    expect(safeFilename('')).toBe('invoice')
  })
})

describe('createRawEmail', () => {
  it('builds headers that a recipient value cannot extend', () => {
    const raw = decodeRaw(createRawEmail({
      from: fromHeader('Acme', 'support@tonydurante.us'),
      to: 'mario@rossi.it\r\nBcc: evil@x.com',
      subject: 'Invoice 1\r\nBcc: evil@x.com',
      html: '<p>hi</p>',
    }))
    const headerBlock = raw.split('\r\n\r\n')[0]
    expect(headerBlock).not.toMatch(/^Bcc:/m)
    expect(headerBlock).toMatch(/^To: mario@rossi\.it Bcc: evil@x\.com$/m)
    expect(headerBlock).toMatch(/^Subject: =\?utf-8\?B\?/m)
  })
  it('attaches the PDF under a safe name and ignores an unsafe reply-to', () => {
    const raw = decodeRaw(createRawEmail({
      from: fromHeader('Acme', 'support@tonydurante.us'), to: 'a@b.co', subject: 's', html: 'x', replyTo: 'bad address',
      attachment: { base64: 'QUJD', filename: 'INV-1";evil.pdf' },
    }))
    expect(raw).not.toMatch(/Reply-To/)
    expect(raw).toMatch(/filename="INV-1_evil\.pdf"/)
    expect(raw).toMatch(/multipart\/mixed/)
  })
})

describe('recentlyEmailed', () => {
  it('is true when the log holds one of the exact subjects for this person and company in the window', async () => {
    const f = makeFakeDb(() => ({ data: [{ subject: 'Other' }, { subject: 'S2' }] }))
    expect(await recentlyEmailed(f.db, { accountId: 'acc', recipient: 'a@b.co', subjects: ['S1', 'S2'], windowSeconds: 60 })).toBe(true)
    const q = f.calls[0]
    expect(q.table).toBe('email_tracking')
    expect(hasOp(q, 'eq', 'recipient', 'a@b.co')).toBe(true)
    expect(hasOp(q, 'eq', 'account_id', 'acc')).toBe(true)
  })
  it('works for a company name with quotes and commas (they used to break the database filter)', async () => {
    const subject = 'Invoice INV-1 from Smith "Bros", S.r.l. (US)'
    const f = makeFakeDb(() => ({ data: [{ subject }] }))
    expect(await recentlyEmailed(f.db, { accountId: 'acc', recipient: 'a@b.co', subjects: [subject], windowSeconds: 60 })).toBe(true)
  })
  it('is false when nothing matching was sent', async () => {
    const f = makeFakeDb(() => ({ data: [{ subject: 'Something else' }] }))
    expect(await recentlyEmailed(f.db, { accountId: null, recipient: 'a@b.co', subjects: ['S'], windowSeconds: 60 })).toBe(false)
    expect(hasOp(f.calls[0], 'is', 'account_id', null)).toBe(true)
  })
  it('a failed lookup is logged and does not block the send', async () => {
    const f = makeFakeDb(() => ({ error: { message: 'db blip' } }))
    expect(await recentlyEmailed(f.db, { accountId: 'acc', recipient: 'a@b.co', subjects: ['S'], windowSeconds: 60 })).toBe(false)
  })
})
