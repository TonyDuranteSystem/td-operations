import { describe, it, expect } from 'vitest'
import { invoicePartyName } from '@/lib/finance/invoice-party'

describe('invoicePartyName', () => {
  it('returns the company name when linked to an account (object embed)', () => {
    expect(invoicePartyName({ accounts: { company_name: 'Lunaweb Digital LLC' } })).toBe('Lunaweb Digital LLC')
  })

  it('returns the company name when the embed is a one-element array', () => {
    expect(invoicePartyName({ accounts: [{ company_name: 'Acme LLC' }] })).toBe('Acme LLC')
  })

  it('falls back to the contact full name when there is no account (formation window)', () => {
    expect(invoicePartyName({ accounts: null, contacts: { full_name: 'Patrick Covelli' } })).toBe('Patrick Covelli')
  })

  it('falls back to the contact full name when contact embed is an array', () => {
    expect(invoicePartyName({ contacts: [{ full_name: 'Alessandro Federici' }] })).toBe('Alessandro Federici')
  })

  it('prefers the company name over the contact name when both are present', () => {
    expect(
      invoicePartyName({ accounts: { company_name: 'Acme LLC' }, contacts: { full_name: 'John Doe' } }),
    ).toBe('Acme LLC')
  })

  it('treats a blank/whitespace company name as absent and uses the contact', () => {
    expect(invoicePartyName({ accounts: { company_name: '   ' }, contacts: { full_name: 'Jane Roe' } })).toBe('Jane Roe')
  })

  it("returns '—' when neither account nor contact is present", () => {
    expect(invoicePartyName({})).toBe('—')
    expect(invoicePartyName({ accounts: null, contacts: null })).toBe('—')
  })

  it("returns '—' when contact has a null full_name and no account", () => {
    expect(invoicePartyName({ contacts: { full_name: null } })).toBe('—')
  })
})
