import { describe, it, expect } from 'vitest'
import { SEARCH_MAX_ROWS, dropdownRows, nextHighlight, searchableQuery } from '@/lib/crm-lists/search-dropdown'
import type { EnhancedSearchResult } from '@/lib/types'

describe('searchableQuery', () => {
  it('needs at least 2 characters after trimming', () => {
    expect(searchableQuery('')).toBeNull()
    expect(searchableQuery('a')).toBeNull()
    expect(searchableQuery('  a  ')).toBeNull()
    expect(searchableQuery('ab')).toBe('ab')
  })
  it('returns the trimmed text', () => {
    expect(searchableQuery('  Ada Ro ')).toBe('Ada Ro')
  })
})

describe('nextHighlight', () => {
  it('starts at the first row going down and at the last going up', () => {
    expect(nextHighlight(-1, 1, 5)).toBe(0)
    expect(nextHighlight(-1, -1, 5)).toBe(4)
  })
  it('moves one row and wraps at both ends', () => {
    expect(nextHighlight(1, 1, 5)).toBe(2)
    expect(nextHighlight(4, 1, 5)).toBe(0)
    expect(nextHighlight(0, -1, 5)).toBe(4)
  })
  it('with no rows there is nothing to highlight', () => {
    expect(nextHighlight(0, 1, 0)).toBe(-1)
    expect(nextHighlight(-1, -1, 0)).toBe(-1)
  })
})

const person = (over: Partial<EnhancedSearchResult> & { id: string; title: string }): EnhancedSearchResult => ({
  type: 'contact', href: `/contacts/${over.id}`, subtitle: '', preview: {}, ...over,
})

describe('dropdownRows — contacts', () => {
  it('shows email and up to two companies, with "+N" for the rest', () => {
    const rows = dropdownRows([person({ id: 'c1', title: 'Ada Rossi', preview: { email: 'ada@example.com', companies: [{ name: 'A LLC', id: 'a' }, { name: 'B LLC', id: 'b' }, { name: 'C LLC', id: 'c' }] } })], 'contact')
    expect(rows).toEqual([{ id: 'c1', title: 'Ada Rossi', detail: 'ada@example.com · A LLC, B LLC +1', href: '/contacts/c1' }])
  })
  it('falls back to the phone when there is no email, and copes with nothing at all', () => {
    const rows = dropdownRows([person({ id: 'c1', title: 'Ada', preview: { phone: '+1 555' } }), person({ id: 'c2', title: 'Bob' })], 'contact')
    expect(rows[0].detail).toBe('+1 555')
    expect(rows[1].detail).toBe('')
  })
  it('drops blank company names', () => {
    const rows = dropdownRows([person({ id: 'c1', title: 'Ada', preview: { email: 'a@b.c', companies: [{ name: ' ', id: 'x' }] } })], 'contact')
    expect(rows[0].detail).toBe('a@b.c')
  })
  it('ignores results of another kind and caps the list', () => {
    const many = Array.from({ length: 12 }, (_, i) => person({ id: `c${i}`, title: `P${i}` }))
    const mixed = [{ ...person({ id: 'a1', title: 'An account' }), type: 'account' as const }, ...many]
    const rows = dropdownRows(mixed, 'contact')
    expect(rows).toHaveLength(SEARCH_MAX_ROWS)
    expect(rows.every((r) => r.id !== 'a1')).toBe(true)
  })
})

describe('dropdownRows — accounts', () => {
  const acct = (over: Partial<EnhancedSearchResult> & { id: string; title: string }): EnhancedSearchResult => ({
    type: 'account', href: `/accounts/${over.id}`, subtitle: '', preview: {}, ...over,
  })
  it('shows status · state and the people linked to the company', () => {
    const rows = dropdownRows([acct({ id: 'a1', title: 'Open LLC', subtitle: 'Active · Wyoming', preview: { contacts: [{ name: 'Ada Rossi' }, { name: 'Bob Verdi' }, { name: 'Cy Neri' }] } })], 'account')
    expect(rows).toEqual([{ id: 'a1', title: 'Open LLC', detail: 'Active · Wyoming · Ada Rossi, Bob Verdi +1', href: '/accounts/a1' }])
  })
  it('works with no people and no subtitle', () => {
    expect(dropdownRows([acct({ id: 'a1', title: 'Open LLC' })], 'account')[0].detail).toBe('')
  })
})
