import { describe, it, expect } from 'vitest'
import {
  MAX_TAGS,
  MAX_TAG_LENGTH,
  isValidConsentSource,
  normalizeTags,
  validatePortfolioInput,
  isCurrentConsent,
  deriveConsentState,
  entrySource,
  deriveCategories,
  portfolioText,
  toPublicEntry,
  filterPublicEntries,
} from '@/lib/td-communication/portfolio'
import type { PortfolioEntry, PublicPortfolioEntry } from '@/lib/td-communication/types'

function entry(over: Partial<PortfolioEntry> = {}): PortfolioEntry {
  return {
    id: 'p1',
    enrollment_id: 'e1',
    title_en: 'Logo redesign',
    title_it: 'Ridisegno logo',
    client_name: 'Acme',
    description_en: 'A fresh mark',
    description_it: 'Un marchio nuovo',
    before_image_url: 'https://x/before.png',
    after_image_url: 'https://x/after.png',
    category: 'Logo',
    tags: ['minimal', 'blue'],
    published: true,
    featured: false,
    sort_order: 0,
    consent_source: 'client_optin',
    consent_id: 'c1',
    attested_by: null,
    attested_at: null,
    deleted_at: null,
    deleted_by: null,
    created_by: 'staff',
    created_at: '2026-07-04T00:00:00Z',
    updated_at: '2026-07-04T00:00:00Z',
    ...over,
  }
}

describe('isValidConsentSource', () => {
  it('accepts the three enum values', () => {
    expect(isValidConsentSource('client_optin')).toBe(true)
    expect(isValidConsentSource('written_on_file')).toBe(true)
    expect(isValidConsentSource('none')).toBe(true)
  })
  it('default-denies anything else', () => {
    expect(isValidConsentSource('yes')).toBe(false)
    expect(isValidConsentSource(null)).toBe(false)
    expect(isValidConsentSource(42)).toBe(false)
  })
})

describe('normalizeTags', () => {
  it('trims, lowercases, dedupes', () => {
    expect(normalizeTags([' Blue ', 'blue', 'MINIMAL'])).toEqual(['blue', 'minimal'])
  })
  it('drops non-strings and empties', () => {
    expect(normalizeTags(['ok', '', 3, null, '  '])).toEqual(['ok'])
  })
  it('caps count and length', () => {
    const many = Array.from({ length: 30 }, (_, i) => `tag${i}`)
    expect(normalizeTags(many)).toHaveLength(MAX_TAGS)
    expect(normalizeTags(['x'.repeat(100)])[0]).toHaveLength(MAX_TAG_LENGTH)
  })
  it('returns [] for non-array', () => {
    expect(normalizeTags('blue')).toEqual([])
    expect(normalizeTags(null)).toEqual([])
  })
})

describe('validatePortfolioInput', () => {
  it('requires an after image', () => {
    const r = validatePortfolioInput({ after_image_url: '' })
    expect(r.value).toBeNull()
    expect(r.error).toBeTruthy()
  })
  it('cleans a full payload', () => {
    const r = validatePortfolioInput({
      after_image_url: ' https://x/after.png ',
      before_image_url: '  ',
      title_en: '  Hi  ',
      category: ' Logo ',
      tags: ['A', 'a'],
      featured: true,
      consent_source: 'written_on_file',
      enrollment_id: '',
    })
    expect(r.error).toBeNull()
    expect(r.value).toMatchObject({
      after_image_url: 'https://x/after.png',
      before_image_url: null,
      title_en: 'Hi',
      category: 'Logo',
      tags: ['a'],
      featured: true,
      consent_source: 'written_on_file',
      enrollment_id: null,
    })
  })
  it('coerces an invalid consent_source to none', () => {
    const r = validatePortfolioInput({ after_image_url: 'https://x/a.png', consent_source: 'bogus' as never })
    expect(r.value?.consent_source).toBe('none')
  })
  it('handles null/undefined input', () => {
    expect(validatePortfolioInput(null).error).toBeTruthy()
    expect(validatePortfolioInput(undefined).error).toBeTruthy()
  })
})

describe('isCurrentConsent', () => {
  it('true only when granted and not revoked', () => {
    expect(isCurrentConsent({ revoked_at: null })).toBe(true)
    expect(isCurrentConsent({ revoked_at: '2026-07-04T00:00:00Z' })).toBe(false)
    expect(isCurrentConsent(null)).toBe(false)
    expect(isCurrentConsent(undefined)).toBe(false)
  })
})

describe('deriveConsentState', () => {
  it('written_on_file wins regardless of a consent row', () => {
    expect(deriveConsentState({ consent_source: 'written_on_file' }, null)).toBe('written_on_file')
  })
  it('client_optin → opted_in when live, withdrawn when revoked', () => {
    expect(deriveConsentState({ consent_source: 'client_optin' }, { revoked_at: null })).toBe('opted_in')
    expect(deriveConsentState({ consent_source: 'client_optin' }, { revoked_at: '2026-07-04T00:00:00Z' })).toBe('withdrawn')
    expect(deriveConsentState({ consent_source: 'client_optin' }, null)).toBe('withdrawn')
  })
  it('none → none', () => {
    expect(deriveConsentState({ consent_source: 'none' }, null)).toBe('none')
  })
})

describe('entrySource', () => {
  it('project vs manual', () => {
    expect(entrySource({ enrollment_id: 'e1' })).toBe('project')
    expect(entrySource({ enrollment_id: null })).toBe('manual')
  })
})

describe('deriveCategories', () => {
  it('distinct, sorted, blanks dropped', () => {
    expect(
      deriveCategories([{ category: 'Logo' }, { category: 'Web' }, { category: 'Brand' }, { category: null }, { category: 'Brand' }]),
    ).toEqual(['Brand', 'Logo', 'Web'])
  })
})

describe('portfolioText', () => {
  it('IT falls back to EN when blank', () => {
    const e = { title_en: 'Hello', title_it: '', description_en: 'D', description_it: 'Di' }
    expect(portfolioText(e, 'it', 'title')).toBe('Hello')
    expect(portfolioText(e, 'it', 'description')).toBe('Di')
    expect(portfolioText(e, 'en', 'description')).toBe('D')
  })
})

describe('toPublicEntry', () => {
  it('strips private/consent/curation fields', () => {
    const pub = toPublicEntry(entry())
    expect(pub).not.toHaveProperty('consent_source')
    expect(pub).not.toHaveProperty('published')
    expect(pub).not.toHaveProperty('deleted_at')
    expect(pub).not.toHaveProperty('created_by')
    expect(pub.after_image_url).toBe('https://x/after.png')
    expect(pub.featured).toBe(false)
  })
})

describe('filterPublicEntries', () => {
  const list: PublicPortfolioEntry[] = [
    { id: '1', title_en: 'a', title_it: '', client_name: '', description_en: '', description_it: '', before_image_url: null, after_image_url: 'x', category: 'Logo', tags: ['minimal'], featured: false },
    { id: '2', title_en: 'b', title_it: '', client_name: '', description_en: '', description_it: '', before_image_url: null, after_image_url: 'x', category: 'Brand', tags: ['bold', 'blue'], featured: true },
  ]
  it('no filter passes everything', () => {
    expect(filterPublicEntries(list)).toHaveLength(2)
  })
  it('filters by category (case-insensitive)', () => {
    expect(filterPublicEntries(list, { category: 'logo' }).map((e) => e.id)).toEqual(['1'])
  })
  it('filters by tag (case-insensitive)', () => {
    expect(filterPublicEntries(list, { tag: 'BLUE' }).map((e) => e.id)).toEqual(['2'])
  })
  it('combines category + tag', () => {
    expect(filterPublicEntries(list, { category: 'Brand', tag: 'bold' }).map((e) => e.id)).toEqual(['2'])
    expect(filterPublicEntries(list, { category: 'Logo', tag: 'bold' })).toHaveLength(0)
  })
})
