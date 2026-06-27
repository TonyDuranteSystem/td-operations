import { describe, it, expect } from 'vitest'
import { parseGenericCSV } from '@/lib/bank-csv-parsers'
import { parseBankStatement } from '@/lib/bank-statement-parser'

describe('parseGenericCSV — bank-agnostic', () => {
  it('signed amount + ISO date (e.g. an unknown US bank)', () => {
    const csv = 'Date,Description,Amount,Balance\n2025-01-05,Client payment,1000.00,1000.00\n2025-01-20,Software,-200.00,800.00\n'
    const r = parseGenericCSV(csv)
    expect(r.transactions).toHaveLength(2)
    expect(r.transactions[0].amount).toBe(1000)
    expect(r.transactions[1].amount).toBe(-200)
    expect(r.transactions[0].balance_after).toBe(1000)
  })

  it('separate Debit / Credit columns → amount = credit − debit', () => {
    const csv = 'Date,Description,Debit,Credit\n2025-02-01,Inflow,,500.00\n2025-02-03,Outflow,120.00,\n'
    const r = parseGenericCSV(csv)
    expect(r.transactions.map(t => t.amount)).toEqual([500, -120])
  })

  it('"Money In" / "Money Out" columns', () => {
    const csv = 'Date,Details,Money Out,Money In\n2025-03-01,Sale,,300\n2025-03-02,Fee,15,\n'
    const r = parseGenericCSV(csv)
    expect(r.transactions.map(t => t.amount)).toEqual([300, -15])
  })

  it('parentheses = negative (accounting style)', () => {
    const csv = 'Date,Description,Amount\n2025-04-01,Refund out,(250.00)\n'
    const r = parseGenericCSV(csv)
    expect(r.transactions[0].amount).toBe(-250)
  })

  it('detects D/M/Y when a day > 12 appears', () => {
    const csv = 'Date,Description,Amount\n30/01/2025,Jan 30 payment,100\n15/06/2025,June 15,50\n'
    const r = parseGenericCSV(csv)
    expect(r.transactions[0].transaction_date).toBe('2025-01-30')
    expect(r.transactions[1].transaction_date).toBe('2025-06-15')
  })

  it('detects M/D/Y when the second field > 12 appears', () => {
    const csv = 'Date,Description,Amount\n01/30/2025,Jan 30,100\n06/15/2025,June 15,50\n'
    const r = parseGenericCSV(csv)
    expect(r.transactions[0].transaction_date).toBe('2025-01-30')
    expect(r.transactions[1].transaction_date).toBe('2025-06-15')
  })

  it('handles EU semicolon + comma-decimal re-save', () => {
    const csv = 'Data;Descrizione;Importo\n2025-05-01;Vendita;1.234,56\n2025-05-02;Spesa;-200,00\n'
    const r = parseGenericCSV(csv)
    expect(r.transactions[0].amount).toBeCloseTo(1234.56, 2)
    expect(r.transactions[1].amount).toBeCloseTo(-200, 2)
  })

  it('skips preamble rows before the real header', () => {
    const csv = 'Account Statement\nGenerated 2025-12-31\n\nDate,Description,Amount\n2025-07-01,Income,900\n'
    const r = parseGenericCSV(csv)
    expect(r.transactions).toHaveLength(1)
    expect(r.transactions[0].amount).toBe(900)
  })

  it('picks up a currency column', () => {
    const csv = 'Date,Description,Amount,Currency\n2025-08-01,EUR sale,100,EUR\n'
    const r = parseGenericCSV(csv)
    expect(r.transactions[0].currency).toBe('EUR')
  })

  it('returns 0 transactions when no date/amount column is identifiable (→ AI fallback upstream)', () => {
    const csv = 'Foo,Bar,Baz\nhello,world,123\n'
    const r = parseGenericCSV(csv)
    expect(r.transactions).toHaveLength(0)
    expect(r.errors.join(' ')).toMatch(/could not identify/)
  })

  it('flags ambiguous all-≤12 slash dates', () => {
    const csv = 'Date,Description,Amount\n01/02/2025,x,10\n03/04/2025,y,20\n'
    const r = parseGenericCSV(csv)
    expect(r.errors.join(' ')).toMatch(/Ambiguous date/)
  })
})

describe('parseBankStatement routing → generic CSV (no AI)', () => {
  it('an unknown-bank CSV is parsed by the generic parser without calling AI', async () => {
    const calls = { count: 0 }
    const fn = (async () => { calls.count++; return { ok: true, status: 200, json: async () => ({}) } as unknown as Response }) as unknown as typeof fetch
    const csv = 'Date,Description,Amount\n2025-09-01,Some unknown bank tx,123.45\n'
    const r = await parseBankStatement(Buffer.from(csv), 'somenewbank_2025.csv', 'text/csv', { fetchImpl: fn })
    expect(r.extraction_method).toBe('generic_csv')
    expect(r.transactions).toHaveLength(1)
    expect(calls.count).toBe(0) // never hit AI
  })
})
