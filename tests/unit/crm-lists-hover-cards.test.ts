import { describe, it, expect } from 'vitest'
import { companyCard, installmentLine, personCard, PERSON_CARD_MAX_COMPANIES, type CompanyCardSource } from '@/lib/crm-lists/hover-cards'
import { companiesByPerson, pickMainContacts, type AccountContactLink } from '@/lib/crm-lists/people'
import { accountFacetCounts, companyMatches, parseAccountFilters } from '@/lib/crm-lists/filters'

const NONE = { kind: 'not_invoiced' as const, count: 0 }

const company = (over: Partial<CompanyCardSource> = {}): CompanyCardSource => ({
  company_name: 'Acme Holdings LLC',
  entity_type: 'Single Member LLC',
  account_type: 'Client',
  status: 'Active',
  state_of_formation: 'Wyoming',
  client_since: '13 Mar 2026',
  contact_name: 'Jane Doe',
  contact_email: 'jane@example.com',
  payment_overdue: 0,
  installment_1_amount: 1250,
  installment_1_currency: 'USD',
  installment_2_amount: 1250,
  installment_2_currency: 'USD',
  chip_1: NONE,
  chip_2: NONE,
  ...over,
})

describe('installmentLine', () => {
  it('shows the amount with the chip word when the year has an invoice', () => {
    expect(installmentLine(1250, 'USD', { kind: 'paid', count: 1 })).toBe('$1,250 · Paid')
    expect(installmentLine(1000, 'USD', { kind: 'overdue', count: 1 })).toBe('$1,000 · Overdue')
  })
  it('shows the bare amount when no invoice exists, and "Not set" for no amount', () => {
    expect(installmentLine(1250, 'USD', NONE)).toBe('$1,250')
    expect(installmentLine(null, null, NONE)).toBe('Not set')
  })
  it('counts duplicates', () => {
    expect(installmentLine(1250, 'USD', { kind: 'duplicate', count: 2 })).toBe('$1,250 · 2 invoices')
  })
})

describe('companyCard', () => {
  it('has a title, a type · kind · status line and the details', () => {
    const c = companyCard(company({ chip_1: { kind: 'paid', count: 1 }, chip_2: { kind: 'pending', count: 1 } }), 2026)
    expect(c.title).toBe('Acme Holdings LLC')
    expect(c.subtitle).toBe('SMLLC · Client · Active')
    expect(c.lines).toEqual([
      { label: 'State', value: 'Wyoming' },
      { label: 'Client since', value: '13 Mar 2026' },
      { label: 'Main contact', value: 'Jane Doe (jane@example.com)' },
      { label: '1st Inst · 2026', value: '$1,250 · Paid' },
      { label: '2nd Inst · 2026', value: '$1,250 · Pending' },
    ])
  })
  it('adds a red overdue line only when something is overdue, and words one payment as singular', () => {
    expect(companyCard(company(), 2026).lines.some(l => l.label === 'Overdue')).toBe(false)
    const one = companyCard(company({ payment_overdue: 1 }), 2026).lines.find(l => l.label === 'Overdue')
    expect(one).toEqual({ label: 'Overdue', value: '1 payment', tone: 'bad' })
    expect(companyCard(company({ payment_overdue: 3 }), 2026).lines.find(l => l.label === 'Overdue')?.value).toBe('3 payments')
  })
  it('skips empty details instead of printing blanks, and calls one-time companies "One-time"', () => {
    const c = companyCard(company({ state_of_formation: '  ', client_since: null, contact_name: null, entity_type: null, account_type: 'One-Time' }), 2025)
    expect(c.subtitle).toBe('One-time · Active')
    expect(c.lines.map(l => l.label)).toEqual(['1st Inst · 2025', '2nd Inst · 2025'])
  })
  it('never carries an EIN, passport, ITIN number or birth date', () => {
    const text = JSON.stringify(companyCard(company(), 2026)).toLowerCase()
    for (const word of ['ein', 'passport', 'itin', 'birth']) expect(text).not.toContain(`"${word}`)
  })
})

describe('personCard', () => {
  const person = (companies: { company_name: string; status: string | null }[]) => ({
    full_name: 'Jane Doe',
    email: 'jane@example.com',
    phone: '+1 555 0100',
    language: 'Italian',
    portal_tier: 'active',
    companies,
  })
  it('shows email, phone, language, portal stage and the companies with their status', () => {
    const c = personCard(person([{ company_name: 'Acme LLC', status: 'Active' }, { company_name: 'Beta LLC', status: 'Closed' }]))
    expect(c.title).toBe('Jane Doe')
    expect(c.subtitle).toBe('Portal stage: active')
    expect(c.lines).toEqual([
      { label: 'Email', value: 'jane@example.com' },
      { label: 'Phone', value: '+1 555 0100' },
      { label: 'Language', value: 'Italian' },
    ])
    expect(c.items).toEqual({ heading: 'Companies', entries: ['Acme LLC · Active', 'Beta LLC · Closed'] })
  })
  it('says "No company" for a person without one and uses the singular heading for one', () => {
    expect(personCard(person([])).items).toEqual({ heading: 'Companies', entries: ['No company'] })
    expect(personCard(person([{ company_name: 'Solo LLC', status: null }])).items).toEqual({ heading: 'Company', entries: ['Solo LLC'] })
  })
  it('cuts a long company list to a short one with "+ N more"', () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ company_name: `Company ${i}`, status: 'Active' }))
    const entries = personCard(person(many)).items!.entries
    expect(entries).toHaveLength(PERSON_CARD_MAX_COMPANIES + 1)
    expect(entries[entries.length - 1]).toBe(`+ ${9 - PERSON_CARD_MAX_COMPANIES} more`)
  })
  it('skips missing details and a missing portal stage', () => {
    const c = personCard({ ...person([]), email: null, phone: '', language: null, portal_tier: null })
    expect(c.lines).toEqual([])
    expect(c.subtitle).toBeNull()
  })
})

describe('main contact + companies of a person', () => {
  const link = (account_id: string, over: Partial<NonNullable<AccountContactLink['contact']>> = {}): AccountContactLink => ({
    account_id,
    is_primary: true,
    ended_at: null,
    contact: { id: 'p1', full_name: 'Jane Doe', email: 'jane@example.com', phone: '555', language: 'Italian', portal_tier: 'active', ...over },
  })
  it('hands the hover card details along with the main contact', () => {
    expect(pickMainContacts([link('a')]).a).toEqual({ id: 'p1', name: 'Jane Doe', email: 'jane@example.com', phone: '555', language: 'Italian', portal_tier: 'active' })
  })
  it('fills missing details with null', () => {
    const r = pickMainContacts([{ account_id: 'a', is_primary: true, ended_at: null, contact: { full_name: 'X', email: null } }])
    expect(r.a).toEqual({ id: null, name: 'X', email: null, phone: null, language: null, portal_tier: null })
  })
  it('lists a person\'s companies by name, once each', () => {
    const r = companiesByPerson([
      { contact_id: 'p1', account: { company_name: 'Zed LLC', status: 'Active' } },
      { contact_id: 'p1', account: { company_name: 'Alpha LLC', status: 'Closed' } },
      { contact_id: 'p1', account: { company_name: 'Alpha LLC', status: 'Closed' } },
      { contact_id: 'p2', account: null },
    ])
    expect(r.p1.map(c => c.company_name)).toEqual(['Alpha LLC', 'Zed LLC'])
    expect(r.p2).toBeUndefined()
  })
})

describe('the overdue filter', () => {
  const rows = [
    { status: 'Active', account_type: 'Client', entity_type: 'Single Member LLC', overdue_count: 2 },
    { status: 'Active', account_type: 'Client', entity_type: 'Multi Member LLC', overdue_count: 0 },
    { status: 'Closed', account_type: 'Client', entity_type: 'Single Member LLC', overdue_count: 1 },
    { status: 'Active', account_type: 'One-Time', entity_type: null },
  ]
  it('reads ?overdue=1 and nothing else as on', () => {
    expect(parseAccountFilters({ overdue: '1' }).overdue).toBe(true)
    expect(parseAccountFilters({ overdue: '0' }).overdue).toBe(false)
    expect(parseAccountFilters({}).overdue).toBe(false)
  })
  it('keeps only companies with an overdue invoice, on top of the other filters', () => {
    const f = parseAccountFilters({ overdue: '1' })
    expect(rows.filter(r => companyMatches(r, f))).toEqual([rows[0]])
    expect(rows.filter(r => companyMatches(r, parseAccountFilters({ overdue: '1', status: 'all' })))).toEqual([rows[0], rows[2]])
  })
  it('does nothing when off (and a company with no count is not overdue)', () => {
    expect(rows.filter(r => companyMatches(r, parseAccountFilters({})))).toHaveLength(3)
  })
  it('makes the other choices\' counts follow it', () => {
    const facets = accountFacetCounts(rows, parseAccountFilters({ overdue: '1' }))
    expect(facets.status.Active).toBe(1)
    expect(facets.status.Closed).toBe(1)
    expect(facets.status.all).toBe(2)
    expect(facets.type['Multi Member LLC']).toBe(0)
  })
})
