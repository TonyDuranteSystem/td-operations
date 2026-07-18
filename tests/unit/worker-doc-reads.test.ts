import { describe, it, expect } from 'vitest'
import {
  snippetAround,
  executeWorkerTool,
  WORKER_TOOLS,
  SEARCH_SYSDOCS_TOOL,
  READ_SYSDOC_TOOL,
  SEARCH_SOPS_TOOL,
  READ_DRIVE_FILE_TOOL,
  READ_PORTAL_ATTACHMENT_TOOL,
  searchSysdocsForWorker,
  readSysdocForWorker,
  searchSopsForWorker,
  readDriveFileForWorker,
  readPortalAttachmentForWorker,
  formatStoredExtraction,
  explainDriveReadFailure,
  STORED_OCR_TEXT_CAP,
} from '@/lib/ai-agent/worker-tools'

const DOC_TOOL_NAMES = ['search_sysdocs', 'read_sysdoc', 'search_sops', 'read_drive_file', 'read_portal_attachment']

describe('snippetAround', () => {
  it('centres the window on the first case-insensitive match', () => {
    const text = `${'a'.repeat(400)} INSTALLMENT rule lives here ${'b'.repeat(400)}`
    const out = snippetAround(text, 'installment', 50)
    expect(out).toContain('INSTALLMENT')
    // windowed, not the whole string
    expect(out.length).toBeLessThan(text.length)
    expect(out.startsWith('…')).toBe(true)
    expect(out.endsWith('…')).toBe(true)
  })

  it('falls back to the head when there is no match', () => {
    const text = 'c'.repeat(1000)
    const out = snippetAround(text, 'zzz', 100)
    expect(out.startsWith('c')).toBe(true)
    expect(out.endsWith('…')).toBe(true)
  })

  it('returns empty string for empty/non-string input', () => {
    expect(snippetAround('', 'x')).toBe('')
    // @ts-expect-error testing defensive non-string path
    expect(snippetAround(null, 'x')).toBe('')
  })
})

describe('doc-source reading tools are Slack-gated (R108)', () => {
  it('are NOT in WORKER_TOOLS (so the Hermes/Telegram research worker never gets them)', () => {
    const names = WORKER_TOOLS.map((t) => t.name)
    for (const n of DOC_TOOL_NAMES) expect(names).not.toContain(n)
  })

  it('executeWorkerTool refuses them when not offered this call (no availableNames)', async () => {
    for (const name of DOC_TOOL_NAMES) {
      const res = await executeWorkerTool(name, { query: 'x', slug: 'x', file_id: 'x' })
      expect(res).toContain('not permitted')
    }
  })

  it('executeWorkerTool refuses them when availableNames excludes them', async () => {
    const res = await executeWorkerTool('search_sysdocs', { query: 'x' }, new Set(['search_crm']))
    expect(res).toContain('not permitted')
  })

  it('exposes the correct tool names', () => {
    expect(SEARCH_SYSDOCS_TOOL.name).toBe('search_sysdocs')
    expect(READ_SYSDOC_TOOL.name).toBe('read_sysdoc')
    expect(SEARCH_SOPS_TOOL.name).toBe('search_sops')
    expect(READ_DRIVE_FILE_TOOL.name).toBe('read_drive_file')
    expect(READ_PORTAL_ATTACHMENT_TOOL.name).toBe('read_portal_attachment')
  })
})

describe('doc-source handlers validate required params before touching the DB', () => {
  it('search_sysdocs requires a query', async () => {
    expect(await searchSysdocsForWorker({})).toContain('query is required')
  })
  it('read_sysdoc requires a slug', async () => {
    expect(await readSysdocForWorker({})).toContain('slug is required')
  })
  it('search_sops requires a query', async () => {
    expect(await searchSopsForWorker({})).toContain('query is required')
  })
  it('read_drive_file requires a file_id', async () => {
    expect(await readDriveFileForWorker({})).toContain('file_id is required')
  })
  it('read_portal_attachment requires a url', async () => {
    expect(await readPortalAttachmentForWorker({})).toContain('url is required')
  })
})

describe('read_portal_attachment security guard', () => {
  it('rejects URLs from untrusted hosts', async () => {
    const res = await readPortalAttachmentForWorker({ url: 'https://evil.com/malware.pdf' })
    expect(res).toContain('not from a trusted source')
    expect(res).toContain('evil.com')
  })

  it('rejects malformed URLs', async () => {
    const res = await readPortalAttachmentForWorker({ url: 'not-a-url' })
    expect(res).toContain('Invalid URL')
  })

  it('accepts production Supabase storage host (network error expected without real file)', async () => {
    // URL is valid + trusted — it will fail at fetch (no real file), but the
    // security guard must not reject it. We just check the rejection message is
    // NOT the "not from a trusted source" message.
    const res = await readPortalAttachmentForWorker({
      url: 'https://ydzipybqeebtpcvsbtvs.supabase.co/storage/v1/object/public/assets/chat-attachments/fake.pdf',
    })
    expect(res).not.toContain('not from a trusted source')
    // Will fail with a fetch/HTTP error — that's fine
  })

  it('is not in WORKER_TOOLS (R108 — Hermes/Telegram never gets it)', () => {
    const names = WORKER_TOOLS.map((t) => t.name)
    expect(names).not.toContain('read_portal_attachment')
  })

  it('executeWorkerTool refuses it when not offered (no availableNames)', async () => {
    const res = await executeWorkerTool('read_portal_attachment', { url: 'https://ydzipybqeebtpcvsbtvs.supabase.co/x.pdf' })
    expect(res).toContain('not permitted')
  })
})

describe('formatStoredExtraction', () => {
  const base = { file_name: 'Return 2023.pdf', ocr_page_count: 35, processed_at: '2026-03-04T10:11:12Z' }

  it('labels the text as STORED, not a live read, so it is never reported as fresh', () => {
    const out = formatStoredExtraction({ ...base, ocr_text: 'Schedule K-1 line 21' })
    expect(out).toContain('Stored extracted text')
    expect(out).toContain('not a fresh read')
    expect(out).toContain('Schedule K-1 line 21')
  })

  it('surfaces page count and extraction date in the header', () => {
    const out = formatStoredExtraction({ ...base, ocr_text: 'body' })
    expect(out).toContain('35 page(s)')
    expect(out).toContain('2026-03-04')
    // date only — no time component leaking into worker prose
    expect(out).not.toContain('10:11:12')
  })

  it('returns null when there is no usable stored text', () => {
    expect(formatStoredExtraction({ ...base, ocr_text: null })).toBeNull()
    expect(formatStoredExtraction({ ...base, ocr_text: '' })).toBeNull()
    expect(formatStoredExtraction({ ...base, ocr_text: '   \n\t ' })).toBeNull()
  })

  it('flags a STORE-TIME cut as incomplete and says re-reading will not recover it', () => {
    // Text saved at exactly the store cap was truncated at processing time.
    const out = formatStoredExtraction({ ...base, ocr_text: 'x'.repeat(STORED_OCR_TEXT_CAP) })
    expect(out).toContain('INCOMPLETE')
    expect(out).toContain('will NOT recover')
    // The tax-return failure mode this exists to prevent: the missing tail
    // must not be reportable as "absent from the document".
    expect(out).toContain('not report the missing part as absent')
  })

  it('does NOT flag incompleteness for text comfortably under the store cap', () => {
    const out = formatStoredExtraction({ ...base, ocr_text: 'y'.repeat(STORED_OCR_TEXT_CAP - 1) })
    expect(out).not.toContain('INCOMPLETE')
  })

  it('boundary: one char under the cap is complete, exactly at the cap is not', () => {
    const under = formatStoredExtraction({ ...base, ocr_text: 'z'.repeat(STORED_OCR_TEXT_CAP - 1) })
    const at = formatStoredExtraction({ ...base, ocr_text: 'z'.repeat(STORED_OCR_TEXT_CAP) })
    expect(under).not.toContain('INCOMPLETE')
    expect(at).toContain('INCOMPLETE')
  })

  it('display-time truncation is reported separately from a store-time cut', () => {
    // Under the store cap (complete on the row) but longer than the display cap.
    const out = formatStoredExtraction({ ...base, ocr_text: 'w'.repeat(500) }, 100)
    expect(out).toContain('showing 100')
    expect(out).toContain('of 500 stored')
    expect(out).not.toContain('INCOMPLETE') // the tail is still on the row
  })

  it('survives a missing file name and page count without emitting "null"', () => {
    const out = formatStoredExtraction({
      file_name: null,
      ocr_page_count: null,
      processed_at: null,
      ocr_text: 'body',
    })
    expect(out).toContain('this file')
    expect(out).not.toContain('null')
  })
})

describe('explainDriveReadFailure', () => {
  it('maps the size limit', () => {
    expect(explainDriveReadFailure('File too large for inline processing: 22.4MB (max 15MB)'))
      .toContain('over the 15MB limit')
  })

  it('maps missing files and permission failures distinctly', () => {
    expect(explainDriveReadFailure('Drive metadata 404: Not Found')).toContain('no file with that id')
    expect(explainDriveReadFailure('Drive download 403: Forbidden')).toContain("can't open that file")
  })

  it('maps the page-limit rejection', () => {
    expect(
      explainDriveReadFailure('Document AI error 400: Document pages in non-imageless mode exceed the limit: 15 got 35'),
    ).toContain('more pages than the scanner accepts')
  })

  it('does NOT mislabel an unrelated failure as a page-limit problem', () => {
    // The council's specific warning: a corrupt/encrypted file must not be
    // reported as "too many pages" — that sends staff down the wrong path.
    const out = explainDriveReadFailure('Document AI error 400: unsupported encoding / corrupt document stream')
    expect(out).toBe('the file couldn\'t be read')
    expect(out).not.toContain('pages')
  })

  it('never echoes the raw upstream body back to the caller', () => {
    const raw = 'Document AI error 400: {"error":{"message":"internal project 796202564410 detail"}}'
    const out = explainDriveReadFailure(raw)
    expect(out).not.toContain('796202564410')
    expect(out).not.toContain('Document AI')
  })

  it('handles empty/garbage input without throwing', () => {
    expect(explainDriveReadFailure('')).toBe('the file couldn\'t be read')
    // @ts-expect-error defensive non-string path
    expect(explainDriveReadFailure(undefined)).toBe('the file couldn\'t be read')
  })
})
