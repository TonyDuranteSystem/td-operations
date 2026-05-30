import { describe, it, expect } from 'vitest'
import {
  computeBillingStatus,
  BillingAccountInput,
  BillingPaymentRow,
  BillingAgreementRow,
} from '@/lib/audit/billing-status'

const CLIENT: BillingAccountInput = {
  account_type: 'Client',
  onboarding_date: '2024-03-01',
  installment_2_amount: 1000,
  installment_2_currency: 'USD',
}

const NO_AGREEMENTS: BillingAgreementRow[] = []
const NO_PAYMENTS: BillingPaymentRow[] = []

const SIGNED_2026: BillingAgreementRow = { agreement_year: 2026, status: 'signed' }
const DRAFT_2026: BillingAgreementRow = { agreement_year: 2026, status: 'draft' }

const INST1_PAID: BillingPaymentRow = {
  installment: 'Installment 1 (Jan)',
  description: 'Annual billing 2026',
  payment_category: 'installment_1',
  year: 2026,
  amount: 1500,
  amount_currency: 'USD',
  invoice_number: 'INV-000001',
  invoice_status: 'Paid',
  paid_date: '2026-01-15',
}

const INST1_SENT: BillingPaymentRow = {
  ...INST1_PAID,
  invoice_status: 'Sent',
  paid_date: null,
}

const INST2_PAID: BillingPaymentRow = {
  installment: 'Installment 2 (Jun)',
  description: 'Annual billing 2026',
  payment_category: 'installment_2',
  year: 2026,
  amount: 1000,
  amount_currency: 'USD',
  invoice_number: 'INV-000002',
  invoice_status: 'Paid',
  paid_date: '2026-06-15',
}

describe('computeBillingStatus — N/A cases', () => {
  it('One-Time account → isNA true, single na check', () => {
    const r = computeBillingStatus(
      { ...CLIENT, account_type: 'One-Time' },
      NO_PAYMENTS, NO_AGREEMENTS, 2026, 3,
    )
    expect(r.isNA).toBe(true)
    expect(r.hasGap).toBe(false)
    expect(r.checks).toHaveLength(1)
    expect(r.checks[0].status).toBe('na')
    expect(r.checks[0].context).toContain('One-Time')
  })

  it('Partner account → isNA true', () => {
    const r = computeBillingStatus(
      { ...CLIENT, account_type: 'Partner' },
      NO_PAYMENTS, NO_AGREEMENTS, 2026, 3,
    )
    expect(r.isNA).toBe(true)
    expect(r.checks[0].context).toContain('Partner')
  })

  it('Client with no onboarding_date → isNA true', () => {
    const r = computeBillingStatus(
      { ...CLIENT, onboarding_date: null },
      NO_PAYMENTS, NO_AGREEMENTS, 2026, 3,
    )
    expect(r.isNA).toBe(true)
    expect(r.hasGap).toBe(false)
    expect(r.checks[0].context).toContain('onboarding')
  })
})

describe('computeBillingStatus — agreement check', () => {
  it('no agreement for year → agreement_signed missing', () => {
    const r = computeBillingStatus(CLIENT, NO_PAYMENTS, NO_AGREEMENTS, 2026, 3)
    expect(r.isNA).toBe(false)
    const chk = r.checks.find(c => c.key === 'agreement_signed')!
    expect(chk.status).toBe('missing')
    expect(chk.context).toContain('No agreement')
  })

  it('draft agreement → agreement_signed missing with status context', () => {
    const r = computeBillingStatus(CLIENT, NO_PAYMENTS, [DRAFT_2026], 2026, 3)
    const chk = r.checks.find(c => c.key === 'agreement_signed')!
    expect(chk.status).toBe('missing')
    expect(chk.context).toContain('draft')
  })

  it('signed agreement → agreement_signed ok', () => {
    const r = computeBillingStatus(CLIENT, NO_PAYMENTS, [SIGNED_2026], 2026, 3)
    const chk = r.checks.find(c => c.key === 'agreement_signed')!
    expect(chk.status).toBe('ok')
  })

  it('completed agreement → agreement_signed ok', () => {
    const r = computeBillingStatus(
      CLIENT, NO_PAYMENTS,
      [{ agreement_year: 2026, status: 'completed' }],
      2026, 3,
    )
    const chk = r.checks.find(c => c.key === 'agreement_signed')!
    expect(chk.status).toBe('ok')
  })
})

describe('computeBillingStatus — installment 1 checks', () => {
  it('signed agreement, no inst1 → inst1_invoiced missing', () => {
    const r = computeBillingStatus(CLIENT, NO_PAYMENTS, [SIGNED_2026], 2026, 3)
    const chk = r.checks.find(c => c.key === 'inst1_invoiced')!
    expect(chk.status).toBe('missing')
    expect(chk.context).toContain('no Installment 1')
  })

  it('no signed agreement → inst1_invoiced na', () => {
    const r = computeBillingStatus(CLIENT, NO_PAYMENTS, NO_AGREEMENTS, 2026, 3)
    const chk = r.checks.find(c => c.key === 'inst1_invoiced')!
    expect(chk.status).toBe('na')
  })

  it('inst1 present → inst1_invoiced ok with amount', () => {
    const r = computeBillingStatus(CLIENT, [INST1_PAID], [SIGNED_2026], 2026, 3)
    const chk = r.checks.find(c => c.key === 'inst1_invoiced')!
    expect(chk.status).toBe('ok')
    expect(chk.amount).toBe(1500)
    expect(chk.invoiceNumber).toBe('INV-000001')
  })

  it('inst1 Sent (not paid) → inst1_paid missing', () => {
    const r = computeBillingStatus(CLIENT, [INST1_SENT], [SIGNED_2026], 2026, 3)
    const chk = r.checks.find(c => c.key === 'inst1_paid')!
    expect(chk.status).toBe('missing')
    expect(chk.context).toContain('Sent')
  })

  it('inst1 Paid → inst1_paid ok with paid date', () => {
    const r = computeBillingStatus(CLIENT, [INST1_PAID], [SIGNED_2026], 2026, 3)
    const chk = r.checks.find(c => c.key === 'inst1_paid')!
    expect(chk.status).toBe('ok')
    expect(chk.context).toContain('2026-01-15')
  })

  it('no agreement, no inst1 → inst1_paid na', () => {
    const r = computeBillingStatus(CLIENT, NO_PAYMENTS, NO_AGREEMENTS, 2026, 3)
    const chk = r.checks.find(c => c.key === 'inst1_paid')!
    expect(chk.status).toBe('na')
  })
})

describe('computeBillingStatus — installment 2 checks (month-gated)', () => {
  it('signed, inst1 paid, month=3 (before June) → inst2_invoiced not_yet_due', () => {
    const r = computeBillingStatus(CLIENT, [INST1_PAID], [SIGNED_2026], 2026, 3)
    const chk = r.checks.find(c => c.key === 'inst2_invoiced')!
    expect(chk.status).toBe('not_yet_due')
    expect(chk.context).toContain('June')
  })

  it('signed, inst1 paid, month=5 (May, before June) → inst2 not_yet_due', () => {
    const r = computeBillingStatus(CLIENT, [INST1_PAID], [SIGNED_2026], 2026, 5)
    expect(r.checks.find(c => c.key === 'inst2_invoiced')!.status).toBe('not_yet_due')
    expect(r.checks.find(c => c.key === 'inst2_paid')!.status).toBe('not_yet_due')
  })

  it('signed, month=6 (June), no inst2 → inst2_invoiced missing', () => {
    const r = computeBillingStatus(CLIENT, [INST1_PAID], [SIGNED_2026], 2026, 6)
    const chk = r.checks.find(c => c.key === 'inst2_invoiced')!
    expect(chk.status).toBe('missing')
    expect(chk.context).toContain('June passed')
  })

  it('signed, month=9, no inst2 → inst2_paid missing', () => {
    const r = computeBillingStatus(CLIENT, [INST1_PAID], [SIGNED_2026], 2026, 9)
    expect(r.checks.find(c => c.key === 'inst2_paid')!.status).toBe('missing')
  })

  it('inst2 paid → inst2_invoiced ok and inst2_paid ok', () => {
    const r = computeBillingStatus(
      CLIENT, [INST1_PAID, INST2_PAID], [SIGNED_2026], 2026, 7,
    )
    expect(r.checks.find(c => c.key === 'inst2_invoiced')!.status).toBe('ok')
    expect(r.checks.find(c => c.key === 'inst2_paid')!.status).toBe('ok')
  })

  it('no signed agreement → inst2_invoiced na', () => {
    const r = computeBillingStatus(CLIENT, NO_PAYMENTS, NO_AGREEMENTS, 2026, 9)
    expect(r.checks.find(c => c.key === 'inst2_invoiced')!.status).toBe('na')
    expect(r.checks.find(c => c.key === 'inst2_paid')!.status).toBe('na')
  })

  it('inst2 payments only matched when the structured year matches (not the description)', () => {
    const wrongYear: BillingPaymentRow = {
      ...INST2_PAID,
      year: 2025, // structured year is what counts…
      description: 'Annual billing 2026', // …even though the description says 2026
    }
    const r = computeBillingStatus(CLIENT, [INST1_PAID, wrongYear], [SIGNED_2026], 2026, 7)
    expect(r.checks.find(c => c.key === 'inst2_invoiced')!.status).toBe('missing')
  })
})

describe('computeBillingStatus — inst2_amount check', () => {
  it('installment_2_amount null → inst2_amount missing', () => {
    const r = computeBillingStatus(
      { ...CLIENT, installment_2_amount: null },
      NO_PAYMENTS, [SIGNED_2026], 2026, 3,
    )
    const chk = r.checks.find(c => c.key === 'inst2_amount')!
    expect(chk.status).toBe('missing')
    expect(chk.context).toContain('Not set')
  })

  it('installment_2_amount 0 → inst2_amount missing', () => {
    const r = computeBillingStatus(
      { ...CLIENT, installment_2_amount: 0 },
      NO_PAYMENTS, [SIGNED_2026], 2026, 3,
    )
    expect(r.checks.find(c => c.key === 'inst2_amount')!.status).toBe('missing')
  })

  it('installment_2_amount set → inst2_amount ok with value', () => {
    const r = computeBillingStatus(CLIENT, NO_PAYMENTS, [SIGNED_2026], 2026, 3)
    const chk = r.checks.find(c => c.key === 'inst2_amount')!
    expect(chk.status).toBe('ok')
    expect(chk.context).toContain('1000')
    expect(chk.amount).toBe(1000)
  })
})

describe('computeBillingStatus — hasGap aggregation', () => {
  it('missing agreement → hasGap true', () => {
    const r = computeBillingStatus(CLIENT, NO_PAYMENTS, NO_AGREEMENTS, 2026, 3)
    expect(r.hasGap).toBe(true)
  })

  it('all checks ok/not_yet_due before June → hasGap false', () => {
    const r = computeBillingStatus(CLIENT, [INST1_PAID], [SIGNED_2026], 2026, 3)
    expect(r.hasGap).toBe(false)
  })

  it('all checks ok after June → hasGap false', () => {
    const r = computeBillingStatus(
      CLIENT, [INST1_PAID, INST2_PAID], [SIGNED_2026], 2026, 8,
    )
    expect(r.hasGap).toBe(false)
  })

  it('inst2 missing after June with no inst2_amount → hasGap true', () => {
    const r = computeBillingStatus(
      { ...CLIENT, installment_2_amount: null },
      [INST1_PAID], [SIGNED_2026], 2026, 8,
    )
    expect(r.hasGap).toBe(true)
  })

  it('returns exactly 6 checks for a Client account', () => {
    const r = computeBillingStatus(CLIENT, NO_PAYMENTS, [SIGNED_2026], 2026, 3)
    expect(r.checks).toHaveLength(6)
  })
})
