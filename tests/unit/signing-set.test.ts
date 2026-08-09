import { describe, it, expect } from 'vitest'
import { resolveSigningSet, signerDisplayName, type SigningSetMemberRow } from '@/lib/members/signing-set'

const individual = (over: Partial<SigningSetMemberRow> = {}): SigningSetMemberRow => ({
  member_type: 'individual',
  full_name: 'Giulia Rossi',
  company_name: null,
  email: 'giulia@example.com',
  representative_name: null,
  representative_email: null,
  contact_id: 'contact-1',
  ...over,
})

const company = (over: Partial<SigningSetMemberRow> = {}): SigningSetMemberRow => ({
  member_type: 'company',
  full_name: null,
  company_name: 'Whalecot Consulting LLC',
  email: null,
  representative_name: 'Michele Cotti',
  representative_email: 'michele@whalecot.com',
  contact_id: 'contact-2',
  ...over,
})

describe('resolveSigningSet — membership is not the same as signing', () => {
  it('an individual with an email signs', () => {
    const { signers, nonSigners } = resolveSigningSet([individual()])
    expect(nonSigners).toHaveLength(0)
    expect(signers).toEqual([
      { name: 'Giulia Rossi', email: 'giulia@example.com', contactId: 'contact-1' },
    ])
  })

  // The rule Antonio set on 2026-08-09: an individual with no email is still a
  // member — counted in ownership, named in the agreement — but cannot be sent
  // a signature request. Previously this blocked the whole document.
  it('an individual with NO email is a member but not a signer', () => {
    const { signers, nonSigners } = resolveSigningSet([individual({ email: null, contact_id: null })])
    expect(signers).toHaveLength(0)
    expect(nonSigners).toHaveLength(1)
    expect(nonSigners[0].name).toBe('Giulia Rossi')
    expect(nonSigners[0].reason).toContain('no email')
  })

  it('treats a blank / whitespace email as no email', () => {
    expect(resolveSigningSet([individual({ email: '   ' })]).signers).toHaveLength(0)
  })

  // Seven of the ten email-less members in production are companies, so this is
  // the common case, not the exception: the company signs through its rep.
  it('a company member signs through its representative', () => {
    const { signers, nonSigners } = resolveSigningSet([company()])
    expect(nonSigners).toHaveLength(0)
    expect(signers).toEqual([
      {
        name: 'Michele Cotti',
        email: 'michele@whalecot.com',
        contactId: 'contact-2',
        onBehalfOf: 'Whalecot Consulting LLC',
      },
    ])
  })

  // Unsignable only when BOTH routes are absent: no linked contact AND no
  // representative text. A linked contact alone is enough (see the Azarexa case
  // below) — that is why contact_id is nulled here.
  it('a company member with neither a contact nor a representative is a member but not a signer', () => {
    const { signers, nonSigners } = resolveSigningSet([
      company({
        company_name: 'No Rep LLC',
        representative_name: null,
        representative_email: null,
        contact_id: null,
      }),
    ])
    expect(signers).toHaveLength(0)
    expect(nonSigners[0].name).toBe('No Rep LLC')
    expect(nonSigners[0].reason).toContain('representative')
  })

  it('falls back to the company name when the representative has no name', () => {
    const { signers } = resolveSigningSet([company({ representative_name: null })])
    expect(signers[0].name).toBe('Whalecot Consulting LLC')
    expect(signers[0].onBehalfOf).toBe('Whalecot Consulting LLC')
  })

  it('a mixed roster splits correctly and never loses a member', () => {
    const rows = [
      individual({ full_name: 'Owner One', email: 'owner@example.com' }),
      individual({ full_name: 'Silent Partner', email: null, contact_id: null }),
      company(),
      company({
        company_name: 'No Rep LLC',
        representative_name: null,
        representative_email: null,
        contact_id: null,
      }),
    ]
    const { signers, nonSigners } = resolveSigningSet(rows)
    expect(signers.map(s => s.name)).toEqual(['Owner One', 'Michele Cotti'])
    expect(nonSigners.map(n => n.name)).toEqual(['Silent Partner', 'No Rep LLC'])
    // Every member is accounted for in exactly one bucket — a member must never
    // silently vanish from the agreement.
    expect(signers.length + nonSigners.length).toBe(rows.length)
  })

  // Advertising Apex LLC (99% of Azarexa LLC) has NO representative name and no
  // representative email, but its contact_id points at Umberto Moretti. Keying
  // on the text fields alone would wrongly declare it unsignable.
  it('a company with no representative text still signs when a contact is linked', () => {
    const { signers, nonSigners } = resolveSigningSet([
      company({
        company_name: 'Advertising Apex LLC',
        representative_name: null,
        representative_email: null,
        contact_id: 'umberto',
      }),
    ])
    expect(nonSigners).toHaveLength(0)
    expect(signers).toEqual([
      { name: 'Advertising Apex LLC', email: null, contactId: 'umberto', onBehalfOf: 'Advertising Apex LLC' },
    ])
  })

  // The live Azarexa case. Umberto is the 1% individual member AND the contact
  // behind the 99% corporate member. He must appear TWICE, in two capacities —
  // this is not a duplicate and must never be deduped away.
  it('the same person signs twice when they hold two capacities', () => {
    const { signers, nonSigners } = resolveSigningSet([
      company({
        company_name: 'Advertising Apex LLC',
        representative_name: null,
        representative_email: null,
        contact_id: 'umberto',
      }),
      individual({ full_name: 'Umberto Moretti', email: 'u.moretti@proton.me', contact_id: 'umberto' }),
    ])
    expect(nonSigners).toHaveLength(0)
    expect(signers).toHaveLength(2)
    // Same human, same contact, two distinct capacities.
    expect(signers.every(s => s.contactId === 'umberto')).toBe(true)
    expect(signers[0].onBehalfOf).toBe('Advertising Apex LLC')
    expect(signers[1].onBehalfOf).toBeUndefined()
  })

  // The signature line goes on the client's executed agreement. When a company
  // has no representative name we fall back to the company's own name, and the
  // "(for X)" suffix then printed it twice — "Advertising Apex LLC (for
  // Advertising Apex LLC)" on the real Azarexa agreement.
  it('signature line names the human acting for a company', () => {
    const [s] = resolveSigningSet([company()]).signers
    expect(signerDisplayName(s)).toBe('Michele Cotti (for Whalecot Consulting LLC)')
  })

  it('signature line does NOT repeat the company when there is no representative name', () => {
    const [s] = resolveSigningSet([
      company({ company_name: 'Advertising Apex LLC', representative_name: null, representative_email: null, contact_id: 'umberto' }),
    ]).signers
    expect(signerDisplayName(s)).toBe('Advertising Apex LLC')
  })

  it('signature line for an individual is just their name', () => {
    const [s] = resolveSigningSet([individual()]).signers
    expect(signerDisplayName(s)).toBe('Giulia Rossi')
  })

  it('handles an empty roster without throwing', () => {
    expect(resolveSigningSet([])).toEqual({ signers: [], nonSigners: [] })
  })

  it('names an unidentifiable row rather than dropping it', () => {
    const { nonSigners } = resolveSigningSet([
      individual({ full_name: null, company_name: null, email: null, contact_id: null }),
    ])
    expect(nonSigners).toHaveLength(1)
    expect(nonSigners[0].name).toBe('Unknown member')
  })
})
