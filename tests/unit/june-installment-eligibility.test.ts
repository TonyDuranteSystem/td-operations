import { describe, it, expect } from 'vitest'
import { decideJuneInstallment, type JuneInstallmentInput } from '@/lib/billing/june-installment-eligibility'

// base = a normal renewing client: became our client in 2024.
const base: JuneInstallmentInput = {
  year: 2026,
  account_type: 'Client',
  status: 'Active',
  is_test: false,
  installment_2_amount: 1000,
  ra_switch_date: null,
  client_since: '2024-03-01',
  formation_date: '2024-02-01',
  hasFirstInstallmentThisYear: true,
  hasSignedAgreementThisYear: false,
  hasExistingSecondInstallment: false,
  hasClientOnboardingService: false,
}
const make = (o: Partial<JuneInstallmentInput>): JuneInstallmentInput => ({ ...base, ...o })

describe('decideJuneInstallment — 2026 transition', () => {
  it('invoices an active client with a 1st installment, using the CRM amount', () => {
    expect(decideJuneInstallment(make({ installment_2_amount: 1250 }))).toEqual({
      action: 'invoice', amount: 1250, reason: 'eligible',
    })
  })

  it('uses non-standard CRM amounts verbatim (e.g. 849, 925, 2000) — never a default', () => {
    for (const amt of [849, 925, 1150, 2000, 600]) {
      const d = decideJuneInstallment(make({ installment_2_amount: amt }))
      expect(d.action).toBe('invoice')
      expect(d.amount).toBe(amt)
    }
  })

  it('invoices an Overdue-1st client (1st record exists even if unpaid)', () => {
    expect(decideJuneInstallment(make({ hasFirstInstallmentThisYear: true })).action).toBe('invoice')
  })

  it('skip + alert when installment_2_amount is null', () => {
    expect(decideJuneInstallment(make({ installment_2_amount: null })).action).toBe('needs_amount')
  })

  it('skip + alert when installment_2_amount is 0 (never falls back to a default)', () => {
    expect(decideJuneInstallment(make({ installment_2_amount: 0 })).action).toBe('needs_amount')
  })

  it('marks exists when a 2nd installment already exists (any route — fixes the dup gap)', () => {
    expect(decideJuneInstallment(make({ hasExistingSecondInstallment: true })).action).toBe('exists')
  })

  it('skips when no 1st installment and a normal (pre-Sept) older start', () => {
    const d = decideJuneInstallment(make({ hasFirstInstallmentThisYear: false, client_since: '2025-05-01', formation_date: '2025-05-01' }))
    expect(d.action).toBe('skip')
  })

  it('flags a Sep–Dec 2025 starter with no 1st installment (owes June, manual)', () => {
    const d = decideJuneInstallment(make({ hasFirstInstallmentThisYear: false, client_since: '2025-09-26', formation_date: '2025-09-26' }))
    expect(d.action).toBe('flag')
  })
})

describe('decideJuneInstallment — Year-1 (became our client in the billing year) is skipped FIRST', () => {
  it('skips a formed-by-us 2026 client (no client_since → formation date is the start)', () => {
    const d = decideJuneInstallment(make({ client_since: null, formation_date: '2026-02-13', hasFirstInstallmentThisYear: false }))
    expect(d.action).toBe('skip')
    expect(d.reason).toMatch(/Year-1/)
  })

  it('AZOR CASE: onboarded in 2026 (client_since 2026, company formed earlier) → skip even WITH a (fake) 1st installment', () => {
    const d = decideJuneInstallment(make({ client_since: '2026-01-29', formation_date: '2025-10-09', hasFirstInstallmentThisYear: true }))
    expect(d.action).toBe('skip')
    expect(d.reason).toMatch(/Year-1/)
  })

  it('Year-1 overrides even an already-existing 2nd installment', () => {
    const d = decideJuneInstallment(make({ client_since: '2026-03-01', hasExistingSecondInstallment: true }))
    expect(d.action).toBe('skip')
    expect(d.reason).toMatch(/Year-1/)
  })

  it('client_since takes precedence over formation_date: onboarded 2024 but company formed 2019 → normal renewal, invoiced', () => {
    const d = decideJuneInstallment(make({ client_since: '2024-05-01', formation_date: '2019-01-01', hasFirstInstallmentThisYear: true }))
    expect(d.action).toBe('invoice')
  })

  it('client_since precedence: onboarded Sep 2025 with old formation → September flag (uses client_since, not formation)', () => {
    const d = decideJuneInstallment(make({ client_since: '2025-09-26', formation_date: '2020-01-01', hasFirstInstallmentThisYear: false }))
    expect(d.action).toBe('flag')
  })
})

describe('decideJuneInstallment — date-driven start (RA switch → client since → formation)', () => {
  it('uses ra_switch_date over client_since and formation_date (onboarded client)', () => {
    // RA switch in 2026 = Year-1 even though client_since/formation are older.
    const d = decideJuneInstallment(make({
      ra_switch_date: '2026-02-10', client_since: '2024-01-01', formation_date: '2019-01-01',
      hasFirstInstallmentThisYear: true,
    }))
    expect(d.action).toBe('skip')
    expect(d.reason).toMatch(/Year-1/)
  })

  it('falls back to client_since when ra_switch_date is null', () => {
    const d = decideJuneInstallment(make({
      ra_switch_date: null, client_since: '2026-03-01', formation_date: '2018-01-01',
      hasFirstInstallmentThisYear: true,
    }))
    expect(d.action).toBe('skip')
    expect(d.reason).toMatch(/Year-1/)
  })

  it('falls back to formation_date when no onboarding date exists (formed-by-us client)', () => {
    const d = decideJuneInstallment(make({
      ra_switch_date: null, client_since: null, formation_date: '2026-02-13',
      hasFirstInstallmentThisYear: false,
    }))
    expect(d.action).toBe('skip')
    expect(d.reason).toMatch(/Year-1/)
  })

  it('an onboarded client whose RA switch was an older year is billed normally', () => {
    const d = decideJuneInstallment(make({
      ra_switch_date: '2024-06-01', client_since: null, formation_date: '2015-01-01',
      hasFirstInstallmentThisYear: true,
    }))
    expect(d.action).toBe('invoice')
  })
})

describe('decideJuneInstallment — missing-start-date tripwire', () => {
  it('FLAGS a Client Onboarding account with no RA switch and no client since', () => {
    const d = decideJuneInstallment(make({
      hasClientOnboardingService: true, ra_switch_date: null, client_since: null,
      formation_date: '2018-01-01', hasFirstInstallmentThisYear: true,
    }))
    expect(d.action).toBe('flag')
    expect(d.reason).toMatch(/missing start date/)
  })

  it('does NOT flag when the onboarding client has an RA switch date', () => {
    const d = decideJuneInstallment(make({
      hasClientOnboardingService: true, ra_switch_date: '2024-05-01', client_since: null,
      formation_date: '2018-01-01', hasFirstInstallmentThisYear: true,
    }))
    expect(d.action).toBe('invoice')
  })

  it('does NOT flag when the onboarding client has a client since date', () => {
    const d = decideJuneInstallment(make({
      hasClientOnboardingService: true, ra_switch_date: null, client_since: '2024-05-01',
      formation_date: '2018-01-01', hasFirstInstallmentThisYear: true,
    }))
    expect(d.action).toBe('invoice')
  })

  it('does NOT flag a formation client (no onboarding service) with a formation date', () => {
    const d = decideJuneInstallment(make({
      hasClientOnboardingService: false, ra_switch_date: null, client_since: null,
      formation_date: '2020-01-01', hasFirstInstallmentThisYear: true,
    }))
    expect(d.action).toBe('invoice')
  })

  it('FLAGS a client with no usable date at all (no RA switch, no client since, no formation)', () => {
    const d = decideJuneInstallment(make({
      hasClientOnboardingService: false, ra_switch_date: null, client_since: null,
      formation_date: null, hasFirstInstallmentThisYear: true,
    }))
    expect(d.action).toBe('flag')
    expect(d.reason).toMatch(/missing start date/)
  })

  it('tripwire fires only after the hard exclusions (cancelled onboarding client still skips)', () => {
    const d = decideJuneInstallment(make({
      status: 'Cancelled', hasClientOnboardingService: true, ra_switch_date: null, client_since: null,
    }))
    expect(d.action).toBe('skip')
    expect(d.reason).toMatch(/not Active/)
  })
})

describe('decideJuneInstallment — hard exclusions', () => {
  it('skips non-Active status', () => {
    for (const status of ['Cancelled', 'Closed', 'Offboarding', 'Suspended']) {
      expect(decideJuneInstallment(make({ status })).action).toBe('skip')
    }
  })

  it('skips non-Client account types', () => {
    for (const account_type of ['One-Time', 'Partner']) {
      expect(decideJuneInstallment(make({ account_type })).action).toBe('skip')
    }
  })

  it('skips test accounts', () => {
    expect(decideJuneInstallment(make({ is_test: true })).action).toBe('skip')
  })

  it('exclusions win even if otherwise eligible', () => {
    expect(decideJuneInstallment(make({ account_type: 'One-Time', installment_2_amount: 1000 })).action).toBe('skip')
  })
})

describe('decideJuneInstallment — 2027+ permanent regime', () => {
  it('invoices when a signed agreement exists for the year', () => {
    const d = decideJuneInstallment(make({ year: 2027, client_since: '2024-03-01', hasSignedAgreementThisYear: true, hasFirstInstallmentThisYear: false }))
    expect(d).toEqual({ action: 'invoice', amount: 1000, reason: 'eligible' })
  })

  it('skips when no signed agreement (1st-installment presence is irrelevant in 2027+)', () => {
    const d = decideJuneInstallment(make({ year: 2027, hasSignedAgreementThisYear: false, hasFirstInstallmentThisYear: true }))
    expect(d.action).toBe('skip')
    expect(d.reason).toMatch(/no signed/)
  })

  it('still needs a CRM amount in 2027+', () => {
    const d = decideJuneInstallment(make({ year: 2027, hasSignedAgreementThisYear: true, installment_2_amount: null }))
    expect(d.action).toBe('needs_amount')
  })

  it('duplicate guard applies in 2027+ too', () => {
    const d = decideJuneInstallment(make({ year: 2027, hasSignedAgreementThisYear: true, hasExistingSecondInstallment: true }))
    expect(d.action).toBe('exists')
  })
})
