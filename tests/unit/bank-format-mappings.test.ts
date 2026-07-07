/**
 * Learned statement-format mappings (S1) — the tri-role review's test matrix:
 * fingerprint identity, deterministic parse-through-mapping (incl. the CPA
 * settled-currency rule from the Dynamiq incident), verifier hard checks +
 * ambiguity detection, heuristic proposal, quarantine flow through
 * parseBankStatement with a fake store, and AI proposal validation
 * (column-roles only, garbage rejected).
 */
import { describe, it, expect } from 'vitest'
import {
  formatFingerprint, assertValidMapping,
  applyFormatMapping, verifyMapping, proposeMappingHeuristically,
  proposeMappingWithAI, type FormatMapping,
} from '@/lib/bank-format-mappings'
import { parseBankStatement, type ParseResult } from '@/lib/bank-statement-parser'

// The REAL Mercury variant header from the Dynamiq incident (synthetic rows).
const MERCURY_HEADER = 'Date (UTC),Description,Amount,Status,Source Account,Bank Description,Reference,Note,Last Four Digits,Name On Card,Category,GL Code,Timestamp,Original Currency,Check Number,Tags'
const MERCURY_CSV = `${MERCURY_HEADER}
12-30-2024,Uber,-55.99,Sent,Mercury Checking xx8655,UBER * PENDING,,,6776,Jane Owner,RideshareAndTaxis,,12-30-2024 10:22:03,EUR,,
12-29-2024,Stripe Payout,1200.00,Sent,Mercury Checking xx8655,STRIPE,,,,,Income,,12-29-2024 08:00:00,,,
12-28-2024,Failed Wire,-999.00,Failed,Mercury Checking xx8655,WIRE OUT,,,,,,,12-28-2024 12:00:00,,,
12-27-2024,Cafe Lisboa,-9.89,Sent,Mercury Savings xx1234,CAFE LISBOA,,,7229,John Owner,Restaurants,,12-27-2024 09:08:00,EUR,,`

const MERCURY_MAPPING: FormatMapping = {
  version: 1,
  bank_label: 'Mercury',
  date: { col: 0, order: 'mdy' },
  description_cols: [1, 5],
  counterparty_col: 5,
  amount: { mode: 'signed', col: 2, positive_is: 'in' },
  currency: { mode: 'settled_fixed_with_original', value: 'USD', original_col: 13 },
  account: { mode: 'column', col: 4 },
  balance_col: null,
  status: { col: 3, include: ['sent'] },
  ref_extra_cols: [4, 12],
}

describe('formatFingerprint', () => {
  it('is the normalized header, case/space-insensitive', () => {
    const a = formatFingerprint(MERCURY_HEADER.split(','))
    const b = formatFingerprint(MERCURY_HEADER.toUpperCase().split(',').map(s => ` ${s} `))
    expect(a).toBe(b)
    expect(a).toContain('date (utc)|description|amount')
  })
  it('long headers fall back to sha256', () => {
    const long = Array.from({ length: 80 }, (_, i) => `column_number_${i}_padded`)
    expect(formatFingerprint(long)).toMatch(/^sha256:[0-9a-f]{64}$/)
  })
})

describe('applyFormatMapping — the Dynamiq semantics, fixed', () => {
  const r = applyFormatMapping(MERCURY_CSV, MERCURY_MAPPING)

  it('parses only Sent rows (status filter)', () => {
    expect(r.transactions).toHaveLength(3)
    expect(r.errors.join(' ')).toContain('Skipped 1')
  })
  it('CPA rule: settled USD wins — an EUR card purchase is NOT stored as EUR', () => {
    const uber = r.transactions.find(t => t.description.includes('Uber'))!
    expect(uber.amount).toBe(-55.99)
    expect(uber.currency).toBe('USD') // the double-conversion class, dead
  })
  it('account identity from the Source Account column', () => {
    expect(r.transactions.map(t => t.account_type)).toContain('Mercury Checking xx8655')
    expect(r.transactions.map(t => t.account_type)).toContain('Mercury Savings xx1234')
    expect(r.transactions.every(t => t.bank_name === 'Mercury')).toBe(true)
  })
  it('dates parsed as MDY', () => {
    expect(r.transactions.find(t => t.description.includes('Stripe'))!.transaction_date).toBe('2024-12-29')
  })
})

describe('verifyMapping', () => {
  it('the Mercury mapping on Mercury data: hard-clean; original-currency handled → no currency ambiguity', () => {
    const v = verifyMapping(MERCURY_CSV, MERCURY_MAPPING)
    expect(v.ok).toBe(true)
    expect(v.sample.length).toBeGreaterThan(0)
    expect(v.ambiguities.join(' ')).not.toContain('original')
  })
  it('a WRONG date column is a hard failure, not a guess', () => {
    const broken = { ...MERCURY_MAPPING, date: { col: 5, order: 'mdy' as const } } // Bank Description
    const v = verifyMapping(MERCURY_CSV, broken)
    expect(v.ok).toBe(false)
    expect(v.hard_failures.join(' ')).toContain('failed to parse as dates')
  })
  it('day/month order that cannot be proven is an AMBIGUITY (quarantine, not auto-accept)', () => {
    const csv = 'Date,Description,Amount\n01-02-2024,Coffee,-5.00\n03-04-2024,Tea,-6.00'
    const mapping: FormatMapping = {
      version: 1, bank_label: 'Bank', date: { col: 0, order: 'mdy' }, description_cols: [1],
      amount: { mode: 'signed', col: 2, positive_is: 'in' }, currency: { mode: 'fixed', value: 'USD' },
      account: { mode: 'fixed', label: null }, balance_col: null, status: null, ref_extra_cols: [],
    }
    const v = verifyMapping(csv, mapping)
    expect(v.ok).toBe(true)
    expect(v.auto_acceptable).toBe(false)
    expect(v.ambiguities.join(' ')).toContain('Day/month order')
  })
  it('balance-column inconsistency is a hard failure', () => {
    const csv = 'Date,Description,Amount,Balance\n2024-01-01,A,100.00,100.00\n2024-01-02,B,50.00,999.00\n2024-01-03,C,25.00,777.00'
    const mapping: FormatMapping = {
      version: 1, bank_label: 'Bank', date: { col: 0, order: 'mdy' }, description_cols: [1],
      amount: { mode: 'signed', col: 2, positive_is: 'in' }, currency: { mode: 'fixed', value: 'USD' },
      account: { mode: 'fixed', label: null }, balance_col: 3, status: null, ref_extra_cols: [],
    }
    const v = verifyMapping(csv, mapping)
    expect(v.ok).toBe(false)
    expect(v.hard_failures.join(' ')).toContain('Balance column does not reconcile')
  })
})

describe('proposeMappingHeuristically', () => {
  it('maps a simple unambiguous export without AI', () => {
    const csv = 'Booking Date,Details,Amount,Running Balance\n2024-05-14,ACME SUPPLIES,-120.50,879.50\n2024-05-15,CLIENT PAYMENT,1000.00,1879.50'
    const m = proposeMappingHeuristically(csv)!
    expect(m).not.toBeNull()
    expect(m.date.col).toBe(0)
    expect(m.amount).toMatchObject({ mode: 'signed', col: 2 })
    expect(m.balance_col).toBe(3)
    const v = verifyMapping(csv, m)
    expect(v.ok).toBe(true)
    expect(v.auto_acceptable).toBe(true) // ISO dates → provable, no ambiguity
  })
  it('returns null when no date/amount columns are identifiable (the Chase PDF-as-CSV case)', () => {
    const garbage = '"JPMorgan Chase Bank, N.A.";;;;;;\n;;;;;;\nWeb site: Service Center:;;;;;;'
    expect(proposeMappingHeuristically(garbage)).toBeNull()
  })
})

describe('assertValidMapping (AI output is untrusted)', () => {
  it('rejects out-of-range columns and bad enums', () => {
    expect(() => assertValidMapping({ ...MERCURY_MAPPING, date: { col: 99, order: 'mdy' } }, 16)).toThrow()
    expect(() => assertValidMapping({ ...MERCURY_MAPPING, amount: { mode: 'vibes' } }, 16)).toThrow()
    expect(() => assertValidMapping({ ...MERCURY_MAPPING, currency: { mode: 'fixed', value: 'DOLLARS' } }, 16)).toThrow()
  })
  it('accepts the Mercury mapping', () => {
    expect(assertValidMapping(MERCURY_MAPPING, 16).bank_label).toBe('Mercury')
  })
})

describe('proposeMappingWithAI (mocked transport)', () => {
  const fakeFetch = (payload: unknown): typeof fetch =>
    (async () => new Response(JSON.stringify({ content: [{ type: 'text', text: JSON.stringify(payload) }] }), { status: 200 })) as unknown as typeof fetch

  it('valid proposal round-trips', async () => {
    const { mapping } = await proposeMappingWithAI(MERCURY_HEADER.split(','), [], { fetchImpl: fakeFetch(MERCURY_MAPPING) })
    expect(mapping?.bank_label).toBe('Mercury')
  })
  it('garbage is rejected, never applied', async () => {
    const { mapping, error } = await proposeMappingWithAI(MERCURY_HEADER.split(','), [], { fetchImpl: fakeFetch({ version: 1, bank_label: 'X', date: { col: 400, order: 'mdy' } }) })
    expect(mapping).toBeNull()
    expect(error).toContain('Invalid format mapping')
  })
  it('the model declining is surfaced as an error', async () => {
    const { mapping, error } = await proposeMappingWithAI(MERCURY_HEADER.split(','), [], { fetchImpl: fakeFetch({ error: 'two date columns' }) })
    expect(mapping).toBeNull()
    expect(error).toContain('two date columns')
  })
})

describe('parseBankStatement with a mapping store (end-to-end pipeline)', () => {
  // In-memory fake store.
  const makeStore = () => {
    const rows = new Map<string, { id: string; fingerprint: string; mapping: FormatMapping; status: 'proposed' | 'verified_auto' | 'staff_confirmed' | 'rejected'; bank_label: string }>()
    let n = 0
    return {
      rows,
      lookup: async (fp: string) => rows.get(fp) ?? null,
      recordHit: async () => {},
      store: async (r: { fingerprint: string; mapping: FormatMapping; status: 'proposed' | 'verified_auto'; bank_label: string }) => {
        const id = `m${++n}`
        rows.set(r.fingerprint, { id, fingerprint: r.fingerprint, mapping: r.mapping, status: r.status, bank_label: r.bank_label })
        return id
      },
    }
  }
  const asBuffer = (s: string) => Buffer.from(s, 'utf-8')

  it('a stored confirmed mapping parses the Dynamiq Mercury variant deterministically — zero AI', async () => {
    const store = makeStore()
    store.rows.set(formatFingerprint(MERCURY_HEADER.split(',')), {
      id: 'seed', fingerprint: formatFingerprint(MERCURY_HEADER.split(',')), mapping: MERCURY_MAPPING, status: 'staff_confirmed', bank_label: 'Mercury',
    })
    const r: ParseResult = await parseBankStatement(asBuffer(MERCURY_CSV), 'statement_mercury_2024.csv', 'text/csv', { mappingStore: store })
    expect(r.extraction_method).toBe('mapped_csv')
    expect(r.bank_name).toBe('Mercury')
    expect(r.transactions.find(t => t.description.includes('Uber'))!.currency).toBe('USD')
  })

  it('an ambiguous new format QUARANTINES instead of guessing (generic parser demoted)', async () => {
    const store = makeStore()
    const csv = 'Date,Description,Amount\n01-02-2024,Coffee,-5.00\n03-04-2024,Tea,-6.00'
    const r = await parseBankStatement(asBuffer(csv), 'mystery.csv', 'text/csv', { mappingStore: store })
    expect(r.extraction_method).toBe('quarantined')
    expect(r.transactions).toHaveLength(0)
    expect(r.quarantine?.mapping_id).toBeTruthy()
    expect(store.rows.get(r.quarantine!.fingerprint)?.status).toBe('proposed')
  })

  it('an unambiguous new format auto-accepts, stores, and parses', async () => {
    const store = makeStore()
    const csv = 'Booking Date,Details,Amount,Running Balance\n2024-05-14,ACME SUPPLIES,-120.50,879.50\n2024-05-15,CLIENT PAYMENT,1000.00,1879.50'
    const r = await parseBankStatement(asBuffer(csv), 'newbank.csv', 'text/csv', { mappingStore: store })
    expect(r.extraction_method).toBe('mapped_csv')
    expect(r.transactions).toHaveLength(2)
    const stored = Array.from(store.rows.values())[0]
    expect(stored.status).toBe('verified_auto')
  })

  it('without a store, legacy behavior is untouched (generic parser still runs)', async () => {
    const csv = 'Booking Date,Details,Amount\n2024-05-14,ACME,-120.50\n2024-05-15,PAYMENT,1000.00'
    const r = await parseBankStatement(asBuffer(csv), 'legacy.csv', 'text/csv', {})
    expect(r.extraction_method).toBe('generic_csv')
    expect(r.transactions).toHaveLength(2)
  })
})
