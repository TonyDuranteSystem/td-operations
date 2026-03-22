import { describe, it, expect } from 'vitest'
import { SERVICE_TRACKER_SLUGS, SERVICE_TYPE_TO_SLUG } from '@/lib/constants'

describe('SERVICE_TRACKER_SLUGS', () => {
  it('maps formation slug to Company Formation', () => {
    expect(SERVICE_TRACKER_SLUGS['formation']).toBe('Company Formation')
  })

  it('maps tax-return slug to Tax Return', () => {
    expect(SERVICE_TRACKER_SLUGS['tax-return']).toBe('Tax Return')
  })

  it('maps itin slug to ITIN', () => {
    expect(SERVICE_TRACKER_SLUGS['itin']).toBe('ITIN')
  })

  it('has all expected service types', () => {
    const slugs = Object.keys(SERVICE_TRACKER_SLUGS)
    expect(slugs).toContain('formation')
    expect(slugs).toContain('onboarding')
    expect(slugs).toContain('tax-return')
    expect(slugs).toContain('itin')
    expect(slugs).toContain('banking')
    expect(slugs).toContain('closure')
    expect(slugs).toContain('ein')
  })
})

describe('SERVICE_TYPE_TO_SLUG', () => {
  it('is the reverse of SERVICE_TRACKER_SLUGS', () => {
    for (const [slug, type] of Object.entries(SERVICE_TRACKER_SLUGS)) {
      expect(SERVICE_TYPE_TO_SLUG[type]).toBe(slug)
    }
  })
})
