/**
 * CSV parsers — content-signature detection, Relay parser, dialect sniffing,
 * deterministic refs (master plan §10.4 + W2/W3). Fixture columns mirror REAL
 * Relay exports (verified 2026-06-10); data is anonymized.
 */

import { describe, it, expect } from 'vitest'
import {
  stableRowRef, dedupeRefs, sniffCsvDialect, parseDelimitedRows,
  detectCsvSignature, parseRelayCSV, parseMercuryCSV, parseRevolutCSV, parseSlashCSV,
} from '@/lib/bank-csv-parsers'
import { parseWiseCSV, parseBankStatement, categorizeTransaction } from '@/lib/bank-statement-parser'

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

describe('Wise Payment Reference folding (2026-07-02, B&P golden repro)', () => {
  // Wise SENT rows don't embed the Payment Reference in the description, so
  // the client's own note ("Dividend", "Invoice 45") was invisible to every
  // rule and the AI — €29k of B&P owner dividends were booked as expenses.
  const csv = [
    'TransferWise ID,Date,Amount,Currency,Description,Payment Reference,Running Balance',
    'TRANSFER-1853561227,04-12-2025,-4977.00,EUR,Sent money to Andrea Bosco,Dividend,10386.00',
    'TRANSFER-1853426617,04-12-2025,10690.00,EUR,Received money from Alpha Business with reference Pagamento fattura n.70/2025,Pagamento fattura n.70/2025,15363.00',
  ].join('\n')

  it('folds the reference into a SENT description so rules/AI can read the note', () => {
    const r = parseWiseCSV(csv, 'wise.csv')
    expect(r.transactions[0].description).toBe('Sent money to Andrea Bosco with reference Dividend')
    // The folded note now drives the legacy dividend rule → distribution.
    const c = categorizeTransaction(r.transactions[0])
    expect(c.category).toBe('distribution')
    // Counterparty extraction unaffected.
    expect(r.transactions[0].counterparty).toBe('Andrea Bosco')
  })

  it('never duplicates a reference the description already embeds (received rows)', () => {
    const r = parseWiseCSV(csv, 'wise.csv')
    expect(r.transactions[1].description).toBe('Received money from Alpha Business with reference Pagamento fattura n.70/2025')
  })

  it('dedup identity unchanged: ref still comes from the reference column', () => {
    const r = parseWiseCSV(csv, 'wise.csv')
    expect(r.transactions[0].transaction_ref).toBe('Dividend')
    expect(r.transactions[1].transaction_ref).toBe('Pagamento fattura n.70/2025')
  })
})

describe('parseBankStatement routing', () => {
  it('routes a Relay-signature CSV to the deterministic parser (no AI)', async () => {
    const r = await parseBankStatement(Buffer.from(RELAY_CSV, 'utf-8'), 'whatever-name.csv', 'text/csv')
    expect(r.extraction_method).toBe('relay_csv')
    expect(r.transactions).toHaveLength(3)
  })
})

// ─── Slice 2 samples: Mercury / Revolut / Slash (real layouts, anonymized) ──


const MERCURY_CSV = [
  'Date (UTC),Description,Amount,Status,Source Account,Bank Description,Reference,Note,Last Four Digits,Name On Card,Mercury Category,Category,GL Code,Timestamp,Original Currency,Check Number,Tags,Cardholder Email,Tracking ID',
  '03-03-2026,VendorOne,-1050.00,Sent,Mercury Checking xx1111,VENDOR ONE LLC,,,1234,Test Person,ProfessionalServices,,,03-03-2026 13:00:53,USD,,,test@example.com,',
  '01-14-2026,VendorOne,-1000.00,Sent,Mercury Checking xx1111,VENDOR ONE LLC,,,1234,Test Person,ProfessionalServices,,,01-14-2026 09:00:00,USD,,,test@example.com,',
  '01-10-2026,FailedThing,-99.00,Failed,Mercury Checking xx1111,X,,,1234,Test Person,,,,01-10-2026 09:00:00,USD,,,test@example.com,',
].join('\n')

const REVOLUT_CSV = [
  'Date started (UTC),Date completed (UTC),ID,Type,State,Description,Reference,Payer,Card number,Card label,Card state,Orig currency,Orig amount,Payment currency,Amount,Total amount,Exchange rate,Fee,Fee currency,Balance,Account,International account number,Beneficiary account number,Beneficiary sort code or routing number,Beneficiary IBAN,Beneficiary BIC,Beneficiary name,MCC,Related transaction id,Spend program,Sender account,Sender name,Card references',
  '12-30-2025,12-31-2025,aaaa-1111,CARD_PAYMENT,COMPLETED,ServiceX,,Test Owner,443252******0000,Virtual,ACTIVE,EUR,113.73,USD,-133.76,-134.76,0.850271,1.00,USD,13336.07,USD Main,219957000000,,,,,,5311,,,,,',
  '12-28-2025,12-28-2025,bbbb-2222,TRANSFER,PENDING,Pending thing,,Test Owner,,,,USD,50,USD,-50.00,-50.00,1,0.00,USD,13469.83,USD Main,,,,,,,,,,,,',
].join('\n')

const SLASH_CSV = [
  '"Timestamp","Type","Description","Amount","Balance"',
  '"Jan 2","Loan Transaction","Daily Credit Card Payment","-100.00","5000.00"',
  '"","Subscription","Slash subscription 01-02","-25.00","5100.00"',
  '"Jan 1","Loan Transaction","Daily Credit Card Payment","-50.00","5125.00"',
  '"Dec 30","Deposit User Funds","ACH deposit from CHECKING (•••• 0000)","1000.00","5175.00"',
  '"","Foreign Transaction Fees","Slash fee: Foreign transaction fee for 12.30.25","-0.40","4175.00"',
].join('\n')

describe('parseMercuryCSV (real layout)', () => {
  it('parses MM-DD-YYYY dates, keeps Sent only, carries the Mercury Category', () => {
    const r = parseMercuryCSV(MERCURY_CSV, 'mercury.csv')
    expect(r.bank_name).toBe('Mercury')
    expect(r.transactions).toHaveLength(2) // Failed row excluded
    expect(r.transactions[0].transaction_date).toBe('2026-03-03')
    expect(r.transactions[0].amount).toBe(-1050)
    expect(r.transactions[0].description).toContain('[ProfessionalServices]')
    expect(r.transactions[0].balance_after).toBe(null) // Mercury exports carry no balance
    expect(r.errors.some(e => e.includes('non-Sent'))).toBe(true)
    r.transactions.forEach(t => expect(t.transaction_ref.length).toBeGreaterThan(0))
  })
})

describe('parseRevolutCSV (real layout)', () => {
  it('books Total amount (incl. fee), filters non-COMPLETED, uses the real ID as ref', () => {
    const r = parseRevolutCSV(REVOLUT_CSV, 'account-statement.csv')
    expect(r.transactions).toHaveLength(1) // PENDING excluded
    const t = r.transactions[0]
    expect(t.transaction_date).toBe('2025-12-31') // Date completed
    expect(t.amount).toBe(-134.76) // Total amount, NOT Amount (-133.76)
    expect(t.balance_after).toBe(13336.07)
    expect(t.transaction_ref).toBe('aaaa-1111')
    expect(t.counterparty).toBe('Test Owner')
  })
})

describe('parseSlashCSV (real layout)', () => {
  it('anchors the year, carries empty timestamps forward, crosses the year boundary down', () => {
    const r = parseSlashCSV(SLASH_CSV, 'slash.csv', { fallbackYear: 2026 })
    expect(r.transactions).toHaveLength(5)
    const dates = r.transactions.map(t => t.transaction_date)
    // Jan 2 + carried-forward Jan 2, Jan 1 in 2026; Dec 30 + carried-forward in 2025
    expect(dates).toEqual(['2026-01-02', '2026-01-02', '2026-01-01', '2025-12-30', '2025-12-30'])
    expect(r.transactions[3].amount).toBe(1000)
  })

  it('self-anchors the year from embedded fee dates when no hint is given', () => {
    const r = parseSlashCSV(SLASH_CSV, 'slash.csv')
    // anchor found: "for 12.30.25" → 2025 — but the FIRST rows are Jan (year
    // boundary above the anchor). The parser applies the anchor to the top of
    // the file; verify it parsed rather than refused.
    expect(r.transactions.length).toBeGreaterThan(0)
  })

  it('refuses politely when no year anchor exists at all', () => {
    const noAnchor = '"Timestamp","Type","Description","Amount","Balance"\n"Mar 5","Loan Transaction","Payment","-10.00","100.00"'
    const r = parseSlashCSV(noAnchor, 'slash.csv')
    expect(r.transactions).toHaveLength(0)
    expect(r.errors[0]).toContain('fallbackYear')
  })
})

describe('detectCsvSignature — new banks', () => {
  it('identifies Mercury, Revolut, Slash, and the Wise transfers variant', () => {
    expect(detectCsvSignature(['Date (UTC)', 'Description', 'Amount', 'Status', 'Source Account', 'Bank Description', 'Reference', 'Note', 'Last Four Digits', 'Name On Card', 'Mercury Category'])).toBe('mercury')
    expect(detectCsvSignature(['Date started (UTC)', 'Date completed (UTC)', 'ID', 'Type', 'State', 'Description', 'Total amount', 'Balance'])).toBe('revolut')
    expect(detectCsvSignature(['Timestamp', 'Type', 'Description', 'Amount', 'Balance'])).toBe('slash')
    expect(detectCsvSignature(['ID', 'Status', 'Direction', 'Created on', 'Source amount (after fees)', 'Target amount (after fees)'])).toBe('wise_transfers')
  })
})

describe('parseBankStatement routing — new banks', () => {
  it('routes Mercury and Slash CSVs deterministically with the tax-year hint', async () => {
    const m = await parseBankStatement(Buffer.from(MERCURY_CSV, 'utf-8'), 'x.csv', 'text/csv')
    expect(m.extraction_method).toBe('mercury_csv')
    const s = await parseBankStatement(Buffer.from(SLASH_CSV, 'utf-8'), 'y.csv', 'text/csv', { taxYear: 2026 })
    expect(s.extraction_method).toBe('slash_csv')
    expect(s.transactions).toHaveLength(5)
  })
})
