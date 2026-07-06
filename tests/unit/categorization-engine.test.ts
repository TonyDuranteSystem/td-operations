/**
 * Categorization engine — DB-backed rules layered over the legacy built-ins
 * (master plan §8). applyRules is pure; rules are injected.
 */

import { describe, it, expect } from 'vitest'
import { applyRules, computeRecategorizationUpdates, decideAiSuggestion, type CategorizationRule } from '@/lib/tax/categorization-engine'
import type { AiSuggestion } from '@/lib/tax/ai-categorizer'
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

describe('applyRules — NULL-safe text fields (2026-07-06 crash fix)', () => {
  // The type says string, but DB rows cast into ParsedTransaction can carry
  // NULL (ingestion writes '' — direct inserts/tools don't). Hit live during
  // the S4 repro: ruleMatches threw on counterparty=null.
  const nullish = (over: Partial<ParsedTransaction>) =>
    tx('Google', -25, { counterparty: null as unknown as string, ...over })

  it('contains rule matches on description with NULL counterparty — no crash', () => {
    const r = rule({ pattern: 'google', category: 'expense', subcategory: 'software' })
    expect(applyRules(nullish({}), [r]).category).toBe('expense')
  })
  it('exact and regex rules survive NULL counterparty', () => {
    expect(applyRules(nullish({}), [rule({ pattern: 'Google', match_type: 'exact' })]).category).toBe('expense')
    expect(applyRules(nullish({}), [rule({ pattern: '^goo', match_type: 'regex' })]).category).toBe('expense')
  })
  it('NULL description too — falls through to uncategorized, no crash', () => {
    const row = tx('x', -25, { description: null as unknown as string, counterparty: null as unknown as string })
    expect(applyRules(row, [rule({ pattern: 'google' })]).category).toBe('uncategorized')
  })
  it('legacy member/related-party scan survives NULL counterparty', () => {
    const row = nullish({ description: 'Transfer to John Smith dividend' })
    const out = applyRules(row, [], ['John Smith'], ['Acme FZCO'])
    expect(out.is_related_party).toBe(true)
    expect(out.category).toBe('distribution')
  })
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

  // ── Chase vocabulary seeds (migration 20260702-2000, B&P $594k incident) ──
  // Line shapes are verbatim from the real B&P Chase export as the generic
  // parser stores them ("Description | Details | Type").
  it('the verified Chase vocabulary categorizes via the 20260702-2000 seed shapes', () => {
    const seeds: CategorizationRule[] = [
      rule({ pattern: 'ACCT_XFER', category: 'conversion', subcategory: 'internal_transfer', direction: 'any', priority: 90 }),
      rule({ pattern: 'Online Transfer (to|from) (MMA|CHK|SAV)\\s?\\.\\.\\..*transaction#', match_type: 'regex', category: 'conversion', subcategory: 'internal_transfer', direction: 'any', priority: 95 }),
      rule({ pattern: 'FEE_TRANSACTION', category: 'fee', subcategory: 'bank_fee', direction: 'out', priority: 100 }),
      rule({ pattern: 'SERVICE CHARGES FOR THE MONTH', category: 'fee', subcategory: 'bank_fee', direction: 'out', priority: 100 }),
      rule({ pattern: 'INTEREST PAYMENT', category: 'income', subcategory: 'interest_income', direction: 'in', priority: 100 }),
    ]
    // Internal transfers between the company's own Chase accounts — both directions.
    expect(applyRules(tx('Online Transfer to MMA ...2131 transaction#: 27277515768 12/10 | DEBIT | ACCT_XFER', -6500), seeds).category).toBe('conversion')
    expect(applyRules(tx('Online Transfer from MMA ...3326 transaction#: 27013472533 | CREDIT | ACCT_XFER', 7000), seeds).category).toBe('conversion')
    // Fees.
    expect(applyRules(tx('SERVICE CHARGES FOR THE MONTH OF NOVEMBER | DEBIT | FEE_TRANSACTION', -55), seeds).category).toBe('fee')
    expect(applyRules(tx('FOREIGN EXCHANGE RATE ADJUSTMENT FEE         07/19CapCut SI | DEBIT | FEE_TRANSACTION', -0.32), seeds).category).toBe('fee')
    // Savings interest is income.
    expect(applyRules(tx('INTEREST PAYMENT | CREDIT | MISC_CREDIT', 2.38), seeds).category).toBe('income')
    // NEGATIVE cases — real customer wires must stay untouched by the seeds
    // (they carry no seeded token): AXI and Chelton remain for own-entity/AI.
    expect(applyRules(tx('BOOK TRANSFER CREDIT B/O: NATIONAL WESTMINSTER BANK PLC LONDON GB ORG: AXI FINANCIAL SERVICES (UK)LTD REF: AXI FINANCIAL SERV/OCMT/USD25850,/ | CREDIT | WIRE_INCOMING', 25850), seeds).category).toBe('uncategorized')
    expect(applyRules(tx('BOOK TRANSFER CREDIT B/O: SVENSKA HANDELSBANKEN AB PUBL STOCKHOLM SE ORG: CHELTON AB | CREDIT | WIRE_INCOMING', 14029), seeds).category).toBe('uncategorized')
    // Zelle stays flagged for human review — no seed matches QUICKPAY lines.
    expect(applyRules(tx('Zelle payment to Antonio Durante 23929233474 | DEBIT | QUICKPAY_DEBIT', -275), seeds).category).toBe('uncategorized')
    // Deposit-return pair stays flagged (pre-mortem: a refund seed would inflate expenses).
    expect(applyRules(tx('DEPOSITED ITEM RETURNED       Stop Payment   099002789 | DEBIT | DEPOSIT_RETURN', -2793.59), seeds).category).toBe('uncategorized')
  })
})

// The pure deterministic core extracted from recategorizeAccountYear so the
// standalone P&L workspace tool shares ONE algorithm with the client path
// (parity guarantee). recategorizeAccountYear now delegates to this — these
// tests pin the passes (rules → transfer pairs → own-entity) + determinism.
describe('computeRecategorizationUpdates (parity core)', () => {
  describe('zero-amount stability across re-runs (oscillation fix, dev_task 40b02405)', () => {
    it('run 1 books an open zero row as conversion/zero_amount', () => {
      const row = crow({ amount: 0 })
      const { updates } = computeRecategorizationUpdates([row], [], [], '')
      expect(updates.get('row-x')).toMatchObject({ category: 'conversion', subcategory: 'zero_amount', notes: 'auto: zero-amount' })
    })
    it('run 2 (row now booked, auto: note) does NOT downgrade back to uncategorized', () => {
      const booked = crow({ amount: 0, category: 'conversion', subcategory: 'zero_amount', notes: 'auto: zero-amount' })
      const { updates } = computeRecategorizationUpdates([booked], [], [], '')
      expect(updates.get('row-x')).toBeUndefined() // stable — no write at all
    })
    it('a matching rule can still re-categorize an auto-booked row (guard blocks only downgrades)', () => {
      const booked = crow({ amount: 0, category: 'conversion', subcategory: 'zero_amount', notes: 'auto: zero-amount', description: 'STRIPE FEE' })
      const rules = [{ id: 'r1', pattern: 'stripe', match_type: 'contains', category: 'fee', subcategory: 'processor', account_id: null, priority: 100, direction: 'any' } as CategorizationRule]
      const { updates } = computeRecategorizationUpdates([booked], rules, [], '')
      expect(updates.get('row-x')).toMatchObject({ category: 'fee' })
    })
    it('manual zero rows remain untouchable', () => {
      const manual = crow({ amount: 0, category: 'expense', notes: 'manual: group answer x' })
      const { updates } = computeRecategorizationUpdates([manual], [], [], '')
      expect(updates.get('row-x')).toBeUndefined()
    })
  })

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

// The shared AI-apply policy (2026-07-02) — one pure function used by BOTH the
// client path and the workspace AI pass, so the policy can never drift.
describe('decideAiSuggestion (shared AI-apply policy)', () => {
  const sugg = (over: Partial<AiSuggestion> = {}): AiSuggestion => ({
    id: 't1', category: 'expense', subcategory: 'software', confidence: 'high', ...over,
  })

  it('high confidence + still-uncategorized → applies the category, tagged + version-stamped', () => {
    const d = decideAiSuggestion(sugg({ lean: 'business', bucket: 'software' }), 'uncategorized')
    expect(d.applied).toBe(true)
    expect(d.update).toMatchObject({ category: 'expense', subcategory: 'software', ai_lean: 'business', ai_bucket: 'software' })
    // Version-stamped for tax-audit traceability (Phase 0.5); all note checks
    // in code use startsWith('ai:'), so the stamp is compatible everywhere.
    expect(d.update?.notes).toMatch(/^ai:high@v\d+$/)
  })

  it('high confidence but the row is ALREADY booked → hints only, category untouched', () => {
    const d = decideAiSuggestion(sugg({ lean: 'business', bucket: 'software' }), 'expense')
    expect(d.applied).toBe(false)
    expect(d.update).toEqual({ ai_lean: 'business', ai_bucket: 'software' })
  })

  it('medium/low confidence never applies a category — hints only (bucket sentinel fills the gap)', () => {
    for (const confidence of ['medium', 'low'] as const) {
      const d = decideAiSuggestion(sugg({ confidence, lean: 'personal' }), 'uncategorized')
      expect(d.applied).toBe(false)
      expect(d.update).toEqual({ ai_lean: 'personal', ai_bucket: 'other' })
    }
  })

  // Phase 3R cond. 4 (poison-pill closure): a VALIDATED suggestion always
  // fills BOTH hints — sentinels 'unsure'/'other' when the model omitted them —
  // so a processed row always exits the chained-chunk candidate set instead of
  // being re-paid by every chunk and every re-run forever.
  it('a validated suggestion with no hints writes the sentinels (never a null no-op)', () => {
    const d = decideAiSuggestion(sugg({ confidence: 'low' }), 'expense')
    expect(d.applied).toBe(false)
    expect(d.update).toEqual({ ai_lean: 'unsure', ai_bucket: 'other' })
  })
})

describe('Wise conversion locale seeds (2026-07-04) — the "Se han convertido" fix', () => {
  const seed = (pattern: string): CategorizationRule => ({
    id: `seed-${pattern}`, pattern, match_type: 'contains', category: 'conversion',
    subcategory: 'currency_conversion', account_id: null, priority: 40, direction: 'any',
  })
  it('Spanish/Portuguese/German Wise conversion lines book as conversion deterministically — both legs', () => {
    const rules = [seed('Se han convertido'), seed('Foram convertidos'), seed('wurden umgerechnet')]
    const cases = [
      { description: 'Se han convertido 417,02 USD a 400,00 EUR', amount: 400 },
      { description: 'Se han convertido 3.135,54 USD a 3.000,00 EUR', amount: -3135.54 },
      { description: 'Foram convertidos 100,00 USD para 90,00 EUR', amount: 90 },
      { description: '500,00 USD wurden umgerechnet in 460,00 EUR', amount: 460 },
    ]
    for (const c of cases) {
      const r = applyRules({ description: c.description, counterparty: '', amount: c.amount } as never, rules)
      expect(r.category).toBe('conversion')
    }
  })
  it('a real Spanish-described purchase is NOT swept by the conversion seed', () => {
    const rules = [seed('Se han convertido')]
    const r = applyRules({ description: 'Compra en Mercadona Valencia', counterparty: '', amount: -25 } as never, rules)
    expect(r.category).not.toBe('conversion')
  })
})

describe('zero-amount booking (v4, review F5)', () => {
  it('0.00 rows book as conversion/zero_amount deterministically — never a review question', () => {
    const { updates } = computeRecategorizationUpdates(
      [{ id: 'z1', transaction_date: '2025-03-01', description: 'Bcascais', counterparty: '', amount: 0, currency: 'USD', balance_after: null, transaction_ref: 'z1', bank_name: 'Wise', account_type: 'USD', category: 'uncategorized', subcategory: '', is_related_party: null, notes: null, ai_lean: null, ai_bucket: null }] as never,
      [], [], 'QA LLC',
    )
    expect(updates.get('z1')).toEqual({ category: 'conversion', subcategory: 'zero_amount', notes: 'auto: zero-amount' })
  })
  it('manual zero rows are untouched (human corrections win, always)', () => {
    const { updates } = computeRecategorizationUpdates(
      [{ id: 'z2', transaction_date: '2025-03-01', description: 'Bcascais', counterparty: '', amount: 0, currency: 'USD', balance_after: null, transaction_ref: 'z2', bank_name: 'Wise', account_type: 'USD', category: 'expense', subcategory: '', is_related_party: null, notes: 'manual: staff answer (business_expense)', ai_lean: null, ai_bucket: null }] as never,
      [], [], 'QA LLC',
    )
    expect(updates.has('z2')).toBe(false)
  })
})
