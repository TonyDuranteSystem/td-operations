/**
 * Categorization engine — DB-backed rules layered over the legacy built-ins
 * (master plan §8). applyRules is pure; rules are injected.
 */

import { describe, it, expect } from 'vitest'
import { applyRules, type CategorizationRule } from '@/lib/tax/categorization-engine'
import type { ParsedTransaction } from '@/lib/bank-statement-parser'

const tx = (description: string, amount: number, over: Partial<ParsedTransaction> = {}): ParsedTransaction => ({
  transaction_date: '2025-06-01', description, counterparty: '', amount,
  currency: 'USD', balance_after: null, transaction_ref: 'r1',
  bank_name: 'Slash', account_type: 'USD', ...over,
})

const rule = (over: Partial<CategorizationRule>): CategorizationRule => ({
  id: 'x', pattern: '', match_type: 'contains', category: 'expense', subcategory: '',
  account_id: null, priority: 100, direction: 'any', ...over,
})

describe('applyRules', () => {
  it('direction gating: STRIPE inflow is revenue, STRIPE outflow is not', () => {
    const stripe = rule({ pattern: 'STRIPE', category: 'income', subcategory: 'revenue', direction: 'in' })
    expect(applyRules(tx('Payout STRIPE', 4421.93), [stripe]).category).toBe('income')
    expect(applyRules(tx('Payment to STRIPE', -100), [stripe]).category).toBe('uncategorized')
  })

  it('per-client rules beat global rules regardless of priority', () => {
    const global = rule({ pattern: 'ACME', category: 'expense', subcategory: 'vendor_payment', priority: 1 })
    const mine = rule({ pattern: 'ACME', category: 'cogs', subcategory: 'subcontractor', account_id: 'acct-1', priority: 999 })
    expect(applyRules(tx('ACME invoice', -500), [global, mine]).category).toBe('cogs')
  })

  it('falls back to the legacy built-ins when no DB rule matches', () => {
    const r = applyRules(tx('Received money from CLIENT X', 900), [])
    expect(r.category).toBe('income') // legacy built-in rule
  })

  it('bad regex in a rule never breaks ingestion', () => {
    const broken = rule({ pattern: '([invalid', match_type: 'regex' })
    expect(() => applyRules(tx('whatever', -1), [broken])).not.toThrow()
  })

  it('match types: exact and regex behave as specified', () => {
    const exact = rule({ pattern: 'wire fee', match_type: 'exact', category: 'fee', subcategory: 'bank_fee' })
    expect(applyRules(tx('Wire Fee', -3), [exact]).category).toBe('fee')
    expect(applyRules(tx('big wire fee charged', -3), [exact]).category).toBe('uncategorized')
    const re = rule({ pattern: '^Slash fee', match_type: 'regex', category: 'fee', subcategory: 'bank_fee' })
    expect(applyRules(tx('Slash fee: FX for 12.28.25', -1), [re]).category).toBe('fee')
  })

  it('keeps the legacy related-party detection alongside DB-rule categories', () => {
    const r = applyRules(
      tx('Wire to Mario Rossi personal', -2000),
      [rule({ pattern: 'Wire to', category: 'expense', subcategory: 'vendor_payment', direction: 'out' })],
      ['Mario Rossi'],
    )
    expect(r.category).toBe('expense')
    expect(r.is_related_party).toBe(true)
  })

  it('the verified Slash vocabulary categorizes via seed-shaped rules', () => {
    const seeds: CategorizationRule[] = [
      rule({ pattern: 'Inbound Ach Transfer', category: 'income', subcategory: 'revenue', direction: 'in' }),
      rule({ pattern: 'Daily Credit Card Payment', category: 'expense', subcategory: 'card_payment', direction: 'out', priority: 110 }),
      rule({ pattern: 'Deposit User Funds', category: 'contribution', subcategory: 'capital_contribution', direction: 'in', priority: 110 }),
    ]
    expect(applyRules(tx('Inbound Ach Transfer | Incoming ACH credit from CLIENT LLC', 15000), seeds).category).toBe('income')
    expect(applyRules(tx('Loan Transaction | Daily Credit Card Payment', -270.77), seeds).category).toBe('expense')
    expect(applyRules(tx('Deposit User Funds | ACH deposit from CHECKING (•••• 0000)', 8000), seeds).category).toBe('contribution')
  })
})
