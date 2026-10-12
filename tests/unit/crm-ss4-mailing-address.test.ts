import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolveMailing } from '@/lib/operations/ss4-refresh'

// Found by the 2026-10-01 production QA: the CRM "Generate SS-4" button (generate-document route) inserted the SS-4 row
// with NO mailing address, so the PDF fell back to the Seminole mailbox instead of Largo + the company's own suite.
describe('SS-4 line 4a (the OFFICIAL address — Antonio 2026-10-10, "option 2")', () => {
  it('a company with a number prints the official address on line 4a — no PMB, no company number — whatever address row is saved', () => {
    const m = resolveMailing({ physical_address: null, suite_number: '3D-433', mailing_address: { address_line1: '11125 Park Blvd', address_line2: 'Suite 104-153', city: 'Seminole', state: 'FL', zip: '33772' } } as Parameters<typeof resolveMailing>[0])
    expect(m.street).toBe('10225 Ulmerton Rd 3D')
    expect(m.street).not.toContain('PMB')
    expect(m.street).not.toContain('433')
    expect(m.cityStateZip).toBe('Largo, FL 33771')
  })
  it('every company with a number gets the identical line 4a (so the EIN letter matches the Articles exactly)', () => {
    const a = resolveMailing({ physical_address: null, suite_number: '3D-433', mailing_address: null } as Parameters<typeof resolveMailing>[0])
    const b = resolveMailing({ physical_address: null, suite_number: '3D-205', mailing_address: null } as Parameters<typeof resolveMailing>[0])
    expect(a).toEqual(b)
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
  it('a company with NO suite whose saved text address is the Largo office with a bare "3D" falls back to the Seminole mailbox', () => {
    const m = resolveMailing({
      physical_address: '10225 Ulmerton Rd, Suite 3D, Largo, FL 33771', suite_number: null, mailing_address: null,
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
