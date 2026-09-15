import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/mcp/tools/doc', () => ({
  processFile: vi.fn(),
}))

let existingDocRow: { contact_id: string | null } | null = null

vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: {
    from: () => ({
      select: () => ({
        eq: () => ({
          maybeSingle: () => Promise.resolve({ data: existingDocRow, error: null }),
        }),
      }),
    }),
  },
}))

import { handleDocumentReprocess } from '@/lib/jobs/handlers/document-reprocess'
import { processFile } from '@/lib/mcp/tools/doc'
import type { Job } from '@/lib/jobs/queue'

function job(payload: Record<string, unknown>): Job {
  return { id: 'job-1', job_type: 'document_reprocess', payload } as unknown as Job
}

describe('handleDocumentReprocess', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    existingDocRow = null
  })

  it('reprocesses the file passing the account through (re-link guard)', async () => {
    vi.mocked(processFile).mockResolvedValue({
      success: true, fileName: 'Forms 1120.pdf', type: 'Form 1120', status: 'classified',
    } as Awaited<ReturnType<typeof processFile>>)

    const result = await handleDocumentReprocess(
      job({ document_id: 'doc-1', drive_file_id: 'drv-1', account_id: 'acct-1' })
    )

    expect(processFile).toHaveBeenCalledWith('drv-1', 'acct-1', undefined, undefined)
    expect(result.ok).not.toBe(false)
    expect(result.summary).toContain('Form 1120')
    expect(result.steps[0].status).toBe('ok')
  })

  it('passes a previously-resolved contact_id through, so reprocessing cannot silently un-assign a document a human already assigned', async () => {
    existingDocRow = { contact_id: 'contact-42' }
    vi.mocked(processFile).mockResolvedValue({
      success: true, fileName: 'Passport.pdf', type: 'Passport', status: 'classified',
    } as Awaited<ReturnType<typeof processFile>>)

    await handleDocumentReprocess(
      job({ document_id: 'doc-1', drive_file_id: 'drv-1', account_id: 'acct-1' })
    )

    expect(processFile).toHaveBeenCalledWith('drv-1', 'acct-1', undefined, 'contact-42')
  })

  it('passes undefined (not null) when no document row or no resolved contact exists yet, matching prior behavior', async () => {
    existingDocRow = { contact_id: null }
    vi.mocked(processFile).mockResolvedValue({
      success: true, fileName: 'Bank Statement.pdf', type: 'Bank Statement', status: 'classified',
    } as Awaited<ReturnType<typeof processFile>>)

    await handleDocumentReprocess(job({ document_id: 'doc-1', drive_file_id: 'drv-1' }))

    expect(processFile).toHaveBeenCalledWith('drv-1', undefined, undefined, undefined)
  })

  it('throws on processing failure so the queue retries until max_attempts', async () => {
    vi.mocked(processFile).mockResolvedValue({
      success: false, fileName: 'drv-1', status: 'error', error: 'Document AI error 403',
    } as Awaited<ReturnType<typeof processFile>>)

    await expect(
      handleDocumentReprocess(job({ document_id: 'doc-1', drive_file_id: 'drv-1' }))
    ).rejects.toThrow('Document AI error 403')
  })

  it('fails without retry signal on malformed payload (missing drive_file_id)', async () => {
    const result = await handleDocumentReprocess(job({ document_id: 'doc-1' }))
    expect(result.ok).toBe(false)
    expect(processFile).not.toHaveBeenCalled()
  })
})
