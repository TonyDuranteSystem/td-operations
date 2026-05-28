import { describe, it, expect } from 'vitest'
import { deriveLeadDisplayStatus, SIGNED_AWAITING_PAYMENT_LABEL } from '@/lib/leads/display-status'

const base = {
  leadStatus: 'Offer Sent' as string | null,
  offerStatus: null as string | null,
  activationStatus: null as string | null,
  paymentConfirmedAt: null as string | null,
}

describe('deriveLeadDisplayStatus', () => {
  it('signed + awaiting payment → derived "Signed — awaiting payment"', () => {
    const r = deriveLeadDisplayStatus({ ...base, leadStatus: 'Offer Sent', offerStatus: 'signed', activationStatus: 'awaiting_payment' })
    expect(r).toEqual({ label: SIGNED_AWAITING_PAYMENT_LABEL, derived: true })
  })

  it('signed with no activation row yet → still awaiting payment', () => {
    const r = deriveLeadDisplayStatus({ ...base, offerStatus: 'signed' })
    expect(r.label).toBe(SIGNED_AWAITING_PAYMENT_LABEL)
    expect(r.derived).toBe(true)
  })

  it('completed offer is treated as signed', () => {
    const r = deriveLeadDisplayStatus({ ...base, offerStatus: 'completed' })
    expect(r.derived).toBe(true)
  })

  it('signed + payment confirmed (timestamp) → NOT the awaiting overlay', () => {
    const r = deriveLeadDisplayStatus({ ...base, offerStatus: 'signed', paymentConfirmedAt: '2026-05-27T00:00:00Z' })
    expect(r).toEqual({ label: 'Offer Sent', derived: false })
  })

  it('signed + activation activated → NOT the awaiting overlay', () => {
    const r = deriveLeadDisplayStatus({ ...base, offerStatus: 'signed', activationStatus: 'activated' })
    expect(r.derived).toBe(false)
  })

  it('Converted always wins, even if offer signed/unpaid', () => {
    const r = deriveLeadDisplayStatus({ ...base, leadStatus: 'Converted', offerStatus: 'signed', activationStatus: 'awaiting_payment' })
    expect(r).toEqual({ label: 'Converted', derived: false })
  })

  it('Lost / Suspended pass through unchanged', () => {
    expect(deriveLeadDisplayStatus({ ...base, leadStatus: 'Lost', offerStatus: 'signed' })).toEqual({ label: 'Lost', derived: false })
    expect(deriveLeadDisplayStatus({ ...base, leadStatus: 'Suspended', offerStatus: 'signed' })).toEqual({ label: 'Suspended', derived: false })
  })

  it('pre-sign states pass through unchanged (no regression)', () => {
    expect(deriveLeadDisplayStatus({ ...base, leadStatus: 'Offer Sent', offerStatus: 'viewed' })).toEqual({ label: 'Offer Sent', derived: false })
    expect(deriveLeadDisplayStatus({ ...base, leadStatus: 'New', offerStatus: 'draft' })).toEqual({ label: 'New', derived: false })
    expect(deriveLeadDisplayStatus({ ...base, leadStatus: 'Offer Sent', offerStatus: null })).toEqual({ label: 'Offer Sent', derived: false })
  })

  it('null lead status falls back to em dash', () => {
    expect(deriveLeadDisplayStatus({ ...base, leadStatus: null })).toEqual({ label: '—', derived: false })
  })
})
