import { describe, it, expect, vi, beforeEach } from 'vitest'

const gmailPost = vi.fn()
vi.mock('@/lib/gmail', () => ({ gmailPost: (...a: unknown[]) => gmailPost(...a) }))

import { buildChangeCodeEmail, buildChangedNoticeEmail, formatChangeDate, sendLoginEmailChangeMail } from '@/lib/portal/login-email-change-mail'
import { undoStaffMessage } from '@/lib/portal/login-email-change-alert'

vi.mock('@/lib/team/post-message', () => ({ postTeamMessage: vi.fn() }))

describe('the code email (to the NEW address)', () => {
  it('English: the code in groups of three, the address, 15 minutes, and "ignore it" wording', () => {
    const m = buildChangeCodeEmail({ fullName: 'Maria', locale: 'en', newEmail: 'm.rossi@example.com', code: '483291' })
    expect(m.subject).toBe('Your code to confirm your new login email')
    expect(m.html).toContain('483 291')
    expect(m.html).toContain('m.rossi@example.com')
    expect(m.html).toContain('Hi Maria,')
    expect(m.html).toContain('15 minutes')
    expect(m.html).toContain('Nothing will change')
  })
  it('Italian: translated, same code', () => {
    const m = buildChangeCodeEmail({ fullName: 'Maria', locale: 'it', newEmail: 'm.rossi@example.com', code: '004829' })
    expect(m.subject).toBe('Il tuo codice per confermare la nuova email di accesso')
    expect(m.html).toContain('004 829')
    expect(m.html).toContain('Ciao Maria,')
    expect(m.html).toContain('15 minuti')
  })
  it('never lets a name or an address break out of the HTML', () => {
    const m = buildChangeCodeEmail({ fullName: '<script>alert(1)</script>', locale: 'en', newEmail: 'a"b@example.com', code: '123456' })
    expect(m.html).not.toContain('<script>')
    expect(m.html).toContain('&lt;script&gt;')
    expect(m.html).toContain('a&quot;b@example.com')
  })
  it('has a greeting even with no name', () => {
    expect(buildChangeCodeEmail({ fullName: null, locale: 'en', newEmail: 'a@b.co', code: '123456' }).html).toContain('Hi there,')
    expect(buildChangeCodeEmail({ fullName: '  ', locale: 'it', newEmail: 'a@b.co', code: '123456' }).html).toContain('Ciao,')
  })
})

describe('the note (to the OLD address)', () => {
  const base = { fullName: 'Maria', oldEmail: 'maria.rossi@example.com', newEmail: 'm.rossi@example.com', changedAt: new Date('2026-11-17T15:00:00Z'), undoUrl: 'https://portal.tonydurante.us/portal/undo-email-change?token=abc.def&lang=en' }
  it('English: both addresses, the date, a red "This wasn\'t me" button that points at the link, and 7 days', () => {
    const m = buildChangedNoticeEmail({ ...base, locale: 'en' })
    expect(m.subject).toBe('Your portal login email was changed')
    expect(m.html).toContain('maria.rossi@example.com')
    expect(m.html).toContain('m.rossi@example.com')
    expect(m.html).toContain('17 Nov 2026')
    expect(m.html).toContain('Your password has not changed.')
    expect(m.html).toContain("This wasn't me")
    expect(m.html).toContain('background:#dc2626')
    expect(m.html).toContain('href="https://portal.tonydurante.us/portal/undo-email-change?token=abc.def&amp;lang=en"')
    expect(m.html).toContain('7 days')
    expect(m.html).toContain('support@tonydurante.us')
  })
  it('Italian: translated, same button and link', () => {
    const m = buildChangedNoticeEmail({ ...base, locale: 'it' })
    expect(m.subject).toBe("L'email di accesso al tuo portale è stata cambiata")
    expect(m.html).toContain('17 novembre 2026')
    expect(m.html).toContain('Non sono stato io')
    expect(m.html).toContain('7 giorni')
    expect(m.html).toContain('undo-email-change?token=abc.def')
  })
  it('the date is the firm\'s day in New York, not UTC', () => {
    expect(formatChangeDate(new Date('2026-11-18T03:30:00Z'), 'en')).toBe('17 Nov 2026')
  })
})

describe('sending', () => {
  beforeEach(() => { gmailPost.mockReset() }) // not an arrow that RETURNS the mock: vitest would call it as the cleanup after each test
  const mail = { subject: 'Your code — àè', html: '<p>hi</p>' }
  it('uses an RFC 2047 base64 subject and the support sender', async () => {
    gmailPost.mockResolvedValue({ id: 'm1' })
    expect(await sendLoginEmailChangeMail({ to: 'new@example.com', email: mail })).toBe('sent')
    const raw = Buffer.from((gmailPost.mock.calls[0][1] as { raw: string }).raw, 'base64url').toString('utf8')
    expect(raw).toContain('From: Tony Durante <support@tonydurante.us>')
    expect(raw).toContain('To: new@example.com')
    expect(raw).toContain(`Subject: =?utf-8?B?${Buffer.from(mail.subject).toString('base64')}?=`)
  })
  it('says "sandbox_blocked", never "sent", when the sandbox turns the send off', async () => {
    gmailPost.mockResolvedValue({ sandbox: true })
    expect(await sendLoginEmailChangeMail({ to: 'new@example.com', email: mail })).toBe('sandbox_blocked')
  })
  it('never throws: a failed send is "send_failed"', async () => {
    gmailPost.mockImplementation(() => { throw new Error('boom') })
    expect(await sendLoginEmailChangeMail({ to: 'new@example.com', email: mail })).toBe('send_failed')
  })
})

describe('the staff alert', () => {
  it('says who, what happened and what to do', () => {
    const m = undoStaffMessage({ fullName: 'Maria Rossi', contactId: 'c-1', restoredEmail: 'old@example.com', undoneEmail: 'new@example.com' })
    expect(m).toContain('Maria Rossi')
    expect(m).toContain('old@example.com')
    expect(m).toContain('new@example.com')
    expect(m).toContain('Fix:')
    expect(m).toContain('c-1')
  })
  it('names the client even with no name on file', () => {
    expect(undoStaffMessage({ fullName: null, contactId: 'c-1', restoredEmail: 'a@b.co', undoneEmail: 'c@d.co' })).toMatch(/^A client pressed/)
  })
})
