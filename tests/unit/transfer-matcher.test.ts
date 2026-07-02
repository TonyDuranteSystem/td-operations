/**
 * Transfer-pair matcher — internal moves between the client's own accounts
 * must never count as revenue/expense (master plan §4). Real failure mode:
 * Dynamiq SR's Wise→Mercury→Relay→Chase moves inflated both P&L sides.
 */

import { describe, it, expect } from 'vitest'
import {
  matchTransferPairs,
  detectOwnEntityTransfers,
  normalizeEntityName,
  nameVariants,
  type TransferCandidate,
  type OwnEntityRow,
} from '@/lib/tax/transfer-matcher'

const tx = (id: string, date: string, amount: number, bank: string, over: Partial<TransferCandidate> = {}): TransferCandidate => ({
  id, transaction_date: date, amount, currency: 'USD', bank_name: bank,
  account_type: 'USD', category: 'uncategorized', ...over,
})

describe('matchTransferPairs', () => {
  it('pairs an outflow with the equal inflow at another bank within the window', () => {
    const pairs = matchTransferPairs([
      tx('out1', '2025-03-01', -5000, 'Wise'),
      tx('in1', '2025-03-03', 5000, 'Mercury'),
    ])
    expect(pairs).toEqual([{ outflowId: 'out1', inflowId: 'in1', amount: 5000, daysApart: 2 }])
  })

  it('never pairs within the same bank account (vendor refunds are not transfers)', () => {
    const pairs = matchTransferPairs([
      tx('out1', '2025-03-01', -200, 'Wise'),
      tx('in1', '2025-03-02', 200, 'Wise'),
    ])
    expect(pairs).toHaveLength(0)
  })

  it('pairs across sub-accounts of the same bank (EUR ↔ USD wallets differ)', () => {
    const pairs = matchTransferPairs([
      tx('out1', '2025-03-01', -200, 'Wise', { account_type: 'A-1111' }),
      tx('in1', '2025-03-01', 200, 'Wise', { account_type: 'B-2222' }),
    ])
    expect(pairs).toHaveLength(1)
  })

  it('respects the day window and currency', () => {
    const farApart = matchTransferPairs([
      tx('o', '2025-03-01', -100, 'Wise'),
      tx('i', '2025-03-10', 100, 'Mercury'),
    ])
    expect(farApart).toHaveLength(0)
    const wrongCurrency = matchTransferPairs([
      tx('o', '2025-03-01', -100, 'Wise', { currency: 'EUR' }),
      tx('i', '2025-03-02', 100, 'Mercury', { currency: 'USD' }),
    ])
    expect(wrongCurrency).toHaveLength(0)
  })

  it('each leg pairs at most once; nearest-in-time wins deterministically', () => {
    const pairs = matchTransferPairs([
      tx('out1', '2025-03-05', -1000, 'Wise'),
      tx('inFar', '2025-03-01', 1000, 'Mercury'),
      tx('inNear', '2025-03-06', 1000, 'Relay'),
      tx('out2', '2025-03-05', -1000, 'Chase'),
    ])
    // out1 (earlier in sort) takes the nearest inflow (inNear, 1 day);
    // out2 takes the remaining one (inFar, 4 days).
    expect(pairs).toHaveLength(2)
    const byOut = Object.fromEntries(pairs.map(p => [p.outflowId, p.inflowId]))
    expect(byOut['out1']).toBe('inNear')
    expect(byOut['out2']).toBe('inFar')
  })

  it('leaves already-classified fees/conversions alone', () => {
    const pairs = matchTransferPairs([
      tx('o', '2025-03-01', -100, 'Wise', { category: 'fee' }),
      tx('i', '2025-03-02', 100, 'Mercury'),
    ])
    expect(pairs).toHaveLength(0)
  })

  it('the Dynamiq pattern: top-up chain across three banks resolves cleanly', () => {
    const pairs = matchTransferPairs([
      tx('w-out', '2025-12-10', -30000, 'Wise'),
      tx('s-in', '2025-12-11', 30000, 'Slash'),
      tx('m-out', '2025-12-11', -5000, 'Mercury'),
      tx('r-in', '2025-12-09', 5000, 'Relay'),
      tx('real-income', '2025-12-11', 4421.93, 'Wise', { category: 'income' }),
    ])
    expect(pairs).toHaveLength(2)
    expect(pairs.some(p => p.outflowId === 'w-out' && p.inflowId === 's-in')).toBe(true)
    expect(pairs.some(p => p.outflowId === 'm-out' && p.inflowId === 'r-in')).toBe(true)
  })
})

describe('normalizeEntityName', () => {
  it('lowercases, strips punctuation + entity suffixes, collapses spaces', () => {
    expect(normalizeEntityName('Dynamiq SR LLC')).toBe('dynamiq')
    expect(normalizeEntityName('DYNAMIQ S.R. L.L.C.')).toBe('dynamiq')
    expect(normalizeEntityName('sent money to Dynamiq SR LLC')).toBe('sent money to dynamiq')
    expect(normalizeEntityName('Premium Services, Inc.')).toBe('premium services')
  })
})

describe('detectOwnEntityTransfers', () => {
  const row = (id: string, description: string, category = 'expense', over: Partial<OwnEntityRow> = {}): OwnEntityRow =>
    ({ id, description, counterparty: null, category, ...over })

  it('flags outflows + inflows naming the company own entity (no matching leg needed)', () => {
    const hits = detectOwnEntityTransfers(
      [
        row('o1', 'sent money to Dynamiq SR LLC'),
        row('i1', 'received from DYNAMIQ S.R. LLC'),
        row('v1', 'Google Ads'),
      ],
      { ownNames: ['Dynamiq SR LLC'] },
    )
    expect(hits.sort()).toEqual(['i1', 'o1'])
  })

  it('matches when the company name is on the counterparty field', () => {
    const hits = detectOwnEntityTransfers(
      [row('c1', 'Wire out', 'expense', { counterparty: 'Dynamiq SR LLC' })],
      { ownNames: ['Dynamiq SR LLC'] },
    )
    expect(hits).toEqual(['c1'])
  })

  it('never touches distribution/contribution/cogs/conversion; income needs the strict counterparty path', () => {
    const hits = detectOwnEntityTransfers(
      [
        row('d1', 'sent money to Dynamiq SR LLC', 'distribution'),
        // income with the own name only in the DESCRIPTION (no counterparty):
        // the strict income path requires counterparty == own name, so this
        // stays income — a contains-match can never swallow a sale.
        row('n1', 'sent money to Dynamiq SR LLC', 'income'),
        row('k1', 'sent money to Dynamiq SR LLC', 'conversion'),
      ],
      { ownNames: ['Dynamiq SR LLC'] },
    )
    expect(hits).toEqual([])
  })

  // ── Income self-payments (2026-07-02, B&P €29,269 incident) ──
  // Wise's built-in books "Received money from <own company>" as income before
  // the engine's passes run; these are the company's own Chase→Wise moves.

  it('reclassifies an income row whose COUNTERPARTY is exactly the company itself', () => {
    const hits = detectOwnEntityTransfers(
      [row('w1', 'Received money from B&P INTERNATIONAL LLC with reference BUSINESS EXPENSES', 'income', { counterparty: 'B&P INTERNATIONAL LLC' })],
      { ownNames: ['B&P International LLC'] },
    )
    expect(hits).toEqual(['w1'])
  })

  it('income: recognizes the &-dropped bank spelling ("BP International") via name variants', () => {
    const hits = detectOwnEntityTransfers(
      [row('w2', 'Received money', 'income', { counterparty: 'BP International LLC' })],
      { ownNames: ['B&P International LLC'] },
    )
    expect(hits).toEqual(['w2'])
  })

  it('income: a merely SIMILAR customer name is never swallowed (exact equality required)', () => {
    const hits = detectOwnEntityTransfers(
      [
        row('c1', 'Received money', 'income', { counterparty: 'B&P International Consulting GmbH' }),
        row('c2', 'Received money', 'income', { counterparty: 'CHELTON AB' }),
      ],
      { ownNames: ['B&P International LLC'] },
    )
    expect(hits).toEqual([])
  })

  it('uncategorized: the Chase RTP line naming the own company via Wise matches through the variant', () => {
    // Real B&P line shape: the bank writes "BP" where the legal name is "B&P".
    const hits = detectOwnEntityTransfers(
      [row('r1', 'REAL TIME TRANSFER RECD FROM ABA/CONTR BNK-021000021  FROM: BNF-BP International LLC Via WISE REF: 1173713684-B P I', 'uncategorized')],
      { ownNames: ['B&P International LLC'] },
    )
    expect(hits).toEqual(['r1'])
  })

  it('does NOT fire when the normalized own-name is too short/generic (avoids blanket vendor matches)', () => {
    // "ABC Co" → "abc" (3 chars after suffix strip) is below the distinctiveness floor.
    const hits = detectOwnEntityTransfers(
      [row('x1', 'payment to ABC Hosting')],
      { ownNames: ['ABC Co'] },
    )
    expect(hits).toEqual([])
  })

  it('requires the FULL multi-word name contiguously (a partial token is not a match)', () => {
    const hits = detectOwnEntityTransfers(
      [row('p1', 'Premium Hosting renewal')], // has "premium" but not "premium services"
      { ownNames: ['Premium Services LLC'] },
    )
    expect(hits).toEqual([])
  })

  it('returns nothing when no own name is provided', () => {
    expect(detectOwnEntityTransfers([row('o1', 'sent money to Dynamiq SR LLC')], { ownNames: [] })).toEqual([])
    expect(detectOwnEntityTransfers([row('o1', 'sent money to Dynamiq SR LLC')], { ownNames: [''] })).toEqual([])
  })
})

describe('nameVariants', () => {
  it('collapses runs of single-letter tokens ("b p international" → "bp international")', () => {
    expect(nameVariants('b p international')).toEqual(['b p international', 'bp international'])
  })
  it('returns just the input when there is nothing to collapse', () => {
    expect(nameVariants('dynamiq sr')).toEqual(['dynamiq sr'])
  })
  it('collapses a full single-letter run ("a b c") into one token', () => {
    expect(nameVariants('a b c')).toEqual(['a b c', 'abc'])
  })
})
