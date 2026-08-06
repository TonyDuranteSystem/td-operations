import { describe, it, expect } from 'vitest'
import {
  deriveLearnedRules,
  deriveEvictionPatterns,
  deactivateConversionRulesForRows,
  promotionWouldResurrectClientEviction,
  CLIENT_OWN_TRANSFER_EVICTION_NOTE,
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
      [{ description: 'Alpha Business', counterparty: null, amount: 200 }, { description: 'Alpha Business', counterparty: null, amount: -30 }],
      'income', 'revenue',
    )
    expect(rules[0].direction).toBe('any')
  })

  // Phase 3R cond. 13: payment rails never become contains-rules — a 'paypal'
  // rule would blanket-book every PayPal-carried merchant.
  it('never learns a rule from a payment rail', () => {
    const rules = deriveLearnedRules(
      [{ description: 'PayPal', counterparty: null, amount: 200 }, { description: 'PayPal', counterparty: null, amount: -30 }],
      'income', 'revenue',
    )
    expect(rules).toHaveLength(0)
  })

  // Phase 3R cond. 13: a counterparty-FALLBACK root (degenerate description)
  // never learns — the answer still books the rows, but a contains-rule from
  // either side of that pair would poison future runs ('Unknown - Corporate
  // Card' matching everything, or an MCC label like 'Restaurants').
  it('does NOT learn from a counterparty-fallback root', () => {
    const rules = deriveLearnedRules([{ description: null, counterparty: 'Fiverr', amount: -20 }], 'expense', 'client_confirmed')
    expect(rules).toHaveLength(0)
    const boiler = deriveLearnedRules(
      [{ description: 'Unknown - Corporate Card - 6921 (Business Card)', counterparty: 'Bershka', amount: -50 }],
      'expense', 'client_confirmed',
    )
    expect(boiler).toHaveLength(0)
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
      findConflicting: async (scope: LearnScope, pattern, keepDirection) => {
        const dirs = keepDirection === 'any' ? ['in', 'out'] : ['any']
        return Object.entries(rows)
          .filter(([, r]) =>
            (scope.account_id ? r.account_id === scope.account_id && !r.workspace_id : r.workspace_id === scope.workspace_id)
            && r.pattern === pattern && r.active !== false && dirs.includes(r.direction as string))
          .map(([id]) => ({ id }))
      },
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
      findConflicting: async (scope: LearnScope, pattern, keepDirection) => {
        const dirs = keepDirection === 'any' ? ['in', 'out'] : ['any']
        return Object.entries(rows)
          .filter(([, r]) =>
            (scope.account_id ? r.account_id === scope.account_id && !r.workspace_id : r.workspace_id === scope.workspace_id)
            && r.pattern === pattern && r.active !== false && dirs.includes(r.direction as string))
          .map(([id]) => ({ id }))
      },
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

// ── Phase 0.2 (2026-07-03): direction-overlap reconciliation ──

describe('upsertLearnedMerchantRules — direction reconciliation', () => {
  function fakeStore() {
    const rows: Record<string, Record<string, unknown>> = {}
    let seq = 0
    const store: RuleStore = {
      findRule: async (scope: LearnScope, pattern, direction) => {
        const hit = Object.entries(rows).find(([, r]) =>
          (scope.account_id ? r.account_id === scope.account_id && !r.workspace_id : r.workspace_id === scope.workspace_id)
          && r.pattern === pattern && r.direction === direction)
        return hit ? { id: hit[0] } : null
      },
      insertRule: async (row) => { rows[`r${seq++}`] = { ...row } },
      updateRule: async (id, patch) => { rows[id] = { ...rows[id], ...patch } },
      findConflicting: async (scope: LearnScope, pattern, keepDirection) => {
        const dirs = keepDirection === 'any' ? ['in', 'out'] : ['any']
        return Object.entries(rows)
          .filter(([, r]) =>
            (scope.account_id ? r.account_id === scope.account_id && !r.workspace_id : r.workspace_id === scope.workspace_id)
            && r.pattern === pattern && r.active !== false && dirs.includes(r.direction as string))
          .map(([id]) => ({ id }))
      },
    }
    return { store, rows }
  }
  const spend = [{ description: 'Repsol', counterparty: null, amount: -40 }]
  const inflow = [{ description: 'Repsol', counterparty: null, amount: 40 }]
  const both = [{ description: 'Repsol', counterparty: null, amount: -40 }, { description: 'Repsol', counterparty: null, amount: 40 }]

  it("an 'any' answer deactivates a prior 'out' rule (no nondeterministic winner)", async () => {
    const { store, rows } = fakeStore()
    await upsertLearnedMerchantRules(store, 'a1', spend, 'expense', 'x', 'u')       // learns out
    await upsertLearnedMerchantRules(store, 'a1', both, 'conversion', 'transfer', 'u') // learns any
    const active = Object.values(rows).filter(r => r.active !== false)
    expect(active).toHaveLength(1)
    expect(active[0]).toMatchObject({ direction: 'any', category: 'conversion' })
  })

  it("a direction-specific answer deactivates a prior 'any' rule", async () => {
    const { store, rows } = fakeStore()
    await upsertLearnedMerchantRules(store, 'a1', both, 'conversion', 'transfer', 'u') // any
    await upsertLearnedMerchantRules(store, 'a1', spend, 'expense', 'x', 'u')          // out supersedes
    const active = Object.values(rows).filter(r => r.active !== false)
    expect(active).toHaveLength(1)
    expect(active[0]).toMatchObject({ direction: 'out', category: 'expense' })
  })

  it("'in' and 'out' rules COEXIST (PayPal: income inbound, vendor outbound)", async () => {
    const { store, rows } = fakeStore()
    await upsertLearnedMerchantRules(store, 'a1', inflow, 'income', 'revenue', 'u')
    await upsertLearnedMerchantRules(store, 'a1', spend, 'expense', 'vendor', 'u')
    const active = Object.values(rows).filter(r => r.active !== false)
    expect(active).toHaveLength(2)
    expect(active.map(r => r.direction).sort()).toEqual(['in', 'out'])
  })
})

/**
 * MULTI-WORD RAIL ROOTS (2026-08-05, VSV210): "WISE US, INC." slipped past the
 * exact-match rail check and a mis-tapped own_transfer answer learned
 * "everything incoming via Wise = internal transfer" — live on production.
 * A root whose FIRST word is a rail name is the rail, not a merchant.
 */
describe('deriveLearnedRules — dressed-rail-root guard', () => {
  it('never learns from a rail dressed in corporate suffixes', () => {
    expect(deriveLearnedRules([{ description: 'WISE US, INC. | LOAN FROM AMEMBER -WR', counterparty: null, amount: 2914.83 }], 'conversion', 'internal_transfer')).toHaveLength(0)
    expect(deriveLearnedRules([{ description: 'Revolut Ltd | card top-up', counterparty: null, amount: -50 }], 'expense', 'client_confirmed')).toHaveLength(0)
  })

  it('still learns rail + MEANINGFUL word (a specific money flow) and merchants containing a rail word', () => {
    const payout = deriveLearnedRules([{ description: 'Stripe Payout', counterparty: null, amount: 900 }], 'income', 'revenue')
    expect(payout).toHaveLength(1)
    expect(payout[0].pattern).toBe('Stripe Payout')
    const cafe = deriveLearnedRules([{ description: 'Clockwise Cafe', counterparty: null, amount: -12 }], 'expense', 'client_confirmed')
    expect(cafe).toHaveLength(1)
    expect(cafe[0].pattern).toBe('Clockwise Cafe')
  })
})

/**
 * RULE EVICTION when a human CORRECTS an own_transfer answer: the poisoned
 * rule was learned under the older, looser filters, so eviction must derive
 * patterns WITHOUT the rail/stoplist skips — otherwise exactly the rules that
 * need killing (rail roots like "WISE US, INC.") are unevictable.
 */
describe('deriveEvictionPatterns', () => {
  it('includes rail roots the learn path skips', () => {
    const patterns = deriveEvictionPatterns([{ description: 'WISE US, INC. | LOAN FROM AMEMBER -WR', counterparty: null, amount: 2914.83 }])
    expect(patterns).toEqual(['WISE US, INC.'])
  })

  it('still skips degenerate/counterparty-fallback roots (they can never equal a learned pattern)', () => {
    expect(deriveEvictionPatterns([{ description: null, counterparty: 'Fiverr', amount: -20 }])).toEqual([])
  })
})

describe('deactivateConversionRulesForRows', () => {
  it('deactivates only active account-scoped conversion rules matching the rows\' roots', async () => {
    const calls: Record<string, unknown[]> = { update: [], eq: [], in: [] }
    const chain = {
      update(patch: unknown) { calls.update.push(patch); return chain },
      eq(...a: unknown[]) { calls.eq.push(a); return chain },
      is(...a: unknown[]) { calls.eq.push(a); return chain },
      in(...a: unknown[]) { calls.in.push(a); return chain },
      select() { return Promise.resolve({ data: [{ id: 'r1' }], error: null }) },
    }
    const db = { from: () => chain }
    const n = await deactivateConversionRulesForRows(db, 'acct-1', [{ description: 'WISE US, INC. | LOAN FROM AMEMBER -WR', counterparty: null, amount: 2914.83 }])
    expect(n).toBe(1)
    expect(calls.update[0]).toMatchObject({ active: false })
    expect(calls.in[0]).toEqual(['pattern', ['WISE US, INC.']])
    expect(calls.eq).toEqual(expect.arrayContaining([['account_id', 'acct-1'], ['category', 'conversion'], ['active', true]]))
  })

  it('touches nothing when the rows yield no pattern', async () => {
    let fromCalled = false
    const db = { from: () => { fromCalled = true; throw new Error('should not query') } }
    const n = await deactivateConversionRulesForRows(db, 'acct-1', [{ description: null, counterparty: 'X', amount: 1 }])
    expect(n).toBe(0)
    expect(fromCalled).toBe(false)
  })
})

/**
 * RULE-RESURRECTION GUARD (bug-hunter major, 2026-08-06): a client's
 * own_transfer correction deactivates the merchant rule with a marker note;
 * a later staff Save-to-client used to find that rule (findRule ignores
 * active) and flip it back to active conversion — silently undoing the
 * client's decision. Promotion now skips exactly those rules.
 */
describe('promotionWouldResurrectClientEviction', () => {
  it('skips a rule the client eviction killed', () => {
    expect(promotionWouldResurrectClientEviction({ active: false, notes: CLIENT_OWN_TRANSFER_EVICTION_NOTE })).toBe(true)
  })
  it('does not skip active rules, other-reason-inactive rules, or absent rules', () => {
    expect(promotionWouldResurrectClientEviction({ active: true, notes: CLIENT_OWN_TRANSFER_EVICTION_NOTE })).toBe(false)
    expect(promotionWouldResurrectClientEviction({ active: false, notes: 'deactivated: superseded by a newer answer with a different direction' })).toBe(false)
    expect(promotionWouldResurrectClientEviction({ active: false, notes: null })).toBe(false)
    expect(promotionWouldResurrectClientEviction(null)).toBe(false)
  })
})

describe('deactivateConversionRulesForRows — note contract', () => {
  it('stamps the exported eviction note the promotion guard keys on', async () => {
    let captured: Record<string, unknown> | null = null
    const chain = {
      update(patch: Record<string, unknown>) { captured = patch; return chain },
      eq() { return chain }, is() { return chain }, in() { return chain },
      select() { return Promise.resolve({ data: [{ id: 'r1' }], error: null }) },
    }
    await deactivateConversionRulesForRows({ from: () => chain }, 'acct-1', [{ description: 'ACME HOLDING', counterparty: null, amount: -10 }])
    expect(captured!.notes).toBe(CLIENT_OWN_TRANSFER_EVICTION_NOTE)
    expect(captured!.active).toBe(false)
  })
})
