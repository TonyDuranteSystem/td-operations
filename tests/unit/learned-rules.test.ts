import { describe, it, expect } from 'vitest'
import {
  deriveLearnedRules,
  upsertLearnedMerchantRules,
  MIN_LEARN_PATTERN_LENGTH,
  LEARN_PATTERN_STOPLIST,
  type RuleStore,
  type LearnScope,
} from '@/lib/tax/learned-rules'

describe('deriveLearnedRules (pure)', () => {
  it('learns one OUT rule for a spend merchant', () => {
    const rules = deriveLearnedRules(
      [{ description: 'Klaviyo', counterparty: null, amount: -100 }, { description: 'Klaviyo', counterparty: null, amount: -50 }],
      'expense', 'client_confirmed',
    )
    expect(rules).toEqual([
      { pattern: 'Klaviyo', match_type: 'contains', category: 'expense', subcategory: 'client_confirmed', direction: 'out' },
    ])
  })

  it('learns an IN rule for an inflow merchant', () => {
    const rules = deriveLearnedRules([{ description: 'Stripe Payout', counterparty: null, amount: 900 }], 'income', 'revenue')
    expect(rules[0].direction).toBe('in')
    expect(rules[0].pattern).toBe('Stripe Payout')
  })

  it('marks a merchant with both in and out as any', () => {
    const rules = deriveLearnedRules(
      [{ description: 'PayPal', counterparty: null, amount: 200 }, { description: 'PayPal', counterparty: null, amount: -30 }],
      'income', 'revenue',
    )
    expect(rules[0].direction).toBe('any')
  })

  it('falls back to counterparty when description is empty', () => {
    const rules = deriveLearnedRules([{ description: null, counterparty: 'Fiverr', amount: -20 }], 'expense', 'client_confirmed')
    expect(rules[0].pattern).toBe('Fiverr')
  })

  it('skips blank and too-short roots (would over-match)', () => {
    const tooShort = 'x'.repeat(MIN_LEARN_PATTERN_LENGTH - 1)
    const rules = deriveLearnedRules(
      [{ description: '', counterparty: null, amount: -10 }, { description: tooShort, counterparty: null, amount: -10 }],
      'expense', 'client_confirmed',
    )
    expect(rules).toEqual([])
  })

  it('produces one rule per distinct merchant root', () => {
    const rules = deriveLearnedRules(
      [{ description: 'Klaviyo', counterparty: null, amount: -10 }, { description: 'Fiverr', counterparty: null, amount: -20 }],
      'expense', 'client_confirmed',
    )
    expect(rules.map(r => r.pattern).sort()).toEqual(['Fiverr', 'Klaviyo'])
  })
})

describe('upsertLearnedMerchantRules (insert vs update)', () => {
  function fakeStore() {
    const rows: Record<string, Record<string, unknown>> = {}
    let seq = 0
    const inserted: Record<string, unknown>[] = []
    const updated: { id: string; patch: Record<string, unknown> }[] = []
    const store: RuleStore = {
      findRule: async (scope: LearnScope, pattern, direction) => {
        const hit = Object.entries(rows).find(([, r]) =>
          (scope.account_id ? r.account_id === scope.account_id && !r.workspace_id : r.workspace_id === scope.workspace_id)
          && r.pattern === pattern && r.direction === direction)
        return hit ? { id: hit[0] } : null
      },
      insertRule: async (row) => { const id = `r${seq++}`; rows[id] = row; inserted.push(row) },
      updateRule: async (id, patch) => { rows[id] = { ...rows[id], ...patch }; updated.push({ id, patch }) },
    }
    return { store, inserted, updated, rows }
  }

  it('inserts a new learned rule the first time', async () => {
    const { store, inserted } = fakeStore()
    const res = await upsertLearnedMerchantRules(store, 'acct-1', [{ description: 'Repsol', counterparty: null, amount: -40 }], 'distribution', 'personal_draw', 'sofia@x.com')
    expect(res).toEqual({ created: 1, updated: 0 })
    expect(inserted[0]).toMatchObject({ pattern: 'Repsol', account_id: 'acct-1', category: 'distribution', direction: 'out', source: 'learned', active: true })
  })

  it('updates in place when the owner flips the same merchant later', async () => {
    const { store, updated } = fakeStore()
    // First: marked personal (distribution)
    await upsertLearnedMerchantRules(store, 'acct-1', [{ description: 'Repsol', counterparty: null, amount: -40 }], 'distribution', 'personal_draw', 'sofia@x.com')
    // Later: owner flips it to business expense — same pattern+direction → UPDATE
    const res = await upsertLearnedMerchantRules(store, 'acct-1', [{ description: 'Repsol', counterparty: null, amount: -40 }], 'expense', 'client_confirmed', 'sofia@x.com')
    expect(res).toEqual({ created: 0, updated: 1 })
    expect(updated[0].patch).toMatchObject({ category: 'expense', subcategory: 'client_confirmed', active: true })
  })

  it('is scoped per account (same merchant, different account → separate insert)', async () => {
    const { store, inserted } = fakeStore()
    await upsertLearnedMerchantRules(store, 'acct-1', [{ description: 'Repsol', counterparty: null, amount: -40 }], 'distribution', 'personal_draw', 'a')
    const res = await upsertLearnedMerchantRules(store, 'acct-2', [{ description: 'Repsol', counterparty: null, amount: -40 }], 'distribution', 'personal_draw', 'b')
    expect(res).toEqual({ created: 1, updated: 0 })
    expect(inserted).toHaveLength(2)
  })
})

// ── Phase 4 (2026-07-02): scoped learning + generic-word stoplist ──

describe('deriveLearnedRules — stoplist', () => {
  it('never learns a generic banking word as a contains-rule', () => {
    const rules = deriveLearnedRules(
      [
        { description: 'Payment', counterparty: null, amount: -100 },
        { description: 'Transfer', counterparty: null, amount: -50 },
        { description: 'Bonifico', counterparty: null, amount: 200 },
        { description: 'Klaviyo', counterparty: null, amount: -10 },
      ],
      'expense', 'client_confirmed',
    )
    expect(rules.map(r => r.pattern)).toEqual(['Klaviyo'])
  })

  it('the stoplist covers the core EN + IT vocabulary', () => {
    for (const w of ['payment', 'transfer', 'wire', 'fee', 'card', 'pos', 'ach', 'pagamento', 'bonifico', 'commissione']) {
      expect(LEARN_PATTERN_STOPLIST.has(w)).toBe(true)
    }
  })
})

describe('upsertLearnedMerchantRules — workspace scope (blank P&L workspaces)', () => {
  function fakeStore() {
    const rows: Record<string, Record<string, unknown>> = {}
    let seq = 0
    const inserted: Record<string, unknown>[] = []
    const store: RuleStore = {
      findRule: async (scope: LearnScope, pattern, direction) => {
        const hit = Object.entries(rows).find(([, r]) =>
          (scope.account_id ? r.account_id === scope.account_id && !r.workspace_id : r.workspace_id === scope.workspace_id)
          && r.pattern === pattern && r.direction === direction)
        return hit ? { id: hit[0] } : null
      },
      insertRule: async (row) => { const id = `r${seq++}`; rows[id] = row; inserted.push(row) },
      updateRule: async (id, patch) => { rows[id] = { ...rows[id], ...patch } },
    }
    return { store, inserted }
  }

  it('workspace scope: rule carries workspace_id, account_id stays NULL (leak-proof shape)', async () => {
    const { store, inserted } = fakeStore()
    const res = await upsertLearnedMerchantRules(
      store, { workspace_id: 'ws-1' },
      [{ description: 'Chelton AB', counterparty: null, amount: 7000 }],
      'income', 'revenue', 'staff@x.com',
    )
    expect(res).toEqual({ created: 1, updated: 0 })
    expect(inserted[0]).toMatchObject({ pattern: 'Chelton AB', workspace_id: 'ws-1', account_id: null, direction: 'in', source: 'learned' })
  })

  it('same merchant in account scope vs workspace scope are SEPARATE rules', async () => {
    const { store, inserted } = fakeStore()
    await upsertLearnedMerchantRules(store, { account_id: 'acct-1' }, [{ description: 'Repsol', counterparty: null, amount: -40 }], 'distribution', 'personal_draw', 'a')
    const res = await upsertLearnedMerchantRules(store, { workspace_id: 'ws-1' }, [{ description: 'Repsol', counterparty: null, amount: -40 }], 'expense', 'client_confirmed', 'b')
    expect(res).toEqual({ created: 1, updated: 0 })
    expect(inserted).toHaveLength(2)
  })

  it('bare account-id string still works (portal answer route compatibility)', async () => {
    const { store, inserted } = fakeStore()
    const res = await upsertLearnedMerchantRules(store, 'acct-9', [{ description: 'Fiverr', counterparty: null, amount: -20 }], 'expense', 'client_confirmed', 'c')
    expect(res).toEqual({ created: 1, updated: 0 })
    expect(inserted[0]).toMatchObject({ account_id: 'acct-9', workspace_id: null })
  })

  // The real B&P collision: Alpha Business is BOTH an income payer (invoices
  // in) AND an expense payee (marketing wires out). Direction gating must keep
  // the two learned rules independent — answering one direction never poisons
  // the other.
  it('Alpha Business two-direction collision: separate in/out rules, no cross-poisoning', async () => {
    const { store, inserted } = fakeStore()
    await upsertLearnedMerchantRules(store, { account_id: 'bp' }, [{ description: 'Received money from Alpha Business with reference Pagamento fattura', counterparty: 'Alpha Business', amount: 9563.77 }], 'income', 'revenue', 'x')
    const res = await upsertLearnedMerchantRules(store, { account_id: 'bp' }, [{ description: 'ONLINE DOMESTIC WIRE TRANSFER A/C: ALPHA BUSINESS REF: MARKETING', counterparty: 'Alpha Business', amount: -7000 }], 'expense', 'marketing', 'x')
    expect(res).toEqual({ created: 1, updated: 0 }) // NOT an update of the income rule
    const dirs = inserted.map(r => r.direction).sort()
    expect(dirs).toEqual(['in', 'out'])
  })
})
