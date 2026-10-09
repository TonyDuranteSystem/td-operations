import { describe, it, expect } from 'vitest'
import { validatePaymentLinkUrl, pickNewDefault } from '@/lib/portal/payment-link-rules'

describe('validatePaymentLinkUrl', () => {
  it('accepts a normal https payment link', () => {
    expect(validatePaymentLinkUrl('https://buy.stripe.com/test_abc123')).toEqual({ ok: true, url: 'https://buy.stripe.com/test_abc123' })
    expect(validatePaymentLinkUrl('  https://paypal.me/mario  ')).toMatchObject({ ok: true })
  })
  it.each([
    ['javascript:alert(1)'],
    ['http://buy.stripe.com/x1234'],
    ['data:text/html,<script>1</script>'],
    ['ftp://files.example.com/pay'],
    ['https://x.com/"onmouseover="alert(1)'],
    ['https://example.com/a b'],
    ['https://example.com/<script>'],
    ['https://example.com/\r\nBcc: a@b.c'],
    ['https://nodot/pay'],
    ['https://'],
    ['not a url at all'],
    [''],
  ])('refuses %s', (bad) => {
    expect(validatePaymentLinkUrl(bad)).toMatchObject({ ok: false })
  })
  it('refuses non-strings and absurd lengths', () => {
    expect(validatePaymentLinkUrl(null)).toMatchObject({ ok: false })
    expect(validatePaymentLinkUrl({} as never)).toMatchObject({ ok: false })
    expect(validatePaymentLinkUrl('https://example.com/' + 'a'.repeat(2100))).toMatchObject({ ok: false })
  })
})

describe('pickNewDefault', () => {
  it('chooses the oldest remaining link, deterministically', () => {
    const r = pickNewDefault([{ id: 'b', created_at: '2026-03-01' }, { id: 'a', created_at: '2026-01-01' }, { id: 'c', created_at: '2026-02-01' }])
    expect(r?.id).toBe('a')
  })
  it('returns null when nothing is left', () => {
    expect(pickNewDefault([])).toBeNull()
  })
})
