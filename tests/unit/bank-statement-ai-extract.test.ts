/**
 * Tests for bank-agnostic AI statement extraction + parseBankStatement routing
 * + .zip support (2026-06-10).
 *
 * Locks in: AI extraction maps transactions with correct signs, the
 * reconciliation guard catches mismatches (the tax-accuracy safety net),
 * routing keeps the Wise fast path, non-Wise files go to AI, zips unpack and
 * merge, and the BANK_STATEMENT_AI_DISABLED kill-switch works.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { zipSync, strToU8 } from 'fflate'
import { PDFDocument } from 'pdf-lib'
import { aiExtractBankStatement } from '@/lib/bank-statement-ai-extract'
import { parseBankStatement } from '@/lib/bank-statement-parser'

async function makePdf(pages: number): Promise<Buffer> {
  const d = await PDFDocument.create()
  for (let i = 0; i < pages; i++) d.addPage([300, 300])
  return Buffer.from(await d.save())
}

interface FakeInput {
  bank_name?: string
  currency?: string
  account_holder?: string
  period?: string
  opening_balance?: number | null
  closing_balance?: number | null
  transactions?: Array<{ date?: string; description?: string; amount?: number; currency?: string; balance_after?: number | null }>
}

function makeFetch(input: FakeInput, opts?: { stopReason?: string; status?: number }) {
  const calls = { count: 0 }
  const fn = (async () => {
    calls.count++
    if (opts?.status && opts.status >= 400) {
      return { ok: false, status: opts.status, json: async () => ({ error: 'boom' }) } as Response
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        stop_reason: opts?.stopReason || 'tool_use',
        content: [{ type: 'tool_use', name: 'record_statement', input }],
      }),
    } as unknown as Response
  }) as unknown as typeof fetch
  return { fn, calls }
}

const WISE_CSV =
  'TransferWise ID,Date,Amount,Currency,Description,Running Balance\n' +
  'TX1,2025-03-01,1000.00,USD,Received money from ACME,1000.00\n' +
  'TX2,2025-03-05,-200.00,USD,Sent money to Vendor,800.00\n'

beforeEach(() => {
  process.env.ANTHROPIC_API_KEY = 'test-key'
  delete process.env.BANK_STATEMENT_AI_DISABLED
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe('aiExtractBankStatement', () => {
  it('maps transactions and reconciles when balances add up', async () => {
    const { fn, calls } = makeFetch({
      bank_name: 'Mercury', currency: 'USD', opening_balance: 100, closing_balance: 900,
      transactions: [
        { date: '2025-04-01', description: 'Deposit', amount: 1000, currency: 'USD' },
        { date: '2025-04-10', description: 'Software', amount: -200, currency: 'USD' },
      ],
    })
    const r = await aiExtractBankStatement(Buffer.from('x'), 'mercury.pdf', 'application/pdf', { fetchImpl: fn })
    expect(calls.count).toBe(1)
    expect(r.extraction_method).toBe('ai')
    expect(r.transactions).toHaveLength(2)
    expect(r.transactions[0].amount).toBe(1000)
    expect(r.transactions[1].amount).toBe(-200)
    expect(r.bank_name).toBe('Mercury')
    // 100 + (1000 - 200) = 900 == closing
    expect(r.reconciliation?.reconciled).toBe(true)
  })

  it('flags reconciliation=false when transactions do not match closing balance', async () => {
    const { fn } = makeFetch({
      currency: 'USD', opening_balance: 0, closing_balance: 5000,
      transactions: [{ date: '2025-04-01', description: 'Deposit', amount: 1000, currency: 'USD' }],
    })
    const r = await aiExtractBankStatement(Buffer.from('x'), 'relay.pdf', 'application/pdf', { fetchImpl: fn })
    expect(r.reconciliation?.reconciled).toBe(false)
    expect(r.reconciliation?.note).toMatch(/MISMATCH/)
  })

  it('returns reconciled=null for multi-currency statements', async () => {
    const { fn } = makeFetch({
      opening_balance: 0, closing_balance: 0,
      transactions: [
        { date: '2025-04-01', description: 'EUR in', amount: 100, currency: 'EUR' },
        { date: '2025-04-02', description: 'USD in', amount: 100, currency: 'USD' },
      ],
    })
    const r = await aiExtractBankStatement(Buffer.from('x'), 'wise.pdf', 'application/pdf', { fetchImpl: fn })
    expect(r.reconciliation?.reconciled).toBeNull()
    expect(r.reconciliation?.note).toMatch(/Multi-currency/)
  })

  it('flags truncation when the model hits max_tokens', async () => {
    const { fn } = makeFetch(
      { currency: 'USD', opening_balance: 0, closing_balance: 100, transactions: [{ date: '2025-04-01', description: 'x', amount: 100 }] },
      { stopReason: 'max_tokens' },
    )
    const r = await aiExtractBankStatement(Buffer.from('x'), 'big.pdf', 'application/pdf', { fetchImpl: fn })
    expect(r.errors.join(' ')).toMatch(/TRUNCATED/)
  })

  it('returns an error result (no throw) when API key is missing', async () => {
    delete process.env.ANTHROPIC_API_KEY
    const r = await aiExtractBankStatement(Buffer.from('x'), 'mercury.pdf', 'application/pdf')
    expect(r.transactions).toHaveLength(0)
    expect(r.errors.join(' ')).toMatch(/ANTHROPIC_API_KEY/)
  })

  // ── Reliability: retry on the non-deterministic empty/transient result ──
  // Returns a different response per call, in sequence.
  function makeSeqFetch(responses: Array<{ input?: FakeInput; status?: number; stopReason?: string }>) {
    const calls = { count: 0 }
    const fn = (async () => {
      const r = responses[Math.min(calls.count, responses.length - 1)]
      calls.count++
      if (r.status && r.status >= 400) return { ok: false, status: r.status, json: async () => ({ error: 'boom' }) } as Response
      return { ok: true, status: 200, json: async () => ({ stop_reason: r.stopReason || 'tool_use', content: [{ type: 'tool_use', name: 'record_statement', input: r.input || {} }] }) } as unknown as Response
    }) as unknown as typeof fetch
    return { fn, calls }
  }
  const TXN = { bank_name: 'Chase', currency: 'USD', opening_balance: 0, closing_balance: 94, transactions: [{ date: '2025-01-02', description: 'x', amount: 94, currency: 'USD' }] }

  it('retries a flaky EMPTY extraction and recovers on the next attempt', async () => {
    const { fn, calls } = makeSeqFetch([{ input: { transactions: [] } }, { input: TXN }])
    const r = await aiExtractBankStatement(Buffer.from('x'), 'chase.pdf', 'application/pdf', { fetchImpl: fn })
    expect(calls.count).toBe(2)
    expect(r.transactions).toHaveLength(1)
    expect(r.errors.join(' ')).toMatch(/Recovered after retry/)
  })

  it('retries a TRANSIENT API error (529) then succeeds', async () => {
    const { fn, calls } = makeSeqFetch([{ status: 529 }, { input: TXN }])
    const r = await aiExtractBankStatement(Buffer.from('x'), 'chase.pdf', 'application/pdf', { fetchImpl: fn })
    expect(calls.count).toBe(2)
    expect(r.transactions).toHaveLength(1)
  })

  it('does NOT retry a permanent 400 error', async () => {
    const { fn, calls } = makeSeqFetch([{ status: 400 }, { input: TXN }])
    const r = await aiExtractBankStatement(Buffer.from('x'), 'chase.pdf', 'application/pdf', { fetchImpl: fn })
    expect(calls.count).toBe(1)
    expect(r.transactions).toHaveLength(0)
  })

  it('does NOT retry a successful first call (exactly one request)', async () => {
    const { fn, calls } = makeSeqFetch([{ input: TXN }, { input: TXN }])
    const r = await aiExtractBankStatement(Buffer.from('x'), 'chase.pdf', 'application/pdf', { fetchImpl: fn })
    expect(calls.count).toBe(1)
    expect(r.transactions).toHaveLength(1)
  })

  it('gives up after MAX_ATTEMPTS if every attempt is empty (genuinely unreadable)', async () => {
    const { fn, calls } = makeSeqFetch([{ input: { transactions: [] } }])
    const r = await aiExtractBankStatement(Buffer.from('x'), 'scanned.pdf', 'application/pdf', { fetchImpl: fn })
    expect(calls.count).toBe(3)
    expect(r.transactions).toHaveLength(0)
  })

  // ── Large multi-page PDF chunking ──
  it('splits a LARGE (>15pp) PDF into page-chunks, extracts each, and merges', async () => {
    const pdf = await makePdf(20) // 20 pages → 10/chunk → 2 chunks
    const { fn, calls } = makeSeqFetch([
      { input: { bank_name: 'Chase', currency: 'USD', opening_balance: 0, closing_balance: 300, transactions: [{ date: '2025-01-01', description: 'c1', amount: 100, currency: 'USD' }] } },
      { input: { bank_name: 'Chase', currency: 'USD', opening_balance: 0, closing_balance: 300, transactions: [{ date: '2025-07-01', description: 'c2', amount: 200, currency: 'USD' }] } },
    ])
    const r = await aiExtractBankStatement(pdf, 'chase_big.pdf', 'application/pdf', { fetchImpl: fn })
    expect(calls.count).toBe(2) // 2 chunks → 2 extractions
    expect(r.transactions).toHaveLength(2)
    expect(r.transactions.map(t => t.amount).sort((a, b) => a - b)).toEqual([100, 200])
    expect(r.errors.join(' ')).toMatch(/2 page-chunks/)
    // first chunk opening (0) + Σ(300) == last chunk closing (300)
    expect(r.reconciliation?.reconciled).toBe(true)
  })

  it('does NOT chunk a small (<=15pp) PDF — single pass', async () => {
    const pdf = await makePdf(3)
    const { fn, calls } = makeSeqFetch([{ input: { bank_name: 'Relay', currency: 'USD', opening_balance: 0, closing_balance: 50, transactions: [{ date: '2025-01-01', description: 'x', amount: 50, currency: 'USD' }] } }])
    const r = await aiExtractBankStatement(pdf, 'small.pdf', 'application/pdf', { fetchImpl: fn })
    expect(calls.count).toBe(1)
    expect(r.transactions).toHaveLength(1)
    expect(r.errors.join(' ')).not.toMatch(/page-chunks/)
  })

  it('falls back to single pass when the PDF cannot be parsed for splitting', async () => {
    // a non-PDF buffer can't be loaded by pdf-lib → splitter returns null → single pass
    const { fn, calls } = makeSeqFetch([{ input: TXN }])
    const r = await aiExtractBankStatement(Buffer.from('not a real pdf'), 'weird.pdf', 'application/pdf', { fetchImpl: fn })
    expect(calls.count).toBe(1)
    expect(r.transactions).toHaveLength(1)
  })
})

describe('parseBankStatement routing', () => {
  it('uses the Wise CSV fast path and does NOT call AI', async () => {
    const { fn, calls } = makeFetch({ transactions: [] })
    const r = await parseBankStatement(Buffer.from(WISE_CSV), 'wise_usd.csv', 'text/csv', { fetchImpl: fn })
    expect(calls.count).toBe(0)
    expect(r.extraction_method).toBe('wise_csv')
    expect(r.transactions.length).toBe(2)
  })

  it('routes a non-Wise PDF to AI extraction', async () => {
    const { fn, calls } = makeFetch({
      bank_name: 'Relay', currency: 'USD', opening_balance: 0, closing_balance: 500,
      transactions: [{ date: '2025-05-01', description: 'Income', amount: 500, currency: 'USD' }],
    })
    const r = await parseBankStatement(Buffer.from('%PDF-1.4 fake'), 'relay_statement.pdf', 'application/pdf', { fetchImpl: fn })
    expect(calls.count).toBe(1)
    expect(r.extraction_method).toBe('ai')
    expect(r.transactions).toHaveLength(1)
  })

  it('unpacks a .zip and parses the inner statement (now free via the generic CSV parser, no AI)', async () => {
    const { fn, calls } = makeFetch({
      bank_name: 'Mercury', currency: 'USD', opening_balance: 0, closing_balance: 300,
      transactions: [{ date: '2025-06-01', description: 'Inner', amount: 300, currency: 'USD' }],
    })
    const zip = zipSync({ 'mercury_jan.csv': strToU8('date,amount\n2025-06-01,300\n') })
    const r = await parseBankStatement(Buffer.from(zip), 'mercury_2025.zip', 'application/zip', { fetchImpl: fn })
    // The inner "date,amount" CSV now parses deterministically (generic parser) → no AI call.
    expect(calls.count).toBe(0)
    expect(r.transactions).toHaveLength(1)
    expect(r.transactions[0].amount).toBe(300)
  })

  it('honors the BANK_STATEMENT_AI_DISABLED kill-switch (no AI call)', async () => {
    process.env.BANK_STATEMENT_AI_DISABLED = 'true'
    const { fn, calls } = makeFetch({ transactions: [] })
    const r = await parseBankStatement(Buffer.from('%PDF fake'), 'mercury.pdf', 'application/pdf', { fetchImpl: fn })
    expect(calls.count).toBe(0)
    expect(r.transactions).toHaveLength(0)
    expect(r.errors.join(' ')).toMatch(/AI extraction disabled/)
  })

  it('reports an unsupported file type cleanly', async () => {
    const r = await parseBankStatement(Buffer.from('x'), 'photo.jpg', 'image/jpeg')
    expect(r.transactions).toHaveLength(0)
    expect(r.errors.join(' ')).toMatch(/Unsupported file type/)
  })
})
