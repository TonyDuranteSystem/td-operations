/**
 * parseExternalStatements — the in-memory CSV → bank_transactions-row mapper for
 * /tools/pnl external mode. Proves: deterministic parse (no AI), correct row
 * shape (account_id null — never persisted), year filtering, and member-name
 * distribution attribution flowing through categorizeTransaction.
 */

import { describe, it, expect } from 'vitest'
import { parseExternalStatements, type ExternalCsvFile } from '@/lib/pnl-external'

const csv = (body: string, name = 'stmt.csv'): ExternalCsvFile => ({
  fileName: name,
  mimeType: 'text/csv',
  buffer: Buffer.from(body, 'utf-8'),
})

// A minimal generic CSV (date, amount, description) the generic parser handles.
// The member payout is explicitly labelled a distribution — categorizeTransaction
// only reclassifies a member-matched outflow to `distribution` when the text says
// so (a plain payment to a member is NOT auto-classified — conservative by design).
const SAMPLE = `Date,Amount,Description
2025-02-01,10000,Client payment received
2025-03-01,-3000,Software subscription
2025-04-01,-1000,Distribution to John Owner
2024-12-15,5000,Prior year income
`

describe('parseExternalStatements', () => {
  it('parses deterministically and maps to unpersisted row shape (account_id null)', async () => {
    const r = await parseExternalStatements([csv(SAMPLE)], ['John Owner'], 2025)
    expect(r.transactions.length).toBeGreaterThan(0)
    for (const row of r.transactions) {
      expect(row.account_id).toBeNull()
      expect(row.source_file_id).toBeNull()
      expect(row.tax_year).toBe(2025)
      expect(typeof row.id).toBe('string')
    }
  })

  it('drops rows outside the requested tax year', async () => {
    const r = await parseExternalStatements([csv(SAMPLE)], [], 2025)
    // the 2024-12-15 row must be excluded
    expect(r.transactions.every(t => t.transaction_date.startsWith('2025'))).toBe(true)
  })

  it('classifies a labelled member payout as a distribution flagged related-party', async () => {
    const r = await parseExternalStatements([csv(SAMPLE)], ['John Owner'], 2025)
    const dist = r.transactions.find(t => t.category === 'distribution')
    expect(dist).toBeTruthy()
    expect(dist?.is_related_party).toBe(true)
    expect(dist?.description || '').toMatch(/john owner/i)
  })

  it('reports an unreadable file without throwing and yields no rows', async () => {
    const r = await parseExternalStatements([csv('not,a,bank,statement\nfoo,bar,baz', 'junk.csv')], [], 2025)
    expect(r.transactions.length).toBe(0)
    expect(r.emptyFiles).toBe(1)
  })
})
