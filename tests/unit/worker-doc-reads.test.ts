import { describe, it, expect } from 'vitest'
import {
  snippetAround,
  executeWorkerTool,
  WORKER_TOOLS,
  SEARCH_SYSDOCS_TOOL,
  READ_SYSDOC_TOOL,
  SEARCH_SOPS_TOOL,
  READ_DRIVE_FILE_TOOL,
  searchSysdocsForWorker,
  readSysdocForWorker,
  searchSopsForWorker,
  readDriveFileForWorker,
} from '@/lib/ai-agent/worker-tools'

const DOC_TOOL_NAMES = ['search_sysdocs', 'read_sysdoc', 'search_sops', 'read_drive_file']

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
})
