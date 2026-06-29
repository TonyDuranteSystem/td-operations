import { describe, it, expect } from 'vitest'
import {
  DEFAULT_LANDING_CONTENT,
  MAX_PORTFOLIO_ITEMS,
  validateLandingContent,
  normalizePortfolioItem,
  normalizePortfolioItems,
  landingContentEqual,
  landingText,
  portfolioDescription,
} from '@/lib/td-communication/landing-content'
import type { LandingContent } from '@/lib/td-communication/types'

describe('validateLandingContent', () => {
  it('returns defaults for null/undefined/empty', () => {
    expect(validateLandingContent(null)).toEqual(DEFAULT_LANDING_CONTENT)
    expect(validateLandingContent(undefined)).toEqual(DEFAULT_LANDING_CONTENT)
    expect(validateLandingContent({})).toEqual(DEFAULT_LANDING_CONTENT)
  })

  it('trims string fields and keeps provided values', () => {
    const out = validateLandingContent({ hero_headline_en: '  Hello  ', hero_headline_it: 'Ciao' })
    expect(out.hero_headline_en).toBe('Hello')
    expect(out.hero_headline_it).toBe('Ciao')
    // unprovided fields fall back to defaults
    expect(out.cta_text_en).toBe(DEFAULT_LANDING_CONTENT.cta_text_en)
  })

  it('coerces coming_soon to a boolean, defaulting true', () => {
    expect(validateLandingContent({ coming_soon: false }).coming_soon).toBe(false)
    // non-boolean → default
    expect(validateLandingContent({ coming_soon: 'yes' as unknown as boolean }).coming_soon).toBe(true)
  })

  it('drops portfolio items without an image_url and trims the rest', () => {
    const out = validateLandingContent({
      portfolio_items: [
        { image_url: '', client_name: 'X', description_en: '', description_it: '' },
        { image_url: ' https://x/a.png ', client_name: '  Acme  ', description_en: 'EN', description_it: 'IT' },
        { client_name: 'no image' } as never,
      ],
    })
    expect(out.portfolio_items).toHaveLength(1)
    expect(out.portfolio_items[0]).toEqual({ image_url: 'https://x/a.png', client_name: 'Acme', description_en: 'EN', description_it: 'IT' })
  })

  it('caps portfolio items at MAX_PORTFOLIO_ITEMS', () => {
    const many = Array.from({ length: MAX_PORTFOLIO_ITEMS + 5 }, (_, i) => ({ image_url: `https://x/${i}.png`, client_name: '', description_en: '', description_it: '' }))
    expect(validateLandingContent({ portfolio_items: many }).portfolio_items).toHaveLength(MAX_PORTFOLIO_ITEMS)
  })
})

describe('normalizePortfolioItem(s)', () => {
  it('returns null for non-objects and image-less items', () => {
    expect(normalizePortfolioItem(null)).toBeNull()
    expect(normalizePortfolioItem('x')).toBeNull()
    expect(normalizePortfolioItem({ client_name: 'x' })).toBeNull()
  })
  it('returns [] for non-arrays', () => {
    expect(normalizePortfolioItems(null)).toEqual([])
    expect(normalizePortfolioItems('x')).toEqual([])
  })
})

describe('landingContentEqual', () => {
  const base: LandingContent = { ...DEFAULT_LANDING_CONTENT }
  it('treats normalized-equal content as equal (whitespace-insensitive)', () => {
    expect(landingContentEqual(base, { ...base, hero_headline_en: `${base.hero_headline_en}  ` })).toBe(true)
  })
  it('detects real differences', () => {
    expect(landingContentEqual(base, { ...base, hero_headline_en: 'Different' })).toBe(false)
    expect(landingContentEqual(base, { ...base, coming_soon: !base.coming_soon })).toBe(false)
  })
})

describe('landingText', () => {
  const c: LandingContent = { ...DEFAULT_LANDING_CONTENT, hero_headline_en: 'Hello', hero_headline_it: 'Ciao' }
  it('picks the locale value', () => {
    expect(landingText(c, 'en', 'hero_headline')).toBe('Hello')
    expect(landingText(c, 'it', 'hero_headline')).toBe('Ciao')
  })
  it('falls back to EN when the IT value is blank', () => {
    const blankIt: LandingContent = { ...c, hero_headline_it: '' }
    expect(landingText(blankIt, 'it', 'hero_headline')).toBe('Hello')
  })
})

describe('portfolioDescription', () => {
  it('picks locale description with EN fallback', () => {
    const item = { image_url: 'x', client_name: 'A', description_en: 'EN', description_it: 'IT' }
    expect(portfolioDescription(item, 'en')).toBe('EN')
    expect(portfolioDescription(item, 'it')).toBe('IT')
    expect(portfolioDescription({ ...item, description_it: '' }, 'it')).toBe('EN')
  })
})
