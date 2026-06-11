import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/lib/mcp/tools/doc', () => ({
  processFile: vi.fn(),
}))

import { handleDocumentReprocess } from '@/lib/jobs/handlers/document-reprocess'
import { processFile } from '@/lib/mcp/tools/doc'
import type { Job } from '@/lib/jobs/queue'

function job(payload: Record<string, unknown>): Job {
  return { id: 'job-1', job_type: 'document_reprocess', payload } as unknown as Job
}

describe('handleDocumentReprocess', () => {
  beforeEach(() => vi.clearAllMocks())

  it('reprocesses the file passing the account through (re-link guard)', async () => {
    vi.mocked(processFile).mockResolvedValue({
      success: true, fileName: 'Forms 1120.pdf', type: 'Form 1120', status: 'classified',
    } as Awaited<ReturnType<typeof processFile>>)

    const result = await handleDocumentReprocess(
      job({ document_id: 'doc-1', drive_file_id: 'drv-1', account_id: 'acct-1' })
    )

    expect(processFile).toHaveBeenCalledWith('drv-1', 'acct-1')
    expect(result.ok).not.toBe(false)
    expect(result.summary).toContain('Form 1120')
    expect(result.steps[0].status).toBe('ok')
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
