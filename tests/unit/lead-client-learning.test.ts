import { describe, it, expect } from 'vitest'
import { planLearning } from '@/lib/leads/client-check-answer'
import type { ClientContact } from '@/lib/leads/client-context'

const c = (over: Partial<ClientContact> = {}): ClientContact => ({
  id: 'c1', full_name: 'Marco Verdi', email: 'marco@verdi.example', phone: '+39 345 578 4819', companies: [{ name: 'Verdi Consulting LLC', status: 'Active' }], ...over,
})

describe('planLearning', () => {
  it('adds a new email as an alternate and a new phone in the first free column', () => {
    expect(planLearning(c(), { email: 'Other@Mail.example', phone: '+1 727 254 2248' })).toEqual({ altEmail: 'other@mail.example', phone: { column: 'phone_2', value: '+1 727 254 2248' } })
  })
  it('adds nothing the contact already has (any email field, any phone format)', () => {
    expect(planLearning(c({ alt_emails: ['x@y.example'] }), { email: 'X@Y.example', phone: '3455784819' })).toEqual({ altEmail: null, phone: null })
    expect(planLearning(c({ email_2: 'e2@y.example' }), { email: 'e2@y.example', phone: null }).altEmail).toBeNull()
  })
  it('uses the next free phone column and gives up when all are full', () => {
    expect(planLearning(c({ phone_2: '111 222 3333' }), { email: null, phone: '+1 727 254 2248' }).phone?.column).toBe('phone_3')
    expect(planLearning(c({ phone_2: '1', phone_3: '2', phone_4: '3' }), { email: null, phone: '+1 727 254 2248' }).phone).toBeNull()
  })
  it('handles a lead with no email or phone', () => {
    expect(planLearning(c(), { email: null, phone: null })).toEqual({ altEmail: null, phone: null })
  })
})
