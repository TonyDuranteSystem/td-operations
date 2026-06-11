/**
 * Transfer-pair matcher — internal moves between the client's own accounts
 * must never count as revenue/expense (master plan §4). Real failure mode:
 * Dynamiq SR's Wise→Mercury→Relay→Chase moves inflated both P&L sides.
 */

import { describe, it, expect } from 'vitest'
import { matchTransferPairs, type TransferCandidate } from '@/lib/tax/transfer-matcher'

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
