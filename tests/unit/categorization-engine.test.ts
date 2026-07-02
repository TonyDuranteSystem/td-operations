/**
 * Categorization engine — DB-backed rules layered over the legacy built-ins
 * (master plan §8). applyRules is pure; rules are injected.
 */

import { describe, it, expect } from 'vitest'
import { applyRules, computeRecategorizationUpdates, type CategorizationRule } from '@/lib/tax/categorization-engine'
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

// The pure deterministic core extracted from recategorizeAccountYear so the
// standalone P&L workspace tool shares ONE algorithm with the client path
// (parity guarantee). recategorizeAccountYear now delegates to this — these
// tests pin the passes (rules → transfer pairs → own-entity) + determinism.
describe('computeRecategorizationUpdates (parity core)', () => {
  // A bank_transactions-shaped row (the columns the engine reads).
  const crow = (over: Partial<{
    id: string; transaction_date: string; description: string | null; counterparty: string | null;
    amount: number | string; currency: string | null; balance_after: number | null;
    transaction_ref: string | null; bank_name: string | null; account_type: string | null;
    category: string; subcategory: string | null; is_related_party: boolean | null;
    notes: string | null; ai_lean: string | null; ai_bucket: string | null;
  }> = {}) => ({
    id: 'row-x', transaction_date: '2025-06-01', description: 'GENERIC PMT 001', counterparty: '',
    amount: -100, currency: 'USD', balance_after: null, transaction_ref: 'ref-x',
    bank_name: 'Slash', account_type: 'USD', category: 'uncategorized', subcategory: null,
    is_related_party: false, notes: null, ai_lean: null, ai_bucket: null, ...over,
  })

  it('pass 1: a matching rule reclassifies the row', () => {
    const rows = [crow({ id: 'a', description: 'ZZQX VENDOR PMT', amount: -500 })]
    const rules = [rule({ pattern: 'ZZQX', category: 'expense', subcategory: 'vendor_payment' })]
    const { updates } = computeRecategorizationUpdates(rows, rules, [], '')
    expect(updates.get('a')?.category).toBe('expense')
  })

  it('never touches a human-corrected (manual:) row', () => {
    const rows = [crow({ id: 'm', description: 'ZZQX VENDOR PMT', amount: -500, notes: 'manual: client answer' })]
    const rules = [rule({ pattern: 'ZZQX', category: 'expense', subcategory: 'vendor_payment' })]
    const { updates } = computeRecategorizationUpdates(rows, rules, [], '')
    expect(updates.has('m')).toBe(false)
  })

  it('never downgrades an ai-tagged row back to uncategorized', () => {
    const rows = [crow({ id: 'ai', description: 'NO RULE HITS THIS', amount: -50, category: 'expense', notes: 'ai:high' })]
    const { updates } = computeRecategorizationUpdates(rows, [], [], '')
    expect(updates.has('ai')).toBe(false) // stays expense; no downgrade
  })

  it('pass 2: an equal-and-opposite pair across two banks becomes an internal transfer', () => {
    const rows = [
      crow({ id: 'out', description: 'XFER OUT', amount: -1000, bank_name: 'Wise', transaction_ref: 'o1' }),
      crow({ id: 'in', description: 'XFER IN', amount: 1000, bank_name: 'Mercury', transaction_ref: 'i1' }),
    ]
    const { updates, transferPairs } = computeRecategorizationUpdates(rows, [], [], '')
    expect(transferPairs).toBe(1)
    expect(updates.get('out')?.category).toBe('conversion')
    expect(updates.get('out')?.subcategory).toBe('internal_transfer')
    expect(updates.get('in')?.category).toBe('conversion')
  })

  it('pass 2b: money to the company’s own name is an internal transfer (no matching leg)', () => {
    const rows = [crow({ id: 'own', description: 'Payment to Acme Holdings LLC', amount: -2000, category: 'expense' })]
    const { updates } = computeRecategorizationUpdates(rows, [], [], 'Acme Holdings LLC')
    expect(updates.get('own')?.category).toBe('conversion')
    expect(updates.get('own')?.subcategory).toBe('internal_transfer')
  })

  it('is deterministic: identical inputs produce identical updates (parity guarantee)', () => {
    const build = () => [
      crow({ id: 'a', description: 'ZZQX VENDOR PMT', amount: -500 }),
      crow({ id: 'out', description: 'XFER OUT', amount: -1000, bank_name: 'Wise', transaction_ref: 'o1' }),
      crow({ id: 'in', description: 'XFER IN', amount: 1000, bank_name: 'Mercury', transaction_ref: 'i1' }),
    ]
    const rules = [rule({ pattern: 'ZZQX', category: 'expense', subcategory: 'vendor_payment' })]
    const a = computeRecategorizationUpdates(build(), rules, [], '')
    const b = computeRecategorizationUpdates(build(), rules, [], '')
    expect(Array.from(a.updates.entries()).sort()).toEqual(Array.from(b.updates.entries()).sort())
    expect(a.transferPairs).toBe(b.transferPairs)
  })
})
