/**
 * Dev job e3215801 — the Storage page / contact page no longer carry a hardcoded list of "document types that can wait for a workspace step": they ask
 * the server (built from the stage layouts) once. A list that cannot be loaded means "check everything", never "check nothing".
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { NextResponse } from 'next/server'

const fx = vi.hoisted(() => ({
  staff: true,
  hintsThrow: false,
}))

vi.mock('@/lib/auth/require-staff-route', () => ({
  requireStaffRoute: async () => (fx.staff ? null : NextResponse.json({ error: 'Staff only' }, { status: 403 })),
}))
vi.mock('@/lib/flows/storage-step-hints', async () => {
  const rules = await vi.importActual<typeof import('@/lib/flows/storage-step-rules')>('@/lib/flows/storage-step-rules')
  return {
    ...rules,
    loadStepHints: async () => {
      if (fx.hintsThrow) throw new Error('db down')
      return rules.buildStepHints([
        { service_type: 'T', stage_name: 'A', stage_order: 1, stage_layout: { components: [{ type: 'document_upload', label: 'Up', documentType: 'doc_a', storageHint: { acceptsTypes: ['doc_b'], folderKind: 'k', otherDocumentCounts: true } }] } },
      ])
    },
  }
})

import { GET } from '@/app/api/crm/admin-actions/workspace-types/route'

beforeEach(() => {
  fx.staff = true
  fx.hintsThrow = false
})

describe('GET /api/crm/admin-actions/workspace-types', () => {
  it('staff get the types any workspace box takes (and the "Other document" rule), built from the layouts', async () => {
    const res = await GET()
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ summary: { types: ['doc_a', 'doc_b'], vagueTypes: ['other_document'] } })
    expect(res.headers.get('cache-control')).toBe('no-store')
  })
  it('anyone else is refused', async () => {
    fx.staff = false
    expect((await GET()).status).toBe(403)
  })
  it('a layout read that fails answers 503 (the pages then check every upload)', async () => {
    fx.hintsThrow = true
    expect((await GET()).status).toBe(503)
  })
})

describe('the browser helper', () => {
  const realFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = realFetch
    vi.resetModules()
  })
  async function fresh() {
    vi.resetModules()
    return import('@/lib/flows/workspace-wait-client')
  }
  it('loads the list once and answers from it (an ordinary type is skipped, a workspace type is checked)', async () => {
    const f = vi.fn(async () => new Response(JSON.stringify({ summary: { types: ['doc_a'], vagueTypes: ['other_document'] } }), { status: 200 }))
    globalThis.fetch = f as unknown as typeof fetch
    const m = await fresh()
    expect(await m.typeCouldWaitNow('doc_a')).toBe(true)
    expect(await m.typeCouldWaitNow('other_document')).toBe(true)
    expect(await m.typeCouldWaitNow('passport')).toBe(false)
    expect(f).toHaveBeenCalledTimes(1)
  })
  it('a list that cannot be loaded means CHECK EVERYTHING — and the next upload tries to load it again', async () => {
    let n = 0
    const f = vi.fn(async () => { n++; return n === 1 ? new Response('{}', { status: 503 }) : new Response(JSON.stringify({ summary: { types: ['doc_a'], vagueTypes: [] } }), { status: 200 }) })
    globalThis.fetch = f as unknown as typeof fetch
    const m = await fresh()
    expect(await m.typeCouldWaitNow('passport')).toBe(true)     // unknown list -> check
    expect(await m.typeCouldWaitNow('passport')).toBe(false)    // loaded on the retry
    expect(f).toHaveBeenCalledTimes(2)
  })
  it('keeps the list for one minute (so a workspace change is noticed quickly), then reads it again; resetWaitSummary forgets it at once', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const f = vi.fn(async () => new Response(JSON.stringify({ summary: { types: ['doc_a'], vagueTypes: [] } }), { status: 200 }))
      globalThis.fetch = f as unknown as typeof fetch
      const m = await fresh()
      await m.loadWaitSummary()
      vi.setSystemTime(Date.now() + 59_000)
      await m.loadWaitSummary()
      expect(f).toHaveBeenCalledTimes(1)
      vi.setSystemTime(Date.now() + 2_000)           // 61 s after the first read
      await m.loadWaitSummary()
      expect(f).toHaveBeenCalledTimes(2)
      m.resetWaitSummary()
      await m.loadWaitSummary()
      expect(f).toHaveBeenCalledTimes(3)
    } finally {
      vi.useRealTimers()
    }
  })
  it('a request that never answers is given up after 5 seconds: the answer is "unknown" (check everything), not a stuck upload', async () => {
    vi.useFakeTimers()
    try {
      globalThis.fetch = (() => new Promise(() => {})) as unknown as typeof fetch
      const m = await fresh()
      const asked = m.typeCouldWaitNow('passport')
      await vi.advanceTimersByTimeAsync(5_001)
      expect(await asked).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })
  it('a network failure or a nonsense answer is the same as "unknown"', async () => {
    globalThis.fetch = (async () => { throw new Error('offline') }) as unknown as typeof fetch
    let m = await fresh()
    expect(await m.loadWaitSummary()).toBeNull()
    globalThis.fetch = (async () => new Response(JSON.stringify({ summary: { types: 'x' } }), { status: 200 })) as unknown as typeof fetch
    m = await fresh()
    expect(await m.loadWaitSummary()).toBeNull()
  })
})

describe('wiring: nothing keeps a hardcoded list', () => {
  const read = (p: string) => readFileSync(join(__dirname, '../..', p), 'utf8')
  it('the Storage page and the contact page ask the workspaces (typeCouldWaitNow), not a static type list', () => {
    for (const f of ['components/storage/new-store-browser.tsx', 'components/contacts/contact-detail.tsx']) {
      const src = read(f)
      expect(src, f).toContain("from '@/lib/flows/workspace-wait-client'")
      expect(src, f).toContain('typeCouldWaitNow(')
      expect(src, f).not.toMatch(/\btypeCouldWait\(/)
    }
  })
  it('both pages recover from a refusal caused by an out-of-date list: they read the list again and start the upload over ONCE (so the proper question is asked)', () => {
    const storage = read('components/storage/new-store-browser.tsx')
    expect(storage).toContain("(e.data as { code?: unknown } | undefined)?.code === 'workspace_step_waiting'")
    expect(storage).toContain('resetWaitSummary()')
    expect(storage).toContain('workspaceRechecked: true')
    expect(storage).toContain('!o.workspaceRechecked')
    const contact = read('components/contacts/contact-detail.tsx')
    expect(contact).toContain("data.code === 'workspace_step_waiting' && !workspaceRechecked")
    expect(contact).toContain('await handleFileUpload(file, true)')
    expect(read('components/storage/store-ui-rules.ts')).toContain('data?: unknown')
    expect(storage).toContain('res.status, data)')
  })
  it('the rules file has no list of services or document types written in it', () => {
    const src = read('lib/flows/storage-step-rules.ts')
    expect(src).not.toContain("serviceType: 'ITIN'")
    expect(src).not.toContain('itin_letter_client_received')
    expect(src).not.toMatch(/STORAGE_STEP_HINTS/)
  })
  it('the server lookups, the guide page and the upload routes use the rules built from the layouts', () => {
    expect(read('lib/flows/storage-step-hints.ts')).toContain("from('pipeline_stages')")
    expect(read('app/(dashboard)/flows/[id]/page.tsx')).toContain('buildStepHints(')
  })
})
