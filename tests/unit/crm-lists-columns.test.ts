import { describe, it, expect } from 'vitest'
import {
  ACCOUNT_COLUMNS,
  CONTACT_COLUMNS,
  chosenColumns,
  cleanColumns,
  columnPrefKey,
  defaultColumns,
  gridMinWidth,
  gridTemplate,
  hasColumn,
  parseColumnPref,
  resolveColumns,
} from '@/lib/crm-lists/columns'

describe('the field lists', () => {
  it('have unique ids and a width for every real column', () => {
    for (const list of [CONTACT_COLUMNS, ACCOUNT_COLUMNS]) {
      const ids = list.map((c) => c.id)
      expect(new Set(ids).size).toBe(ids.length)
      for (const c of list) if (!c.flag) expect(c.track).toMatch(/px/)
    }
  })
  it('offer every field Antonio picked', () => {
    const contacts = CONTACT_COLUMNS.map((c) => c.id)
    for (const id of ['passport_on_file', 'itin_on_file', 'portal_role', 'company_status']) expect(contacts).toContain(id)
    const accounts = ACCOUNT_COLUMNS.map((c) => c.id)
    for (const id of [
      'formation_date', 'client_since', 'onboarding_date', 'member_count', 'ein', 'suite_number', 'physical_address',
      'registered_agent', 'ra_renewal_date', 'annual_report_due_date', 'lead_source', 'referrer', 'portal_stage',
    ]) expect(accounts).toContain(id)
  })
  it('never offer the sensitive numbers', () => {
    const all = [...CONTACT_COLUMNS, ...ACCOUNT_COLUMNS].map((c) => `${c.id} ${c.label}`.toLowerCase()).join(' ')
    for (const bad of ['passport number', 'date of birth', 'itin number', 'bank', 'card', 'payment link']) expect(all).not.toContain(bad)
  })
  it('start with what the lists showed before the dropdown existed', () => {
    expect(defaultColumns('contacts')).toEqual(['email', 'citizenship', 'portal_stage'])
    expect(defaultColumns('accounts')).toEqual(['contact', 'type', 'status', 'state_of_formation', 'overdue'])
  })
  it('keep Company status unticked by default', () => {
    expect(defaultColumns('contacts')).not.toContain('company_status')
  })
})

describe('reading a saved choice', () => {
  it('keeps only known ids, once each, in the dropdown order', () => {
    expect(cleanColumns('contacts', ['portal_stage', 'email', 'email', 'nope', 7, null])).toEqual(['email', 'portal_stage'])
  })
  it('treats a non-list as no extra fields', () => {
    expect(cleanColumns('accounts', 'email')).toEqual([])
    expect(cleanColumns('accounts', undefined)).toEqual([])
  })
  it('parses a stored value, and returns null when nothing valid is saved', () => {
    expect(parseColumnPref('contacts', { cols: ['phone', 'email'], saved_at: 'x' })).toEqual(['email', 'phone'])
    expect(parseColumnPref('contacts', { cols: [] })).toEqual([])
    expect(parseColumnPref('contacts', {})).toBeNull()
    expect(parseColumnPref('contacts', null)).toBeNull()
    expect(parseColumnPref('contacts', 'x')).toBeNull()
  })
  it('falls back to the standard set only when nothing is saved (an empty choice stays empty)', () => {
    expect(resolveColumns('contacts', null)).toEqual(defaultColumns('contacts'))
    expect(resolveColumns('contacts', undefined)).toEqual(defaultColumns('contacts'))
    expect(resolveColumns('contacts', [])).toEqual([])
    expect(resolveColumns('accounts', ['ein', 'bogus'])).toEqual(['ein'])
  })
  it('keeps one saved key per list', () => {
    expect(columnPrefKey('contacts')).toBe('crm.columns.contacts')
    expect(columnPrefKey('accounts')).toBe('crm.columns.accounts')
  })
})

describe('layout', () => {
  it('splits chosen fields into before-money and after-money, and leaves flags out', () => {
    const c = chosenColumns('accounts', ['overdue', 'contact', 'ein'])
    expect(c.before.map((x) => x.id)).toEqual(['ein', 'contact'])
    expect(c.tail.map((x) => x.id)).toEqual(['overdue'])
    expect(chosenColumns('contacts', ['company_status', 'email']).before.map((x) => x.id)).toEqual(['email'])
  })
  it('builds the wide-window columns from the chosen fields', () => {
    expect(gridTemplate('contacts', [])).toBe('minmax(180px,260px) minmax(520px,1fr)')
    expect(gridTemplate('contacts', ['email', 'company_status'])).toBe('minmax(180px,260px) minmax(140px,230px) minmax(520px,1fr)')
    expect(gridTemplate('accounts', [])).toBe('minmax(180px,1fr) 132px 132px 84px')
    expect(gridTemplate('accounts', ['overdue', 'status'])).toBe('minmax(180px,1fr) 100px 132px 132px 84px 72px')
  })
  it('works out the narrowest width the chosen fields need', () => {
    // 180 + 520 + one 10px gap + 32px padding
    expect(gridMinWidth('contacts', [])).toBe(180 + 520 + 10 + 32)
    // adding a 150px email column adds the column and one more gap
    expect(gridMinWidth('contacts', ['email'])).toBe(180 + 140 + 520 + 20 + 32)
    expect(gridMinWidth('accounts', [])).toBe(180 + 132 + 132 + 84 + 30 + 32)
  })
  it('reports whether a field is chosen', () => {
    expect(hasColumn(['email'], 'email')).toBe(true)
    expect(hasColumn(['email'], 'phone')).toBe(false)
  })
})
