import { describe, it, expect } from 'vitest'
import {
  mergeRecipientSuggestions,
  isEmailLike,
  escapeIlikeTerm,
  MAX_RECIPIENT_SUGGESTIONS,
  type RecipientSuggestion,
} from '@/lib/inbox/recipient-search'

const s = (
  email: string,
  source: RecipientSuggestion['source'],
  name = '',
  company?: string
): RecipientSuggestion => ({ email, name, source, company })

describe('isEmailLike', () => {
  it('accepts normal addresses', () => {
    expect(isEmailLike('luca@example.com')).toBe(true)
    expect(isEmailLike('a.b+tag@sub.domain.co')).toBe(true)
  })

  it('rejects non-addresses, empties, and non-strings', () => {
    expect(isEmailLike('not-an-email')).toBe(false)
    expect(isEmailLike('a@b')).toBe(false) // no TLD
    expect(isEmailLike('two words@x.com')).toBe(false)
    expect(isEmailLike('')).toBe(false)
    expect(isEmailLike(null)).toBe(false)
    expect(isEmailLike(42)).toBe(false)
  })
})

describe('escapeIlikeTerm', () => {
  it('neutralizes PostgREST .or() syntax characters', () => {
    expect(escapeIlikeTerm('a,b(c)')).toBe('a b c')
  })
  it('escapes LIKE wildcards', () => {
    expect(escapeIlikeTerm('100%_x')).toBe('100\\%\\_x')
  })
  it('doubles backslashes so a trailing one cannot eat the closing wildcard', () => {
    expect(escapeIlikeTerm('foo\\')).toBe('foo\\\\')
  })
  it("strips PostgREST's * wildcard alias", () => {
    expect(escapeIlikeTerm('a*b')).toBe('a b')
  })
})

describe('mergeRecipientSuggestions', () => {
  it('dedupes case-insensitively with CRM identity beating inbox sighting', () => {
    const out = mergeRecipientSuggestions([
      [s('Luca@Example.com', 'inbox', 'luca (gmail)')],
      [s('luca@example.com', 'contact', 'Luca Gallacci', 'Gallacci LLC')],
    ])
    expect(out).toHaveLength(1)
    expect(out[0].source).toBe('contact')
    expect(out[0].name).toBe('Luca Gallacci')
    expect(out[0].company).toBe('Gallacci LLC')
  })

  it('backfills a missing name/company from a lower-ranked duplicate', () => {
    const out = mergeRecipientSuggestions([
      [s('x@y.com', 'account', '', 'Acme LLC')],
      [s('x@y.com', 'inbox', 'Xavier Y')],
    ])
    expect(out).toHaveLength(1)
    expect(out[0].source).toBe('account')
    expect(out[0].company).toBe('Acme LLC')
    expect(out[0].name).toBe('Xavier Y') // name carried over from the inbox row
  })

  it('drops implausible addresses instead of suggesting them', () => {
    const out = mergeRecipientSuggestions([
      [s('not-an-email', 'contact', 'Broken Row'), s('ok@x.com', 'contact', 'Fine')],
    ])
    expect(out).toHaveLength(1)
    expect(out[0].email).toBe('ok@x.com')
  })

  it('orders CRM sources before inbox and caps the list', () => {
    const many = Array.from({ length: 20 }, (_, i) => s(`p${i}@x.com`, 'inbox', `P ${i}`))
    const out = mergeRecipientSuggestions([[s('c@x.com', 'contact', 'C')], many])
    expect(out[0].source).toBe('contact')
    expect(out).toHaveLength(MAX_RECIPIENT_SUGGESTIONS)
  })

  it('a later HIGHER-ranked duplicate replaces an earlier lower-ranked one', () => {
    const out = mergeRecipientSuggestions([
      [s('a@b.co', 'lead', 'Lead Name')],
      [s('a@b.co', 'contact', 'Contact Name')],
    ])
    expect(out[0].source).toBe('contact')
    expect(out[0].name).toBe('Contact Name')
  })

  it('trims whitespace on kept addresses', () => {
    const out = mergeRecipientSuggestions([[s(' a@b.co ', 'contact', 'A')]])
    expect(out[0].email).toBe('a@b.co')
  })
})
