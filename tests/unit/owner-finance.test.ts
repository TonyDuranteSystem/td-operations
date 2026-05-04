import { describe, it, expect } from 'vitest'
import { applyVendorRules, estimateQuarterlyTax, OWNER_ACCOUNT_ID, type OwnerTransaction, type VendorRule } from '@/lib/owner-finance'

const makeTx = (overrides: Partial<OwnerTransaction> = {}): OwnerTransaction => ({
  id: 'test-id',
  transaction_date: '2025-03-15',
  description: 'Test transaction',
  category: 'uncategorized',
  subcategory: null,
  counterparty: 'Test Vendor',
  amount: -500,
  currency: 'USD',
  balance_after: null,
  bank_name: 'Mercury',
  account_type: 'checking',
  transaction_ref: null,
  is_related_party: false,
  notes: null,
  tax_year: 2025,
  created_at: '2025-03-15T00:00:00Z',
  ...overrides,
})

const makeRule = (overrides: Partial<VendorRule> = {}): VendorRule => ({
  id: 'rule-id',
  counterparty_pattern: 'test vendor',
  match_type: 'exact',
  category: 'expense',
  subcategory: 'software',
  is_related_party: false,
  notes: null,
  ...overrides,
})

describe('OWNER_ACCOUNT_ID', () => {
  it('has the fixed owner UUID', () => {
    expect(OWNER_ACCOUNT_ID).toBe('00000000-0000-0000-0000-000000000001')
  })
})

describe('applyVendorRules', () => {
  it('returns transactions unchanged when no rules match', () => {
    const txs = [makeTx()]
    const result = applyVendorRules(txs, [])
    expect(result[0].category).toBe('uncategorized')
  })

  it('skips already-categorized transactions', () => {
    const tx = makeTx({ category: 'income' })
    const rule = makeRule({ counterparty_pattern: 'test vendor' })
    const result = applyVendorRules([tx], [rule])
    expect(result[0].category).toBe('income')
  })

  it('applies exact match rule', () => {
    const tx = makeTx({ counterparty: 'Test Vendor' })
    const rule = makeRule({ counterparty_pattern: 'test vendor', match_type: 'exact' })
    const result = applyVendorRules([tx], [rule])
    expect(result[0].category).toBe('expense')
    expect(result[0].subcategory).toBe('software')
  })

  it('applies contains match rule', () => {
    const tx = makeTx({ counterparty: 'Zoho-One Monthly Charge' })
    const rule = makeRule({ counterparty_pattern: 'zoho', match_type: 'contains', subcategory: 'saas' })
    const result = applyVendorRules([tx], [rule])
    expect(result[0].category).toBe('expense')
    expect(result[0].subcategory).toBe('saas')
  })

  it('applies regex match rule', () => {
    const tx = makeTx({ counterparty: 'Airwallex Wire #12345' })
    const rule = makeRule({ counterparty_pattern: 'airwallex.*wire', match_type: 'regex', category: 'conversion' })
    const result = applyVendorRules([tx], [rule])
    expect(result[0].category).toBe('conversion')
  })

  it('handles invalid regex gracefully without throwing', () => {
    const tx = makeTx()
    const rule = makeRule({ counterparty_pattern: '[invalid(regex', match_type: 'regex' })
    expect(() => applyVendorRules([tx], [rule])).not.toThrow()
    expect(applyVendorRules([tx], [rule])[0].category).toBe('uncategorized')
  })

  it('matches using description when counterparty is null', () => {
    const tx = makeTx({ counterparty: null, description: 'Zoho subscription' })
    const rule = makeRule({ counterparty_pattern: 'zoho subscription', match_type: 'exact' })
    const result = applyVendorRules([tx], [rule])
    expect(result[0].category).toBe('expense')
  })

  it('sets is_related_party from matching rule', () => {
    const tx = makeTx({ counterparty: 'Luca DeG' })
    const rule = makeRule({ counterparty_pattern: 'luca deg', match_type: 'exact', is_related_party: true, category: 'cogs', subcategory: 'contractor' })
    const result = applyVendorRules([tx], [rule])
    expect(result[0].is_related_party).toBe(true)
  })
})

describe('estimateQuarterlyTax', () => {
  it('returns 25% of net profit as annual tax by default', () => {
    const { annual } = estimateQuarterlyTax(100000)
    expect(annual).toBe(25000)
  })

  it('splits annual tax into 4 quarterly payments', () => {
    const { quarterly } = estimateQuarterlyTax(100000)
    expect(quarterly).toBe(6250)
  })

  it('respects custom effective rate', () => {
    const { annual } = estimateQuarterlyTax(100000, 0.30)
    expect(annual).toBe(30000)
  })

  it('returns 0 for negative net profit', () => {
    const { annual, quarterly } = estimateQuarterlyTax(-50000)
    expect(annual).toBe(0)
    expect(quarterly).toBe(0)
  })

  it('returns 0 for zero net profit', () => {
    const { annual } = estimateQuarterlyTax(0)
    expect(annual).toBe(0)
  })
})
