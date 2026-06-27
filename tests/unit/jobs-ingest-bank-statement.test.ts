import { describe, it, expect, vi, beforeEach } from 'vitest'

// Hoisted mocks so the vi.mock factories (hoisted above imports) can reference them.
const { mockDownload, mockIngest, mockExtractZip, mockSaveEnqueue } = vi.hoisted(() => ({
  mockDownload: vi.fn(),
  mockIngest: vi.fn(),
  mockExtractZip: vi.fn(),
  mockSaveEnqueue: vi.fn(),
}))

vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: { storage: { from: () => ({ download: mockDownload }) } },
}))
vi.mock('@/lib/tax/portal-csv-ingest', () => ({ ingestPortalCsv: mockIngest }))
vi.mock('@/lib/bank-statement-parser', () => ({ extractZipStatements: mockExtractZip }))
vi.mock('@/lib/tax/portal-upload-enqueue', () => ({ saveAndEnqueueStatementUpload: mockSaveEnqueue }))

import { handleIngestBankStatement } from '@/lib/jobs/handlers/ingest-bank-statement'
import type { Job } from '@/lib/jobs/queue'

function job(payload: Record<string, unknown>): Job {
  return { id: 'job-1', job_type: 'ingest_bank_statement', payload } as unknown as Job
}
const blob = { arrayBuffer: async () => new ArrayBuffer(8) }
const ingestResult = (over: Record<string, unknown> = {}) => ({
  ok: true, inserted: 5, parsed: 5, months: ['2025-01'], bankDetected: 'Mercury',
  uncategorizedRemaining: 0, sourceFileId: 'upload:abc', alert: null, ...over,
})

describe('handleIngestBankStatement', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockDownload.mockResolvedValue({ data: blob, error: null })
  })

  it('fails without retry on a malformed payload (missing path)', async () => {
    const r = await handleIngestBankStatement(job({ account_id: 'a', tax_year: 2025 }))
    expect(r.ok).toBe(false)
    expect(mockDownload).not.toHaveBeenCalled()
    expect(mockIngest).not.toHaveBeenCalled()
  })

  it('fails without retry when tax_year is not an integer', async () => {
    const r = await handleIngestBankStatement(job({ account_id: 'a', tax_year: 'nope', path: 'tax/a/bank_statements_x_f.csv' }))
    expect(r.ok).toBe(false)
    expect(mockIngest).not.toHaveBeenCalled()
  })

  it('ingests a statement and reports the inserted count', async () => {
    mockIngest.mockResolvedValue(ingestResult({ inserted: 5 }))
    const r = await handleIngestBankStatement(
      job({ account_id: 'a', tax_year: 2025, path: 'tax/a/bank_statements_x_MERCURY.pdf', bank_label: 'MERCURY' }),
    )
    expect(r.ok).not.toBe(false)
    expect(r.steps[0].status).toBe('ok')
    expect(r.summary).toContain('5 transactions')
    expect(mockIngest).toHaveBeenCalledOnce()
    // The fallback bank_label is forwarded; account_kind is a constant (unused downstream).
    expect(mockIngest).toHaveBeenCalledWith(expect.objectContaining({ accountId: 'a', taxYear: 2025, bankLabel: 'MERCURY' }))
  })

  it('returns ok:false (no retry) when the file cannot be read', async () => {
    mockIngest.mockResolvedValue(ingestResult({ ok: false, error: 'We could not read any transactions', inserted: 0, parsed: 0 }))
    const r = await handleIngestBankStatement(job({ account_id: 'a', tax_year: 2025, path: 'tax/a/bank_statements_x_bad.csv' }))
    expect(r.ok).toBe(false)
    expect(r.steps[0].status).toBe('error')
  })

  it('throws on download failure so the worker retries (transient)', async () => {
    mockDownload.mockResolvedValue({ data: null, error: { message: 'object not found' } })
    await expect(
      handleIngestBankStatement(job({ account_id: 'a', tax_year: 2025, path: 'tax/a/bank_statements_x_gone.pdf' })),
    ).rejects.toThrow('object not found')
    expect(mockIngest).not.toHaveBeenCalled()
  })

  describe('.zip fan-out', () => {
    it('expands a zip into one ingest job per inner statement (no inline ingest)', async () => {
      mockExtractZip.mockResolvedValue([
        { name: 'jan.pdf', bytes: new Uint8Array([1]), mime: 'application/pdf' },
        { name: 'feb.csv', bytes: new Uint8Array([2]), mime: 'text/csv' },
      ])
      mockSaveEnqueue
        .mockResolvedValueOnce({ queued: true, alreadyQueued: false, path: 'p1' })
        .mockResolvedValueOnce({ queued: true, alreadyQueued: false, path: 'p2' })
      const r = await handleIngestBankStatement(
        job({ account_id: 'a', tax_year: 2025, path: 'tax/a/bank_statements_x_MERCURY.zip', bank_label: 'Mercury' }),
      )
      expect(r.ok).not.toBe(false)
      expect(r.summary).toContain('into 2 statement job(s)')
      expect(mockSaveEnqueue).toHaveBeenCalledTimes(2)
      expect(mockSaveEnqueue).toHaveBeenCalledWith(expect.objectContaining({ accountId: 'a', taxYear: 2025, bankLabel: 'Mercury', fileName: 'jan.pdf' }))
      // The zip itself is NEVER ingested inline.
      expect(mockIngest).not.toHaveBeenCalled()
    })

    it('idempotent: already-queued inner files are counted as skipped, not re-ingested', async () => {
      mockExtractZip.mockResolvedValue([{ name: 'jan.pdf', bytes: new Uint8Array([1]), mime: 'application/pdf' }])
      mockSaveEnqueue.mockResolvedValue({ queued: false, alreadyQueued: true, path: 'p1' })
      const r = await handleIngestBankStatement(job({ account_id: 'a', tax_year: 2025, path: 'tax/a/x.zip' }))
      expect(r.ok).not.toBe(false)
      expect(r.steps[0].detail).toContain('1 already queued')
    })

    it('ok:false (no retry) when the archive has no statements', async () => {
      mockExtractZip.mockResolvedValue([])
      const r = await handleIngestBankStatement(job({ account_id: 'a', tax_year: 2025, path: 'tax/a/empty.zip' }))
      expect(r.ok).toBe(false)
      expect(r.summary).toContain('No statements found')
      expect(mockSaveEnqueue).not.toHaveBeenCalled()
    })

    it('ok:false (no retry) when the archive is corrupt', async () => {
      mockExtractZip.mockRejectedValue(new Error('invalid zip data'))
      const r = await handleIngestBankStatement(job({ account_id: 'a', tax_year: 2025, path: 'tax/a/corrupt.zip' }))
      expect(r.ok).toBe(false)
      expect(r.steps[0].detail).toContain('could not open archive')
    })

    it('throws (retry) when every inner enqueue fails (transient storage/db)', async () => {
      mockExtractZip.mockResolvedValue([{ name: 'jan.pdf', bytes: new Uint8Array([1]), mime: 'application/pdf' }])
      mockSaveEnqueue.mockRejectedValue(new Error('storage down'))
      await expect(
        handleIngestBankStatement(job({ account_id: 'a', tax_year: 2025, path: 'tax/a/x.zip' })),
      ).rejects.toThrow(/Failed to expand/)
    })
  })
})
