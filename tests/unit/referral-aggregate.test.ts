import { describe, it, expect } from 'vitest'
import {
  computePrimaryAccountIds,
  currencySymbol,
  formatMoney,
  sumEarnedByCurrency,
  formatEarnedSummary,
  leadStatusBadge,
  type AccountMembership,
} from '@/lib/portal/referral-aggregate'

const ME = 'contact-me'
const OTHER = 'contact-other'
const ACC_SOLE = 'acc-sole'
const ACC_MULTI = 'acc-multi'

describe('computePrimaryAccountIds', () => {
  it('treats the sole member of a single-member account as primary (the Achievers/Andrea case)', () => {
    // Andrea is the only member, tagged role=Member, is_primary=false.
    const members: AccountMembership[] = [
      { account_id: ACC_SOLE, contact_id: ME, is_primary: false },
    ]
    expect(computePrimaryAccountIds(ME, [ACC_SOLE], members)).toEqual([ACC_SOLE])
  })

  it('does NOT make a non-primary member of a multi-member account primary (leak guard)', () => {
    const members: AccountMembership[] = [
      { account_id: ACC_MULTI, contact_id: ME, is_primary: false },
      { account_id: ACC_MULTI, contact_id: OTHER, is_primary: false },
    ]
    expect(computePrimaryAccountIds(ME, [ACC_MULTI], members)).toEqual([])
  })

  it('honors an explicit is_primary flag on a multi-member account', () => {
    const members: AccountMembership[] = [
      { account_id: ACC_MULTI, contact_id: ME, is_primary: true },
      { account_id: ACC_MULTI, contact_id: OTHER, is_primary: false },
    ]
    expect(computePrimaryAccountIds(ME, [ACC_MULTI], members)).toEqual([ACC_MULTI])
  })

  it('excludes me when someone ELSE is the flagged primary', () => {
    const members: AccountMembership[] = [
      { account_id: ACC_MULTI, contact_id: ME, is_primary: false },
      { account_id: ACC_MULTI, contact_id: OTHER, is_primary: true },
    ]
    expect(computePrimaryAccountIds(ME, [ACC_MULTI], members)).toEqual([])
  })

  it('handles multiple accounts independently', () => {
    const members: AccountMembership[] = [
      { account_id: ACC_SOLE, contact_id: ME, is_primary: false },
      { account_id: ACC_MULTI, contact_id: ME, is_primary: false },
      { account_id: ACC_MULTI, contact_id: OTHER, is_primary: false },
    ]
    expect(computePrimaryAccountIds(ME, [ACC_SOLE, ACC_MULTI], members)).toEqual([ACC_SOLE])
  })

  it('returns empty when the contact has no accounts', () => {
    expect(computePrimaryAccountIds(ME, [], [])).toEqual([])
  })
})

describe('currency formatting', () => {
  it('maps known currency codes to symbols', () => {
    expect(currencySymbol('USD')).toBe('$')
    expect(currencySymbol('EUR')).toBe('€')
    expect(currencySymbol('usd')).toBe('$')
  })

  it('defaults to € when currency is missing', () => {
    expect(currencySymbol(null)).toBe('€')
    expect(currencySymbol(undefined)).toBe('€')
  })

  it('falls back to the code prefix for unknown currencies', () => {
    expect(currencySymbol('CHF')).toBe('CHF ')
  })

  it('formats money with the right symbol', () => {
    expect(formatMoney(300, 'USD')).toBe('$300')
    expect(formatMoney(250, 'EUR')).toBe('€250')
    expect(formatMoney(null, 'EUR')).toBe('€0')
  })
})

describe('sumEarnedByCurrency', () => {
  it('sums credited + paid grouped by currency, skipping zero rows', () => {
    const rows = [
      { credited_amount: 300, paid_amount: 0, commission_currency: 'USD' },
      { credited_amount: 0, paid_amount: 0, commission_currency: 'EUR' }, // Dionisie: converted, not credited
    ]
    expect(sumEarnedByCurrency(rows)).toEqual({ USD: 300 })
  })

  it('keeps USD and EUR separate (never merges)', () => {
    const rows = [
      { credited_amount: 300, paid_amount: 0, commission_currency: 'USD' },
      { credited_amount: 200, paid_amount: 50, commission_currency: 'EUR' },
    ]
    expect(sumEarnedByCurrency(rows)).toEqual({ USD: 300, EUR: 250 })
  })

  it('defaults a missing currency to EUR', () => {
    const rows = [{ credited_amount: 100, paid_amount: 0, commission_currency: null }]
    expect(sumEarnedByCurrency(rows)).toEqual({ EUR: 100 })
  })
})

describe('formatEarnedSummary', () => {
  it('renders a single currency', () => {
    expect(formatEarnedSummary({ USD: 300 })).toBe('$300')
  })

  it('renders multiple currencies joined', () => {
    expect(formatEarnedSummary({ USD: 300, EUR: 250 })).toBe('$300 · €250')
  })

  it('renders €0 when nothing earned', () => {
    expect(formatEarnedSummary({})).toBe('€0')
  })
})

describe('leadStatusBadge', () => {
  it('maps known funnel statuses to a translation key, not pre-resolved text', () => {
    expect(leadStatusBadge('Offer Sent').labelKey).toBe('leadStatus.offerSent')
    expect(leadStatusBadge('Call Done').labelKey).toBe('leadStatus.callDone')
    expect(leadStatusBadge('Paid').color).toContain('emerald')
  })

  it('keeps Lost as Lost (per Antonio)', () => {
    expect(leadStatusBadge('Lost').labelKey).toBe('leadStatus.lost')
    expect(leadStatusBadge('Lost').color).toContain('red')
  })

  it('falls back to the raw value for unknown/empty status — no labelKey, so the caller shows rawLabel as-is rather than mistranslating it', () => {
    expect(leadStatusBadge('Weird').labelKey).toBeNull()
    expect(leadStatusBadge('Weird').rawLabel).toBe('Weird')
    expect(leadStatusBadge('').labelKey).toBeNull()
    expect(leadStatusBadge('').rawLabel).toBe('Pending')
    expect(leadStatusBadge(null).rawLabel).toBe('Pending')
  })
})
