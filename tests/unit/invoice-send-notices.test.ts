import { describe, it, expect } from 'vitest'
import { sendNotices, isPlausibleEmail } from '@/lib/portal/invoice-send-notices'

const base = { status: 'Draft', customerEmail: 'a@b.com', hasBankAccount: true, hasPaymentLink: false }
const ids = (i: Parameters<typeof sendNotices>[0]) => sendNotices(i).map(n => n.id)

describe('isPlausibleEmail', () => {
  it('accepts normal addresses and rejects junk', () => {
    expect(isPlausibleEmail('mario.rossi@azienda.it')).toBe(true)
    expect(isPlausibleEmail(' a@b.co ')).toBe(true)
    for (const bad of ['', '   ', null, undefined, 'abc', 'a@b', 'a b@c.com', '@x.com', 'a@.com']) {
      expect(isPlausibleEmail(bad as string | null | undefined)).toBe(false)
    }
  })
})

describe('sendNotices', () => {
  it('a Draft with everything in place only explains itself', () => {
    expect(ids(base)).toEqual(['draft-explainer'])
  })

  it('no customer email blocks Send', () => {
    const n = sendNotices({ ...base, customerEmail: null })
    expect(n.find(x => x.id === 'no-customer-email')?.blocksSend).toBe(true)
  })

  it('an invalid email counts as missing', () => {
    expect(ids({ ...base, customerEmail: 'not-an-email' })).toContain('no-customer-email')
  })

  it('no bank account and no payment link warns but does not block', () => {
    const n = sendNotices({ ...base, hasBankAccount: false, hasPaymentLink: false })
    expect(n.find(x => x.id === 'no-payment-details')?.blocksSend).toBe(false)
  })

  it('a payment link alone is enough (no false warning)', () => {
    expect(ids({ ...base, hasBankAccount: false, hasPaymentLink: true })).not.toContain('no-payment-details')
  })

  it('reminders need an email too, but are never told to add payment details', () => {
    const i = { status: 'Sent', customerEmail: '', hasBankAccount: false, hasPaymentLink: false }
    expect(ids(i)).toEqual(['no-customer-email'])
    expect(ids({ ...i, status: 'Overdue' })).toEqual(['no-customer-email'])
  })

  it('statuses that cannot send or remind get no notices', () => {
    for (const status of ['Paid', 'Partial', 'Cancelled', 'Split', 'Nonsense', null]) {
      expect(ids({ status: status as string | null, customerEmail: null, hasBankAccount: false, hasPaymentLink: false })).toEqual([])
    }
  })
})
