import { describe, it, expect } from 'vitest'
import {
  resolveClientVerdict, samePhone, normName, companyCore, normEmail, type ClientContact,
} from '@/lib/leads/client-context'

const co = (name: string, status = 'Active') => ({ name, status })
function contact(over: Partial<ClientContact> = {}): ClientContact {
  return { id: 'c1', full_name: 'Marco Verdi', email: 'marco@verdi.example', phone: '+39 345 578 4819', companies: [co('Verdi Consulting LLC')], ...over }
}
const lead = (over: Partial<{ full_name: string | null; email: string | null; phone: string | null }> = {}) => ({ full_name: 'Marco Verdi', email: null, phone: null, ...over })

describe('helpers', () => {
  it('normEmail lower-cases and trims', () => { expect(normEmail('  A@B.Com ')).toBe('a@b.com'); expect(normEmail(null)).toBe('') })
  it('samePhone ignores formatting and a country prefix, but not short numbers', () => {
    expect(samePhone('+39 345 578 4819', '3455784819')).toBe(true)
    expect(samePhone('+393455784819', '345-578-4819')).toBe(true)
    expect(samePhone('3455784819', '3455784810')).toBe(false)
    expect(samePhone('12345', '12345')).toBe(false)
    expect(samePhone(null, '3455784819')).toBe(false)
  })
  it('normName needs two words and ignores order, accents and case', () => {
    expect(normName('Rossi, Marco')).toBe(normName('marco rossi'))
    expect(normName('Nicoló Patti')).toBe(normName('nicolo patti'))
    expect(normName('Stefano')).toBe('')
    expect(normName(null)).toBe('')
  })
  it('companyCore drops the legal ending and refuses short names', () => {
    expect(companyCore('Verdi Consulting LLC')).toBe('verdi consulting')
    expect(companyCore('B&P LLC')).toBe('')
    expect(companyCore(null)).toBe('')
  })
})

describe('resolveClientVerdict', () => {
  it('an exact email on a client contact is sure, with the reason and its source', () => {
    const v = resolveClientVerdict({ lead: lead({ email: 'MARCO@verdi.example', full_name: 'M V' }), contacts: [contact()] })
    expect(v.verdict).toBe('sure')
    expect(v.contactId).toBe('c1')
    expect(v.reasons[0].source).toMatch(/Lead email/)
  })
  it('a second or alternate email counts', () => {
    expect(resolveClientVerdict({ lead: lead({ email: 'm2@x.example', full_name: null }), contacts: [contact({ email_2: 'm2@x.example' })] }).verdict).toBe('sure')
    expect(resolveClientVerdict({ lead: lead({ email: 'old@x.example', full_name: null }), contacts: [contact({ alt_emails: ['old@x.example'] })] }).verdict).toBe('sure')
  })
  it('phone alone is only maybe; phone plus the same name is sure', () => {
    const v1 = resolveClientVerdict({ lead: lead({ full_name: 'Someone Else', phone: '3455784819' }), contacts: [contact()] })
    expect(v1.verdict).toBe('maybe')
    const v2 = resolveClientVerdict({ lead: lead({ phone: '3455784819' }), contacts: [contact()] })
    expect(v2.verdict).toBe('sure')
  })
  it('the same full name alone is maybe, not sure', () => {
    const v = resolveClientVerdict({ lead: lead(), contacts: [contact()] })
    expect(v.verdict).toBe('maybe')
    expect(v.reasons.map(r => r.source)).toContain('Lead name, compared with CRM contacts')
  })
  it('a one-word name never matches', () => {
    expect(resolveClientVerdict({ lead: lead({ full_name: 'Marco' }), contacts: [contact({ full_name: 'Marco' })] }).verdict).toBe('none')
  })
  it('a name on the recording and a company in the notes are each a reason (maybe)', () => {
    const v = resolveClientVerdict({
      lead: lead({ full_name: 'Info Account' }),
      contacts: [contact()],
      evidence: { attendees: [{ name: 'Marco Verdi' }], notesText: 'He runs Verdi Consulting and wants a new LLC.' },
    })
    expect(v.verdict).toBe('maybe')
    expect(v.reasons).toHaveLength(2)
    expect(v.reasons[0].text).toMatch(/call recording/)
    expect(v.reasons[1].text).toMatch(/Verdi Consulting LLC/)
  })
  it('a contact with no company is never a client match', () => {
    expect(resolveClientVerdict({ lead: lead({ email: 'marco@verdi.example' }), contacts: [contact({ companies: [] })] }).verdict).toBe('none')
  })
  it('nothing in common is none', () => {
    expect(resolveClientVerdict({ lead: lead({ full_name: 'Giulia Neri', email: 'g@n.example' }), contacts: [contact()] })).toMatchObject({ verdict: 'none', reasons: [] })
  })
  it('picks the contact with the most evidence, deterministically', () => {
    const a = contact({ id: 'a', full_name: 'Marco Verdi', email: 'x@a.example', phone: '+39 111 222 3333' })
    const b = contact({ id: 'b', full_name: 'Marco Verdi', email: 'x@b.example', phone: '3455784819' })
    expect(resolveClientVerdict({ lead: lead({ phone: '+393455784819' }), contacts: [a, b] }).contactId).toBe('b')
  })
  it('"new_lead" rules that contact out; "client" settles it; "later" keeps asking', () => {
    const base = { lead: lead(), contacts: [contact()] }
    expect(resolveClientVerdict({ ...base, answers: [{ contactId: 'c1', status: 'new_lead' }] })).toMatchObject({ verdict: 'none', answered: 'new_lead' })
    expect(resolveClientVerdict({ ...base, answers: [{ contactId: 'c1', status: 'client' }] })).toMatchObject({ verdict: 'sure', contactId: 'c1', answered: 'client' })
    expect(resolveClientVerdict({ ...base, answers: [{ contactId: 'c1', status: 'later' }] })).toMatchObject({ verdict: 'maybe', answered: 'later' })
  })
  it('a lead already marked with a contact is sure without any other signal', () => {
    expect(resolveClientVerdict({ lead: lead({ full_name: 'Nobody Known' }), contacts: [contact()], markedContactId: 'c1' })).toMatchObject({ verdict: 'sure', contactId: 'c1' })
  })
})
