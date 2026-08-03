import { describe, it, expect } from 'vitest'
import { buildSignerInviteEmail, newInviteTrackingId, inviteTrackingPixelUrl } from '@/lib/esign/send'

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

describe('signer-invite open tracking', () => {
  // Added 2026-08-03: the signing invite was the one client email we could not
  // answer "did they even look at it" for. A bounce proves non-delivery; nothing
  // proved the opposite.
  it('embeds the pixel, hidden, when a tracking URL is given', () => {
    const url = 'https://app.tonydurante.us/api/track/open/et_123_abc'
    const { raw } = buildSignerInviteEmail({ ...base, trackingPixelUrl: url })
    expect(raw).toContain(`<img src="${url}"`)
    expect(raw).toContain('width="1" height="1"')
    expect(raw).toContain('display:none')
    // The signing link must still be there — tracking is additive, never a swap.
    expect(raw).toContain(base.signUrl)
  })

  it('is byte-identical to the untracked email when no URL is given', () => {
    const withNull = buildSignerInviteEmail({ ...base, trackingPixelUrl: null })
    const without = buildSignerInviteEmail(base)
    expect(withNull.raw).toBe(without.raw)
    expect(without.raw).not.toContain('/api/track/open/')
    expect(without.raw).not.toContain('<img')
  })

  it('escapes the pixel URL so it cannot break out of the attribute', () => {
    const { raw } = buildSignerInviteEmail({
      ...base,
      trackingPixelUrl: 'https://x.test/api/track/open/a"><script>alert(1)</script>',
    })
    expect(raw).not.toContain('<script>')
    expect(raw).toContain('&quot;')
  })

  it('builds the pixel URL from the SAME base as the signing link, never a hardcoded domain', () => {
    // A sandbox invite whose pixel points at production files opens against the
    // wrong deployment — the same trap the signing-link base rule exists for.
    expect(inviteTrackingPixelUrl('https://td-operations-sandbox.vercel.app', 'et_1_a'))
      .toBe('https://td-operations-sandbox.vercel.app/api/track/open/et_1_a')
    // A trailing slash must not produce a double slash.
    expect(inviteTrackingPixelUrl('https://app.tonydurante.us/', 'et_1_a'))
      .toBe('https://app.tonydurante.us/api/track/open/et_1_a')
  })

  it('returns no pixel URL when the base or the id is missing — tracking is skipped, never half-built', () => {
    expect(inviteTrackingPixelUrl('', 'et_1_a')).toBeNull()
    expect(inviteTrackingPixelUrl('https://app.tonydurante.us', '')).toBeNull()
  })

  it('mints a distinct id per send, so each reminder is tracked separately', () => {
    const ids = new Set(Array.from({ length: 50 }, () => newInviteTrackingId()))
    expect(ids.size).toBe(50)
    for (const id of ids) expect(id.startsWith('et_')).toBe(true)
  })
})
