import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolveMailing } from '@/lib/operations/ss4-refresh'

// Found by the 2026-10-01 production QA: the CRM "Generate SS-4" button (generate-document route) inserted the SS-4 row
// with NO mailing address, so the PDF fell back to the Seminole mailbox instead of Largo + the company's own suite.
describe('SS-4 mailing address (Largo + the company\'s own suite)', () => {
  it('a company with a suite prints the Largo office and its own suite, whatever address row is saved', () => {
    const m = resolveMailing({ physical_address: null, suite_number: '3D-433', mailing_address: null } as Parameters<typeof resolveMailing>[0])
    expect(m.street).toBe('10225 Ulmerton Rd, Suite 3D-433')
    expect(m.cityStateZip).toContain('Largo')
  })
  it('the CRM generate-document SS-4 insert stores the mailing address (regression guard)', () => {
    const src = readFileSync('app/api/crm/admin-actions/generate-document/route.ts', 'utf8')
    const insert = src.slice(src.indexOf('.from("ss4_applications")\n    .insert({'))
    expect(insert).toContain('mailing_street: mailing.street')
    expect(insert).toContain('mailing_city_state_zip: mailing.cityStateZip')
  })
  it('a company with NO suite whose saved row is the shared Largo office never prints a bare "3D" — falls back to the Seminole mailbox', () => {
    const m = resolveMailing({
      physical_address: null, suite_number: null,
      mailing_address: { address_line1: '10225 Ulmerton Rd', address_line2: '3D', city: 'Largo', state: 'FL', zip: '33771' },
    } as Parameters<typeof resolveMailing>[0])
    expect(m.street).not.toContain('3D')
    expect(m.street).toContain('Park Blvd')
  })
  it('a company with no suite and a real saved row keeps it', () => {
    const m = resolveMailing({
      physical_address: null, suite_number: null,
      mailing_address: { address_line1: '30 N Gould St', address_line2: 'Ste R', city: 'Sheridan', state: 'WY', zip: '82801' },
    } as Parameters<typeof resolveMailing>[0])
    expect(m.street).toBe('30 N Gould St, Ste R')
  })
})
