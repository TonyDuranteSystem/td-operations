import { describe, it, expect } from 'vitest'
import {
  mapParsedToBooksRecords,
  partitionByCoverage,
  canonicalBankLabel,
  feedCoverageKeys,
  booksCoverageKey,
  recordKey,
  type FeedRowKeyFields,
} from '@/lib/owner-statement-ingest'
import { computeTieOutRows } from '@/lib/owner-tie-out'
import type { ParsedTransaction } from '@/lib/bank-statement-parser'

const makeParsed = (o: Partial<ParsedTransaction> = {}): ParsedTransaction => ({
  transaction_date: '2026-03-10',
  description: 'ACME SOFTWARE',
  counterparty: 'ACME',
  amount: -49.99,
  currency: 'USD',
  balance_after: 1200.5,
  transaction_ref: 'row-abc123',
  bank_name: 'Relay',
  account_type: 'USD',
  ...o,
})

describe('canonicalBankLabel', () => {
  it('maps feed sources and parser labels to ONE label per bank', () => {
    expect(canonicalBankLabel('relay')).toBe('Relay')
    expect(canonicalBankLabel('Relay')).toBe('Relay')
    expect(canonicalBankLabel('mercury_api')).toBe('Mercury')
    expect(canonicalBankLabel('MERCURY')).toBe('Mercury')
    expect(canonicalBankLabel('')).toBe('Other')
    expect(canonicalBankLabel('Wise')).toBe('Wise')
  })

  it('token-matches AI free-text labels — "JPMorgan Chase" must not split the Chase bucket or dodge the feed check', () => {
    expect(canonicalBankLabel('JPMorgan Chase')).toBe('Chase')
    expect(canonicalBankLabel('Mercury Bank')).toBe('Mercury')
    expect(canonicalBankLabel('Chasey Ltd')).toBe('Chasey Ltd') // whole tokens only
  })
})

describe('mapParsedToBooksRecords', () => {
  it('maps a parsed row with a CONTENT-scoped stmt ref and pinned entity', () => {
    const [rec] = mapParsedToBooksRecords([makeParsed()], 'Relay')
    expect(rec.transaction_ref).toMatch(/^stmt:h-[0-9a-f]{16}$/)
    expect(rec.entity_id).toBe('00000000-0000-0000-0000-000000000001')
    expect(rec.tax_year).toBe(2026)
    expect(rec.amount).toBe(-49.99)
    expect(rec.category).toBe('uncategorized')
  })

  it('the ref is stable for identical content (re-upload idempotency)…', () => {
    const [a] = mapParsedToBooksRecords([makeParsed()], 'Relay')
    const [b] = mapParsedToBooksRecords([makeParsed()], 'Relay')
    expect(a.transaction_ref).toBe(b.transaction_ref)
  })

  it("…but DIFFERS across months even when the bank's own reference repeats (the Wise recurring-transfer collision)", () => {
    const jan = mapParsedToBooksRecords([makeParsed({ transaction_ref: 'Dividend', transaction_date: '2026-01-31', bank_name: 'Wise' })], 'Wise')
    const feb = mapParsedToBooksRecords([makeParsed({ transaction_ref: 'Dividend', transaction_date: '2026-02-28', bank_name: 'Wise' })], 'Wise')
    expect(jan[0].transaction_ref).not.toBe(feb[0].transaction_ref)
  })

  it('preserves sign and normalizes currency', () => {
    const [outflow] = mapParsedToBooksRecords([makeParsed({ amount: -500 })], 'Relay')
    const [eur] = mapParsedToBooksRecords([makeParsed({ currency: 'eur', transaction_ref: 'e1' })], 'Relay')
    const [bad] = mapParsedToBooksRecords([makeParsed({ currency: 'EURO', transaction_ref: 'e2' })], 'Relay')
    expect(outflow.amount).toBe(-500)
    expect(eur.currency).toBe('EUR')
    expect(bad.currency).toBe('USD')
  })

  it('drops rows missing a ref or date instead of inventing identity', () => {
    const recs = mapParsedToBooksRecords([
      makeParsed({ transaction_ref: '' }),
      makeParsed({ transaction_date: '', transaction_ref: 'r3' }),
      makeParsed({ transaction_ref: 'ok-1' }),
    ], 'Relay')
    expect(recs).toHaveLength(1)
  })
})

describe('coverage keys (the double-count guard)', () => {
  const feedRow = (o: Partial<FeedRowKeyFields> = {}): FeedRowKeyFields => ({
    transaction_date: '2026-03-10',
    amount: 49.99,
    currency: 'USD',
    status: 'outgoing',
    ...o,
  })

  it('direction-reliable statuses give ONE signed key', () => {
    expect(feedCoverageKeys(feedRow({ status: 'outgoing' }))).toEqual(['2026-03-10|-49.99|USD'])
    expect(feedCoverageKeys(feedRow({ status: 'matched', amount: 1500 }))).toEqual(['2026-03-10|1500.00|USD'])
  })

  it('direction-lost but REAL rows (ignored) give BOTH signs — skip-leaning, never double-book-leaning', () => {
    expect(feedCoverageKeys(feedRow({ status: 'ignored', amount: 75 }))).toHaveLength(2)
  })

  it('swept and duplicate feed rows contribute NOTHING — their books copy / original row already covers them (live re-test catch: ghost keys absorbed a genuine second identical charge)', () => {
    expect(feedCoverageKeys(feedRow({ status: 'owner_ledger', amount: 500 }))).toEqual([])
    expect(feedCoverageKeys(feedRow({ status: 'duplicate', amount: 500 }))).toEqual([])
  })

  it('books rows key by their SIGNED amount — the reliable source for swept expenses', () => {
    expect(booksCoverageKey({ transaction_date: '2026-03-10', amount: -500, currency: 'USD' })).toBe('2026-03-10|-500.00|USD')
  })

  it('a swept expense covers its statement row via the BOOKS key even though feed status lost the sign', () => {
    // The scenario the review flagged as a blocker: outgoing $500 swept to books.
    const stmtRow = mapParsedToBooksRecords([makeParsed({ amount: -500, transaction_ref: 's1' })], 'Relay')
    const booksKeys = [booksCoverageKey({ transaction_date: '2026-03-10', amount: -500, currency: 'USD' })]
    const { fresh, covered } = partitionByCoverage(stmtRow, booksKeys)
    expect(covered).toHaveLength(1)
    expect(fresh).toHaveLength(0)
  })
})

describe('partitionByCoverage (multiset)', () => {
  it('one captured row absorbs exactly ONE statement twin — the second real one imports', () => {
    const twins = mapParsedToBooksRecords([
      makeParsed({ amount: -6, transaction_ref: 't1' }),
      makeParsed({ amount: -6, transaction_ref: 't2' }),
    ], 'Relay')
    const coverage = [booksCoverageKey({ transaction_date: '2026-03-10', amount: -6, currency: 'USD' })]
    const { fresh, covered } = partitionByCoverage(twins, coverage)
    expect(covered).toHaveLength(1)
    expect(fresh).toHaveLength(1)
  })

  it('two captured rows absorb two twins', () => {
    const twins = mapParsedToBooksRecords([
      makeParsed({ amount: -6, transaction_ref: 't1' }),
      makeParsed({ amount: -6, transaction_ref: 't2' }),
    ], 'Relay')
    const coverage = [
      booksCoverageKey({ transaction_date: '2026-03-10', amount: -6, currency: 'USD' }),
      booksCoverageKey({ transaction_date: '2026-03-10', amount: -6, currency: 'USD' }),
    ]
    const { fresh, covered } = partitionByCoverage(twins, coverage)
    expect(covered).toHaveLength(2)
    expect(fresh).toHaveLength(0)
  })

  it('does not match across currencies or dates', () => {
    const recs = mapParsedToBooksRecords([
      makeParsed({ amount: -49.99, currency: 'EUR', transaction_ref: 'c1' }),
      makeParsed({ amount: -49.99, transaction_date: '2026-03-11', transaction_ref: 'c2' }),
    ], 'Relay')
    const coverage = [booksCoverageKey({ transaction_date: '2026-03-10', amount: -49.99, currency: 'USD' })]
    const { fresh } = partitionByCoverage(recs, coverage)
    expect(fresh).toHaveLength(2)
  })

  it('recordKey matches the coverage key format exactly', () => {
    const [rec] = mapParsedToBooksRecords([makeParsed({ amount: 100 })], 'Relay')
    expect(recordKey(rec)).toBe('2026-03-10|100.00|USD')
  })
})

describe('computeTieOutRows', () => {
  it('sums books and feed movement per bank/currency, excluding swept and duplicate feed rows', () => {
    const books = [
      { bank_name: 'Relay', currency: 'USD', amount: -300, transaction_ref: 'stmt:a' },
      { bank_name: 'Relay', currency: 'USD', amount: 1019.25, transaction_ref: 'feed:f1' },
    ]
    const feeds = [
      { id: 'f1', source: 'relay', currency: 'USD', amount: 1019.25, status: 'owner_ledger' },
      { id: 'f2', source: 'relay', currency: 'USD', amount: 2000, status: 'matched' },
      { id: 'f3', source: 'relay', currency: 'USD', amount: 2000, status: 'duplicate' },
      { id: 'f4', source: 'relay', currency: 'USD', amount: 150, status: 'outgoing' },
    ]
    const [row] = computeTieOutRows(books, feeds, [])
    expect(row.books_movement).toBe(719.25)
    expect(row.feed_movement).toBe(1850)
    expect(row.feed_rows).toBe(2)
  })

  it('computes expected closing and difference when balances are entered', () => {
    const books = [{ bank_name: 'Mercury', currency: 'USD', amount: 500, transaction_ref: 'stmt:x' }]
    const balances = [{ bank_key: 'Mercury', currency: 'USD', opening_balance: 1000, closing_balance: 1400, notes: null }]
    const [row] = computeTieOutRows(books, [], balances)
    expect(row.expected_closing).toBe(1500)
    expect(row.difference).toBe(-100)
  })

  it('keeps currencies separate', () => {
    const books = [
      { bank_name: 'Wise', currency: 'USD', amount: 100, transaction_ref: 'stmt:u' },
      { bank_name: 'Wise', currency: 'EUR', amount: 200, transaction_ref: 'stmt:e' },
    ]
    const rows = computeTieOutRows(books, [], [])
    expect(rows).toHaveLength(2)
  })

  it('shows a balances-only row', () => {
    const balances = [{ bank_key: 'Chase', currency: 'USD', opening_balance: 50, closing_balance: 75, notes: null }]
    const [row] = computeTieOutRows([], [], balances)
    expect(row.expected_closing).toBe(50)
    expect(row.difference).toBe(25)
  })
})
