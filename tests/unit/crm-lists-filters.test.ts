import { describe, it, expect } from 'vitest'
import {
  accountFacetCounts,
  companyMatches,
  contactLinkCounts,
  contactMatches,
  hasCompanyFilter,
  parseAccountFilters,
  parseContactFilters,
  TYPE_NOT_SET,
  type FilterableCompany,
} from '@/lib/crm-lists/filters'

const co = (status: string | null, account_type: string | null, entity_type: string | null): FilterableCompany => ({ status, account_type, entity_type })

const ROWS: FilterableCompany[] = [
  co('Active', 'Client', 'Single Member LLC'),
  co('Active', 'Client', 'Single Member LLC'),
  co('Active', 'Client', 'Multi Member LLC'),
  co('Active', 'One-Time', 'Single Member LLC'),
  co('Active', 'Client', null),
  co('Closed', 'One-Time', 'Single Member LLC'),
  co('Closed', 'Client', 'C-Corp Elected'),
  co('Offboarding', 'Client', 'Multi Member LLC'),
  co('Cancelled', 'Client', 'Single Member LLC'),
  co('Suspended', 'Partner', 'Single Member LLC'),
  co('Pending Formation', 'Client', null),
]

describe('parseAccountFilters', () => {
  it('defaults the status to Active and the rest to all', () => {
    expect(parseAccountFilters({})).toEqual({ status: 'Active', kind: '', type: '', overdue: false })
  })
  it('reads the three words', () => {
    expect(parseAccountFilters({ status: 'all', kind: 'One-Time', type: 'none' })).toEqual({ status: 'all', kind: 'One-Time', type: 'none', overdue: false })
  })
  it('takes the first value of a repeated parameter and trims', () => {
    expect(parseAccountFilters({ status: [' Closed ', 'Active'] }).status).toBe('Closed')
  })
})

describe('companyMatches', () => {
  it('keeps the three dimensions independent ("one time" is the kind, not a status)', () => {
    const f = { status: 'Closed', kind: 'One-Time', type: '' }
    expect(ROWS.filter((r) => companyMatches(r, f))).toHaveLength(1)
  })
  it('status "all" matches every status', () => {
    expect(ROWS.filter((r) => companyMatches(r, { status: 'all', kind: '', type: '' }))).toHaveLength(ROWS.length)
  })
  it('"Not set" matches only companies with no type', () => {
    const f = { status: 'all', kind: '', type: TYPE_NOT_SET }
    expect(ROWS.filter((r) => companyMatches(r, f))).toHaveLength(2)
  })
  it('a Partner is only found under All kinds', () => {
    expect(ROWS.filter((r) => companyMatches(r, { status: 'all', kind: 'Client', type: '' })).some((r) => r.account_type === 'Partner')).toBe(false)
    expect(ROWS.filter((r) => companyMatches(r, { status: 'all', kind: '', type: '' })).some((r) => r.account_type === 'Partner')).toBe(true)
  })
})

describe('accountFacetCounts (cross-filtered)', () => {
  it('counts each choice with the OTHER filters applied', () => {
    const f = { status: 'Active', kind: '', type: '' }
    const c = accountFacetCounts(ROWS, f)
    // status counts ignore the status filter itself
    expect(c.status.Active).toBe(5)
    expect(c.status.Closed).toBe(2)
    expect(c.status.Offboarding).toBe(1)
    expect(c.status.Cancelled).toBe(1)
    expect(c.status.all).toBe(ROWS.length)
    // kind / type counts respect the status filter (Active only)
    expect(c.kind.all).toBe(5)
    expect(c.kind.Client).toBe(4)
    expect(c.kind['One-Time']).toBe(1)
    expect(c.type.all).toBe(5)
    expect(c.type['Single Member LLC']).toBe(3)
    expect(c.type['Multi Member LLC']).toBe(1)
    expect(c.type['C-Corp Elected']).toBe(0)
    expect(c.type[TYPE_NOT_SET]).toBe(1)
  })
  it('a picked kind narrows the status counts', () => {
    const c = accountFacetCounts(ROWS, { status: 'Active', kind: 'One-Time', type: '' })
    expect(c.status.Active).toBe(1)
    expect(c.status.Closed).toBe(1)
    expect(c.status.all).toBe(2)
  })
  it('the "All" count equals the rows the filters would show', () => {
    const f = { status: 'Active', kind: 'Client', type: 'Single Member LLC' }
    const c = accountFacetCounts(ROWS, f)
    expect(c.status.Active).toBe(ROWS.filter((r) => companyMatches(r, f)).length)
  })
})

describe('contact filters', () => {
  const active = co('Active', 'Client', 'Single Member LLC')
  const closed = co('Closed', 'Client', 'Multi Member LLC')
  const oneTime = co('Active', 'One-Time', null)

  it('parses and ignores unknown link values', () => {
    expect(parseContactFilters({ link: 'with' }).link).toBe('with')
    expect(parseContactFilters({ link: 'none' }).link).toBe('none')
    expect(parseContactFilters({ link: 'bogus' }).link).toBe('')
    expect(parseContactFilters({})).toEqual({ link: '', cstatus: '', kind: '', ctype: '' })
  })
  it('knows when a company filter is picked', () => {
    expect(hasCompanyFilter(parseContactFilters({}))).toBe(false)
    expect(hasCompanyFilter(parseContactFilters({ cstatus: 'Active' }))).toBe(true)
  })
  it('the Companies filter splits linked from not linked', () => {
    const f = parseContactFilters({ link: 'with' })
    expect(contactMatches([active], f)).toBe(true)
    expect(contactMatches([], f)).toBe(false)
    const g = parseContactFilters({ link: 'none' })
    expect(contactMatches([], g)).toBe(true)
    expect(contactMatches([active], g)).toBe(false)
  })
  it('a person matches when ANY company matches', () => {
    const f = parseContactFilters({ cstatus: 'Closed' })
    expect(contactMatches([active, closed], f)).toBe(true)
    expect(contactMatches([active], f)).toBe(false)
  })
  it('ONE company must satisfy every picked filter (not one for each)', () => {
    const f = parseContactFilters({ cstatus: 'Closed', ctype: 'Single Member LLC' })
    // closed is MMLLC, active is SMLLC: no single company is Closed AND SMLLC
    expect(contactMatches([active, closed], f)).toBe(false)
  })
  it('a company filter leaves out people with no company', () => {
    expect(contactMatches([], parseContactFilters({ kind: 'Client' }))).toBe(false)
  })
  it('"Not set" type matches a company with no type', () => {
    expect(contactMatches([oneTime], parseContactFilters({ ctype: TYPE_NOT_SET }))).toBe(true)
    expect(contactMatches([active], parseContactFilters({ ctype: TYPE_NOT_SET }))).toBe(false)
  })
  it('link counts: All = With + No company, with the other filters applied', () => {
    const people = [{ companies: [active] }, { companies: [active, closed] }, { companies: [] }, { companies: [] }, { companies: [oneTime] }]
    expect(contactLinkCounts(people, parseContactFilters({}))).toEqual({ all: 5, with: 3, none: 2 })
    // a status filter drops everyone without a matching company, so "No company" falls to 0
    expect(contactLinkCounts(people, parseContactFilters({ cstatus: 'Closed' }))).toEqual({ all: 1, with: 1, none: 0 })
    // the link filter itself is ignored for its own counts
    expect(contactLinkCounts(people, parseContactFilters({ link: 'none' }))).toEqual({ all: 5, with: 3, none: 2 })
  })
})
