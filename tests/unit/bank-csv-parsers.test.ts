/**
 * CSV parsers — content-signature detection, Relay parser, dialect sniffing,
 * deterministic refs (master plan §10.4 + W2/W3). Fixture columns mirror REAL
 * Relay exports (verified 2026-06-10); data is anonymized.
 */

import { describe, it, expect } from 'vitest'
import {
  stableRowRef, dedupeRefs, sniffCsvDialect, parseDelimitedRows,
  detectCsvSignature, parseRelayCSV,
} from '@/lib/bank-csv-parsers'
import { parseWiseCSV, parseBankStatement } from '@/lib/bank-statement-parser'

const RELAY_CSV = [
  'Date,Payee,Transaction Type,Description,Reference,Status,Amount,Currency,Balance',
  '1/30/2025,VENDOR ALPHA INC.,Spend,Unknown,"Corporate Card - 1111 (Business Card)",SETTLED,-31.50,USD,13128.76',
  '1/28/2025,CLIENT BETA,Receive,,"paypal",SETTLED,+1092.00,USD,13160.26',
  '1/25/2025,Theme Park,Spend,Unknown,"Corporate Card - 2222 (Business Virtual Card)",SETTLED,-340.78,USD,12068.26',
  '1/20/2025,PENDING VENDOR,Spend,Unknown,"card",PENDING,-50.00,USD,12000.00',
].join('\n')

describe('detectCsvSignature', () => {
  it('identifies Relay by its header columns', () => {
    expect(detectCsvSignature(['Date', 'Payee', 'Transaction Type', 'Description', 'Reference', 'Status', 'Amount', 'Currency', 'Balance'])).toBe('relay')
  })
  it('identifies Wise by TransferWise ID', () => {
    expect(detectCsvSignature(['TransferWise ID', 'Date', 'Amount', 'Currency', 'Description', 'Payment Reference', 'Running Balance'])).toBe('wise')
  })
  it('returns null for unknown layouts (→ AI fallback)', () => {
    expect(detectCsvSignature(['Booking Date', 'Value', 'Memo'])).toBe(null)
  })
})

describe('parseRelayCSV', () => {
  it('parses the real Relay layout: US dates, signed amounts, balances', () => {
    const r = parseRelayCSV(RELAY_CSV, 'relay_2025.csv')
    expect(r.bank_name).toBe('Relay')
    expect(r.transactions).toHaveLength(3) // PENDING row excluded
    const [t1, t2, t3] = r.transactions
    expect(t1.transaction_date).toBe('2025-01-30') // M/D/YYYY → ISO, NOT day-first
    expect(t1.amount).toBe(-31.5)
    expect(t1.balance_after).toBe(13128.76)
    expect(t1.counterparty).toBe('VENDOR ALPHA INC.')
    expect(t2.amount).toBe(1092) // "+" prefix handled
    expect(t3.transaction_date).toBe('2025-01-25')
    expect(r.errors.some(e => e.includes('non-SETTLED'))).toBe(true)
  })

  it('survives an Italian-Excel re-save (semicolons + comma decimals)', () => {
    const resaved = [
      'Date;Payee;Transaction Type;Description;Reference;Status;Amount;Currency;Balance',
      '1/30/2025;VENDOR ALPHA INC.;Spend;Unknown;Corporate Card - 1111;SETTLED;-31,50;USD;13128,76',
    ].join('\n')
    const r = parseRelayCSV(resaved, 'relay_resaved.csv')
    expect(r.transactions).toHaveLength(1)
    expect(r.transactions[0].amount).toBe(-31.5)
    expect(r.transactions[0].balance_after).toBe(13128.76)
  })

  it('refs are deterministic across runs and never blank', () => {
    const a = parseRelayCSV(RELAY_CSV, 'x.csv').transactions.map(t => t.transaction_ref)
    const b = parseRelayCSV(RELAY_CSV, 'y.csv').transactions.map(t => t.transaction_ref)
    expect(a).toEqual(b) // same content → same refs, any run, any filename
    a.forEach(ref => expect(ref.trim().length).toBeGreaterThan(0))
  })

  it('identical twin rows get stable -2 suffixes (dedup identity preserved)', () => {
    const twins = [
      'Date,Payee,Transaction Type,Description,Reference,Status,Amount,Currency,Balance',
      '2/01/2025,SAME VENDOR,Spend,Same,card,SETTLED,-10.00,USD,100.00',
      '2/01/2025,SAME VENDOR,Spend,Same,card,SETTLED,-10.00,USD,100.00',
    ].join('\n')
    const refs = parseRelayCSV(twins, 't.csv').transactions.map(t => t.transaction_ref)
    expect(refs[0]).not.toBe(refs[1])
    expect(refs[1]).toBe(`${refs[0]}-2`)
  })
})

describe('sniffCsvDialect', () => {
  it('detects comma-delimited standard files', () => {
    expect(sniffCsvDialect(RELAY_CSV)).toEqual({ delimiter: ',', commaDecimals: false })
  })
  it('detects semicolon + comma decimals (Italian Excel)', () => {
    const d = sniffCsvDialect('A;B;C\n1/1/2025;x;-31,50')
    expect(d.delimiter).toBe(';')
    expect(d.commaDecimals).toBe(true)
  })
})

describe('parseDelimitedRows', () => {
  it('handles quoted fields containing the delimiter', () => {
    const rows = parseDelimitedRows('a;"x;y";c', ';')
    expect(rows[0]).toEqual(['a', 'x;y', 'c'])
  })
})

describe('stableRowRef / dedupeRefs', () => {
  it('is stable for equal input and distinct for different input', () => {
    expect(stableRowRef(['2025-01-01', -10, 'x', 100])).toBe(stableRowRef(['2025-01-01', -10, 'x', 100]))
    expect(stableRowRef(['2025-01-01', -10, 'x', 100])).not.toBe(stableRowRef(['2025-01-01', -10, 'x', 101]))
  })
  it('suffixes repeats deterministically', () => {
    expect(dedupeRefs(['a', 'a', 'b', 'a'])).toEqual(['a', 'a-2', 'b', 'a-3'])
  })
})

describe('Wise blank-reference fallback (DB non-blank CHECK)', () => {
  it('rows without a Wise reference get a content-hash ref', () => {
    const csv = [
      'TransferWise ID,Date,Amount,Currency,Description,Payment Reference,Running Balance',
      ',01-02-2025,500.00,USD,Incoming transfer,,1500.00',
    ].join('\n')
    const r = parseWiseCSV(csv, 'wise.csv')
    expect(r.transactions).toHaveLength(1)
    expect(r.transactions[0].transaction_ref.startsWith('h-')).toBe(true)
  })
})

describe('parseBankStatement routing', () => {
  it('routes a Relay-signature CSV to the deterministic parser (no AI)', async () => {
    const r = await parseBankStatement(Buffer.from(RELAY_CSV, 'utf-8'), 'whatever-name.csv', 'text/csv')
    expect(r.extraction_method).toBe('relay_csv')
    expect(r.transactions).toHaveLength(3)
  })
})
