import { describe, it, expect } from 'vitest'
import { accountCellText, accountMetaText, contactCellText, contactMetaText, type AccountCellSource, type ContactCellSource } from '@/lib/crm-lists/cells'
import { accountExtras, type AccountExtraRow } from '@/lib/crm-lists/extras'
import { formatListDate, plainText, resolvePhysicalAddress, yesOrNull } from '@/lib/crm-lists/format'
import { InstallmentChip } from '@/components/lists/chips'

const contact: ContactCellSource = {
  email: 'a@example.com', phone: ' ', language: 'Italian', citizenship: 'Italy', portal_tier: 'active', portal_role: null,
  passport_on_file: true, itin_number: null, created_at: '2026-03-04T10:00:00Z', account_count: 2,
}

describe('formatting', () => {
  it('shows the stored calendar date without shifting it', () => {
    expect(formatListDate('2026-03-04')).toBe('04 Mar 2026')
    expect(formatListDate('2026-12-31T23:30:00Z')).toBe('31 Dec 2026')
    expect(formatListDate(null)).toBeNull()
    expect(formatListDate('')).toBeNull()
    expect(formatListDate('2026-13-01')).toBeNull()
    expect(formatListDate('not a date')).toBeNull()
  })
  it('yes / blank / plain text', () => {
    expect(yesOrNull(true)).toBe('Yes')
    expect(yesOrNull(false)).toBeNull()
    expect(yesOrNull(null)).toBeNull()
    expect(plainText('  x ')).toBe('x')
    expect(plainText('   ')).toBeNull()
  })
})

describe('physical address', () => {
  it('uses the official address built from the suite number when the company has one', () => {
    const a = resolvePhysicalAddress({ suite_number: '3D-318', physical_address: null, mailing_address: null })
    expect(a).toContain('Largo')
    expect(a).not.toContain('PMB')
  })
  it('falls back to a saved address, then the old text, then nothing', () => {
    expect(resolvePhysicalAddress({ suite_number: null, physical_address: null, mailing_address: { address_line1: '1 Main St', city: 'Austin', state: 'TX', zip: '78701' } })).toBe('1 Main St, Austin TX 78701')
    expect(resolvePhysicalAddress({ suite_number: null, physical_address: '9 Old Rd, Rome', mailing_address: null })).toBe('9 Old Rd, Rome')
    expect(resolvePhysicalAddress({ suite_number: null, physical_address: null, mailing_address: null })).toBeNull()
  })
})

describe('Contacts field text', () => {
  it('reads each field, with blanks as null', () => {
    expect(contactCellText(contact, 'email')).toBe('a@example.com')
    expect(contactCellText(contact, 'phone')).toBeNull()
    expect(contactCellText(contact, 'portal_role')).toBeNull()
    expect(contactCellText(contact, 'passport_on_file')).toBe('Yes')
    expect(contactCellText(contact, 'itin_on_file')).toBeNull()
    expect(contactCellText(contact, 'added_on')).toBe('04 Mar 2026')
    expect(contactCellText(contact, 'company_count')).toBe('2')
    expect(contactCellText(contact, 'unknown')).toBeNull()
  })
  it('words them for the small line under the name', () => {
    expect(contactMetaText(contact, 'portal_stage')).toBe('portal active')
    expect(contactMetaText(contact, 'passport_on_file')).toBe('passport on file')
    expect(contactMetaText(contact, 'company_count')).toBe('2 companies')
    expect(contactMetaText({ ...contact, account_count: 1 }, 'company_count')).toBe('1 company')
    expect(contactMetaText(contact, 'phone')).toBeNull()
    expect(contactMetaText({ ...contact, itin_number: '9XX' }, 'itin_on_file')).toBe('ITIN on file')
  })
})

const account: AccountCellSource = {
  entity_type: 'Multi Member LLC', account_type: 'One-Time', status: 'Active', state_of_formation: 'WY',
  contact_name: 'Marco Rossi', contact_email: null, payment_overdue: 2, extras: { ein: '12-3456789', formation_date: '04 Mar 2026', lead_source: null },
}

describe('Accounts field text', () => {
  it('reads typed fields and chosen extras', () => {
    expect(accountCellText(account, 'type')).toBe('MMLLC')
    expect(accountCellText(account, 'kind')).toBe('One-time')
    expect(accountCellText(account, 'overdue')).toBe('2')
    expect(accountCellText({ ...account, payment_overdue: 0 }, 'overdue')).toBeNull()
    expect(accountCellText(account, 'contact_email')).toBeNull()
    expect(accountCellText(account, 'ein')).toBe('12-3456789')
    expect(accountCellText(account, 'lead_source')).toBeNull()
    expect(accountCellText(account, 'ra_renewal_date')).toBeNull()
  })
  it('words them for the small line under the company name', () => {
    expect(accountMetaText(account, 'overdue', 'Overdue')).toBe('2 overdue')
    expect(accountMetaText(account, 'ein', 'EIN')).toBe('ein 12-3456789')
    expect(accountMetaText(account, 'contact', 'Contact')).toBe('Marco Rossi')
    expect(accountMetaText(account, 'lead_source', 'Lead source')).toBeNull()
  })
})

const row: AccountExtraRow = {
  formation_date: '2024-05-06', client_since: null, onboarding_date: '2024-06-01', member_count: 3, ein_number: '12-3456789',
  suite_number: null, physical_address: '9 Old Rd, Rome', mailing_address: null, registered_agent_provider: ' Harbor ',
  ra_renewal_date: '2027-01-15', annual_report_due_date: null, lead_source: null, referrer: 'Nina', portal_tier: 'active',
}

describe('accountExtras', () => {
  it('builds text only for the fields that were chosen', () => {
    const e = accountExtras(['formation_date', 'ein'], row)
    expect(e).toEqual({ formation_date: '06 May 2024', ein: '12-3456789' })
    expect('physical_address' in e).toBe(false)
  })
  it('never includes the EIN unless it was chosen', () => {
    expect(JSON.stringify(accountExtras(['formation_date', 'referrer', 'portal_stage'], row))).not.toContain('12-3456789')
    expect(JSON.stringify(accountExtras([], row))).toBe('{}')
  })
  it('shows the suite number the way staff read it', () => {
    expect(accountExtras(['suite_number'], { ...row, suite_number: '3D-318' }).suite_number).toBe('PMB 318')
    expect(accountExtras(['suite_number'], { ...row, suite_number: 'Unit 4' }).suite_number).toBe('Unit 4')
    expect(accountExtras(['suite_number'], { ...row, suite_number: null }).suite_number).toBeNull()
  })
  it('turns empty values into null and numbers into text', () => {
    expect(accountExtras(['client_since', 'member_count', 'registered_agent', 'annual_report_due_date', 'lead_source'], row)).toEqual({
      client_since: null, member_count: '3', registered_agent: 'Harbor', annual_report_due_date: null, lead_source: null,
    })
  })
  it('resolves the address the way the rest of the system does', () => {
    expect(accountExtras(['physical_address'], row).physical_address).toBe('9 Old Rd, Rome')
    expect(accountExtras(['physical_address'], { ...row, suite_number: '3D-012' }).physical_address).toContain('Largo')
  })
  it('ignores ids it does not know', () => {
    expect(accountExtras(['contact', 'overdue', 'bogus'], row)).toEqual({})
  })
})

describe('the invoice chip', () => {
  it('draws nothing when no installment invoice exists for the year', () => {
    expect(InstallmentChip({ chip: { kind: 'not_invoiced', count: 0 } })).toBeNull()
  })
  it('still draws a real state', () => {
    for (const kind of ['paid', 'pending', 'overdue', 'waived', 'refunded', 'duplicate'] as const) {
      expect(InstallmentChip({ chip: { kind, count: kind === 'duplicate' ? 2 : 1 } })).not.toBeNull()
    }
  })
})
