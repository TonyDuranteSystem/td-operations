import { describe, it, expect } from 'vitest'
import {
  humanizeKey,
  formatValue,
  groupSubmittedData,
} from '@/lib/flows/submitted-data'

describe('humanizeKey', () => {
  it('title-cases snake_case', () => {
    expect(humanizeKey('company_name')).toBe('Company Name')
    expect(humanizeKey('ein_number')).toBe('Ein Number')
    expect(humanizeKey('first_name')).toBe('First Name')
  })
})

describe('formatValue', () => {
  it('omits empty/null/undefined', () => {
    expect(formatValue(null)).toBeNull()
    expect(formatValue(undefined)).toBeNull()
    expect(formatValue('')).toBeNull()
    expect(formatValue('   ')).toBeNull()
    expect(formatValue([])).toBeNull()
  })
  it('renders booleans as Yes/No', () => {
    expect(formatValue(true)).toBe('Yes')
    expect(formatValue(false)).toBe('No')
  })
  it('renders numbers', () => {
    expect(formatValue(2)).toBe('2')
    expect(formatValue(0)).toBe('0')
  })
  it('summarizes file-path arrays as N files', () => {
    expect(formatValue(['tax/acc/x.csv'])).toBe('1 file')
    expect(formatValue(['a/b.pdf', 'c/d.pdf'])).toBe('2 files')
  })
  it('joins plain string arrays', () => {
    expect(formatValue(['Alpha', 'Beta'])).toBe('Alpha, Beta')
  })
  it('summarizes arrays of objects', () => {
    expect(formatValue([{ a: 1 }, { b: 2 }])).toBe('2 items')
  })
  it('trims plain strings', () => {
    expect(formatValue('  No  ')).toBe('No')
  })
})

describe('groupSubmittedData', () => {
  it('returns [] for empty input', () => {
    expect(groupSubmittedData(null)).toEqual([])
    expect(groupSubmittedData({})).toEqual([])
  })

  it('buckets flat keys into Company / Owner / US Activity / Tax Questions', () => {
    const groups = groupSubmittedData({
      company_name: 'Uxio Test LLC',
      owner_first_name: 'Jane',
      us_people_working: 'No',
      comp_digital_assets: 'No',
    })
    const titles = groups.map((g) => g.title)
    expect(titles).toEqual(['Company', 'Owner', 'US Activity', 'Tax Questions'])
    // Section prefixes stripped from labels
    const owner = groups.find((g) => g.title === 'Owner')!
    expect(owner.fields[0]).toEqual({ label: 'First Name', value: 'Jane' })
    const tax = groups.find((g) => g.title === 'Tax Questions')!
    expect(tax.fields[0]).toEqual({ label: 'Digital Assets', value: 'No' })
  })

  it('groups indexed entities into per-index cards and strips the redundant base prefix', () => {
    const groups = groupSubmittedData({
      member_0_member_first_name: 'Jane',
      member_0_member_last_name: 'Doe',
      member_1_member_first_name: 'John',
      bank_accounts_0_bank_name: 'Wise',
      bank_accounts_0_statements: ['tax/acc/wise.csv'],
    })
    const member1 = groups.find((g) => g.title === 'Member 1')!
    expect(member1.fields).toEqual([
      { label: 'First Name', value: 'Jane' },
      { label: 'Last Name', value: 'Doe' },
    ])
    expect(groups.find((g) => g.title === 'Member 2')).toBeTruthy()
    const bank = groups.find((g) => g.title === 'Bank Account 1')!
    expect(bank.fields).toEqual([
      { label: 'Bank Name', value: 'Wise' },
      { label: 'Statements', value: '1 file' },
    ])
  })

  it('orders flat sections around the entity cards', () => {
    const groups = groupSubmittedData({
      comp_foreign_trusts: 'No',
      member_0_member_first_name: 'Jane',
      company_name: 'Acme',
    })
    expect(groups.map((g) => g.title)).toEqual(['Company', 'Member 1', 'Tax Questions'])
  })

  it('omits fields whose value is empty', () => {
    const groups = groupSubmittedData({ company_name: 'Acme', phone: '' })
    const company = groups.find((g) => g.title === 'Company')!
    expect(company.fields.map((f) => f.label)).toEqual(['Company Name'])
  })
})
