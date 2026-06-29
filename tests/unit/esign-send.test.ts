import { describe, it, expect } from 'vitest'
import { buildSignerInviteEmail } from '@/lib/esign/send'

const base = {
  to: 'signer@example.com',
  signerName: 'José Núñez',
  documentName: 'Engagement Letter',
  signUrl: 'https://app.tonydurante.us/sign/TOK/CODE',
  requesterName: 'Tony Durante LLC',
}

describe('buildSignerInviteEmail', () => {
  it('RFC2047-encodes the subject and includes the signing link', () => {
    const { raw, subject } = buildSignerInviteEmail(base)
    expect(subject).toBe('Signature requested: Engagement Letter')
    expect(raw).toMatch(/Subject: =\?utf-8\?B\?[A-Za-z0-9+/=]+\?=/)
    expect(raw).toContain('https://app.tonydurante.us/sign/TOK/CODE')
    expect(raw).toContain('To: signer@example.com')
    expect(raw).toContain('Content-Type: text/html')
  })

  it('renders Italian when language starts with "it"', () => {
    const en = buildSignerInviteEmail(base)
    const it = buildSignerInviteEmail({ ...base, language: 'Italian' })
    expect(en.subject).toMatch(/^Signature requested:/)
    expect(it.subject).toMatch(/^Richiesta di firma:/)
    expect(it.raw).toContain('Visiona e firma')
  })

  it('escapes HTML in user-supplied fields (no injection)', () => {
    const { raw } = buildSignerInviteEmail({ ...base, documentName: '<script>x</script>' })
    expect(raw).not.toContain('<script>x</script>')
    expect(raw).toContain('&lt;script&gt;')
  })
})
