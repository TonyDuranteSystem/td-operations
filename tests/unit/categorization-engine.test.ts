/**
 * Categorization engine — DB-backed rules layered over the legacy built-ins
 * (master plan §8). applyRules is pure; rules are injected.
 */

import { describe, it, expect } from 'vitest'
import { applyRules, computeRecategorizationUpdates, decideAiSuggestion, type CategorizationRule } from '@/lib/tax/categorization-engine'
import type { AiSuggestion } from '@/lib/tax/ai-categorizer'
import { ASK_CLIENT_NOTE, type ParsedTransaction } from '@/lib/bank-statement-parser'

const tx = (description: string, amount: number, over: Partial<ParsedTransaction> = {}): ParsedTransaction => ({
  transaction_date: '2025-06-01', description, counterparty: '', amount,
  currency: 'USD', balance_after: null, transaction_ref: 'r1',
  bank_name: 'Slash', account_type: 'USD', ...over,
})

const rule = (over: Partial<CategorizationRule>): CategorizationRule => ({
  id: 'x', pattern: '', match_type: 'contains', category: 'expense', subcategory: '',
  account_id: null, priority: 100, direction: 'any', ...over,
})

describe('member equity auto-booking (2026-07-07 — Dynamiq: wires to members must be draws)', () => {
  it('a plain outflow to a member books as distribution/member_distribution — no dividend keyword needed', () => {
    const out = applyRules(tx('Wire transfer', -4464.27, { counterparty: 'Donato Renato Berini' }), [], ['Donato Renato Berini', 'Sofia Marinoni'])
    expect(out.category).toBe('distribution')
    expect(out.subcategory).toBe('member_distribution')
    expect(out.is_related_party).toBe(true)
  })
  it('an inflow from a member books as contribution/member_contribution', () => {
    const out = applyRules(tx('Incoming wire Sofia Marinoni', 5000), [], ['Sofia Marinoni'])
    expect(out.category).toBe('contribution')
    expect(out.subcategory).toBe('member_contribution')
  })
  it('member identity outranks generic keyword rules; learned rules still outrank members', () => {
    const memberRow = tx('Stripe payment to Donato Renato Berini', -100)
    expect(applyRules(memberRow, [], ['Donato Renato Berini']).category).toBe('distribution')
    const learned = rule({ pattern: 'donato renato berini', category: 'expense', subcategory: 'contractors' })
    expect(applyRules(memberRow, [learned], ['Donato Renato Berini']).category).toBe('expense')
  })
  it('non-member counterparties are untouched', () => {
    expect(applyRules(tx('Wire transfer', -500, { counterparty: 'Acme Corp' }), [], ['Donato Renato Berini']).category).toBe('uncategorized')
  })

  /**
   * THE PAYEE MUST BE SEARCHED SEPARATELY FROM THE MEMO (2026-08-04).
   *
   * The near-miss check cuts a line at its payment reference, so a supplier's
   * invoice number mentioning a member is not read as a payment to them. But
   * Relay, Mercury, Revolut and Slash all put the memo in the description and
   * the payee in the counterparty field — so searching them JOINED meant a
   * routine wire memo ("WIRE OUT | REF 88123") cut the payee away entirely and
   * the check silently never fired. A wire is exactly the shape an owner draw
   * takes, which made this the worst place to lose it.
   */
  it('a REF in the memo must not hide a member in the counterparty field', () => {
    const relayShape = tx('WIRE OUT | REF 88123 | INVOICE 4471', -4500, { counterparty: 'M. FINELLI' })
    const out = applyRules(relayShape, [], ['Gabriele Finelli', 'Matthew Finelli'])
    expect(out.notes.startsWith(ASK_CLIENT_NOTE)).toBe(true)
  })

  it('and a member named only in the reference is still ignored', () => {
    const supplier = tx('Sent money to Lope Gomez with reference Finelli factura 2024-005', -900, { counterparty: 'Lope Gomez' })
    const out = applyRules(supplier, [], ['Gabriele Finelli', 'Matthew Finelli'])
    expect(out.notes.startsWith(ASK_CLIENT_NOTE)).toBe(false)
  })
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

  /**
   * NEAR-MISS STABILITY ACROSS RE-RUNS (2026-08-04).
   *
   * The sweep runs every four hours. A rule that demotes a row on every pass
   * and lets something else re-book it on the next is not a safety net, it is a
   * flip-flop that moves the client's capital accounts on a timer. The real
   * shape: Dynamiq's "Sent money to Enrico Berini" — same surname as member
   * Donato Renato Berini — where the generic Wise catch-all books it as a
   * vendor expense and the near-miss check must reopen it, once, and then leave
   * it alone.
   */
  describe('near-miss demotion is stable across re-runs', () => {
    const members = ['Donato Renato Berini', 'Sofia Marinoni']
    const berini = (over = {}) => crow({
      id: 'nm', description: 'Sent money to Enrico Berini', amount: -580, ...over,
    })

    it('run 1 reopens a catch-all vendor booking so the client is asked', () => {
      const { updates } = computeRecategorizationUpdates(
        [berini({ category: 'expense', subcategory: 'vendor_payment' })], [], members, '',
      )
      expect(updates.get('nm')?.category).toBe('uncategorized')
    })

    it('run 2 leaves it alone — no write at all, so nothing churns', () => {
      const { updates } = computeRecategorizationUpdates(
        [berini({ category: 'uncategorized', subcategory: '' })], [], members, '',
      )
      expect(updates.get('nm')).toBeUndefined()
    })

    it('an exact member match still books outright and is NEVER reopened', () => {
      const exact = crow({ id: 'ex', description: 'Sent money to Donato Renato Berini', amount: -4464.27 })
      const first = computeRecategorizationUpdates([exact], [], members, '').updates
      expect(first.get('ex')?.category).toBe('distribution')
      // ...and re-running on the booked row writes nothing.
      const booked = crow({ id: 'ex', description: 'Sent money to Donato Renato Berini', amount: -4464.27, category: 'distribution', subcategory: 'member_distribution' })
      expect(computeRecategorizationUpdates([booked], [], members, '').updates.get('ex')).toBeUndefined()
    })

    it('a human answer is never reopened, however many times it runs', () => {
      const answered = berini({ category: 'expense', subcategory: 'vendor_payment', notes: 'manual: client says supplier' })
      expect(computeRecategorizationUpdates([answered], [], members, '').updates.get('nm')).toBeUndefined()
    })

    it('an AI-booked row is not downgraded by the near-miss check', () => {
      // Consistent with the existing guard: no pass may push an ai:/auto: row
      // back to uncategorized. Documented deliberately — an AI guess on a
      // near-miss payee survives, and only a human or a rule moves it.
      const aiRow = berini({ category: 'expense', subcategory: 'vendor_payment', notes: 'ai:high' })
      expect(computeRecategorizationUpdates([aiRow], [], members, '').updates.get('nm')).toBeUndefined()
    })

    /**
     * THE FEATURE DEFEATING ITSELF. The near-miss demotes the row to
     * `uncategorized` — which is exactly the state the AI pass is allowed to
     * resolve. Without a guard, a high-confidence guess re-booked it as an
     * expense, wrote its own note over the ask, and the "never downgrade an
     * ai: row" rule then made that permanent: the client was never asked, and
     * never could be. The AI may still record its advisory hints.
     */
    it('the AI pass must NOT answer a question we deliberately left open', () => {
      const s = { id: 'nm', category: 'expense' as const, subcategory: 'vendor_payment', confidence: 'high' as const, lean: 'business' as const, bucket: 'contractors' }
      const d = decideAiSuggestion(s, 'uncategorized', `${ASK_CLIENT_NOTE} Donato Renato Berini`)
      expect(d.applied).toBe(false)
      expect(d.update?.category).toBeUndefined()
      expect(d.update?.ai_lean).toBe('business') // hints still recorded
    })

    it('the AI pass still resolves an ordinary uncategorized row', () => {
      const s = { id: 'x', category: 'expense' as const, subcategory: 'software', confidence: 'high' as const, lean: 'business' as const, bucket: 'software' }
      expect(decideAiSuggestion(s, 'uncategorized', null).applied).toBe(true)
    })

    /**
     * The reopened row landed in the client's queue still wearing its previous
     * explanation — typically "transfer-pair → <id>", which claims it is one leg
     * of an internal transfer when we have just decided we do not know what it
     * is. Pass 1 discarded the new note entirely.
     */
    it('carries the ask-note through, replacing a now-false explanation', () => {
      const stale = berini({ category: 'conversion', subcategory: 'internal_transfer', notes: 'transfer-pair → abc-123' })
      const u = computeRecategorizationUpdates([stale], [], members, '').updates.get('nm')
      expect(u?.category).toBe('uncategorized')
      expect(u?.notes).toContain('Donato Renato Berini')
      expect(u?.notes).not.toContain('transfer-pair')
    })

    it('an unrelated supplier is never reopened — the queue must not flood', () => {
      const vendor = crow({ id: 'v', description: 'Sent money to Aurora Global Holdings Limited', amount: -4000 })
      const { updates } = computeRecategorizationUpdates([vendor], [], members, '')
      expect(updates.get('v')?.category ?? 'expense').toBe('expense')
    })

    it('an INCOMING payment from a near-miss name is left as booked', () => {
      // Only outgoing money can be a disguised owner draw; reopening inflows
      // would drag real revenue into the question queue.
      const inflow = crow({ id: 'in', description: 'Received money from Enrico Berini', amount: 900, category: 'income', subcategory: 'sales' })
      const after = computeRecategorizationUpdates([inflow], [], members, '').updates.get('in')
      // It stays INCOME. (The built-in rule also normalises the subcategory to
      // 'revenue', which is pre-existing behaviour and not what this pins.)
      expect(after?.category ?? 'income').toBe('income')
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
