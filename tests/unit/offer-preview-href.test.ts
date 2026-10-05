import { describe, it, expect } from 'vitest'
import { offerPreviewHref } from '@/lib/offers/offer-preview-href'

describe('offerPreviewHref — the staff preview link (dev job b834e4ae)', () => {
  it('goes through the CRM preview route, never a bare ?preview=td offer link', () => {
    const href = offerPreviewHref('mario-rossi-2026')
    expect(href).toBe('/api/crm/offer-preview?token=mario-rossi-2026')
    expect(href).not.toContain('preview=td')
  })

  it('is relative, so it resolves against the CRM host staff are signed in to', () => {
    expect(offerPreviewHref('x').startsWith('/')).toBe(true)
  })

  it('encodes a token that is not URL-safe', () => {
    expect(offerPreviewHref('a b&c=d')).toBe('/api/crm/offer-preview?token=a%20b%26c%3Dd')
  })
})
