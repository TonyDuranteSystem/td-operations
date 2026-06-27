import { describe, it, expect, vi, beforeEach } from 'vitest'

let rows: Array<{ payload: { tax_year?: number | string } }> = []
let err: { message: string } | null = null
vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: {
    from: () => {
      const chain: Record<string, unknown> = {}
      chain.select = () => chain
      chain.eq = () => chain
      chain.in = () => Promise.resolve({ data: rows, error: err })
      return chain
    },
  },
}))

import { countInFlightIngestJobs } from '@/lib/tax/ingest-status'

beforeEach(() => { rows = []; err = null })

describe('countInFlightIngestJobs', () => {
  it('counts only pending/processing jobs for the matching tax year', async () => {
    rows = [
      { payload: { tax_year: 2025 } },
      { payload: { tax_year: 2025 } },
      { payload: { tax_year: 2024 } },   // different year — excluded
      { payload: {} },                    // no year — excluded
    ]
    expect(await countInFlightIngestJobs('acc', 2025)).toBe(2)
  })

  it('matches when tax_year is a JSON string', async () => {
    rows = [{ payload: { tax_year: '2025' } }]
    expect(await countInFlightIngestJobs('acc', 2025)).toBe(1)
  })

  it('returns 0 when nothing is in flight', async () => {
    rows = []
    expect(await countInFlightIngestJobs('acc', 2025)).toBe(0)
  })

  it('throws on a query error (caller surfaces it)', async () => {
    err = { message: 'db down' }
    await expect(countInFlightIngestJobs('acc', 2025)).rejects.toThrow(/db down/)
  })
})
