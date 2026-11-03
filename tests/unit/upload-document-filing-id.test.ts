/**
 * Job 64d2be64 — the upload route checks the State Filing ID staff confirmed, on the SERVER, before anything is stored: a plausible ID
 * passes (tidied), a value that cannot be an ID — including a non-text value from a direct API call — is refused with a plain sentence and
 * nothing is stored, and "no Filing ID" (absent / null / empty) is the normal, unchanged path.
 * Same harness as upload-document-legal-name.test.ts: the mocked storage download fails, so a 500 means "got past the Filing ID check".
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest } from 'next/server'

const h = vi.hoisted(() => ({
  sd: { id: 'sd-1', account_id: null as string | null, contact_id: 'c-1' as string | null, stage: 'Filed with State', service_type: 'Company Formation', due_date: null },
  downloads: 0,
}))

vi.mock('@/lib/auth/require-staff-route', () => ({ requireStaffRoute: async () => null }))
vi.mock('@/lib/service-delivery', () => ({ advanceServiceDelivery: vi.fn(async () => ({ success: true })) }))
vi.mock('@/lib/operations/formation-name-checks', () => ({ saveConfirmedLegalName: vi.fn(async () => ({ ok: true, saved: true })) }))
vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: {
    from: () => {
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: () => chain,
        in: () => chain,
        order: () => chain,
        limit: () => chain,
        single: () => Promise.resolve({ data: h.sd, error: null }),
        maybeSingle: () => Promise.resolve({ data: null, error: null }),
      }
      return chain
    },
    storage: {
      from: () => ({
        download: async () => { h.downloads++; return { data: null, error: { message: 'stop here' } } },
        remove: async () => ({ data: null, error: null }),
      }),
    },
  },
}))

import { POST } from '@/app/api/flows/[id]/upload-document/route'

const call = async (body: Record<string, unknown>) => {
  const res = await POST(
    new NextRequest('http://localhost/api/flows/sd-1/upload-document', { method: 'POST', body: JSON.stringify({ storage_path: 'flow-uploads/sd-1/a.pdf', file_name: 'Articles.pdf', flow_stage: 'Filed with State', ...body }) }),
    { params: { id: 'sd-1' } },
  )
  return { status: res.status, body: await res.json() }
}

beforeEach(() => {
  h.sd = { id: 'sd-1', account_id: null, contact_id: 'c-1', stage: 'Filed with State', service_type: 'Company Formation', due_date: null }
  h.downloads = 0
})

describe('upload-document — confirmed State Filing ID (server side)', () => {
  it('no Filing ID sent (or null, or empty text): the normal path — nothing refused', async () => {
    for (const filing_id of [undefined, null, '', '   ']) {
      h.downloads = 0
      const r = await call({ filing_id })
      expect(r.status).toBe(500) // got past the check, stopped at the mocked storage download
      expect(h.downloads).toBe(1)
    }
  })

  it('a plausible ID passes — including one with the spaces and dashes a PDF copy leaves', async () => {
    for (const filing_id of ['2026-002103965', ' 2026 – 002103965 ', 'l26000009149', '3190157']) {
      h.downloads = 0
      const r = await call({ filing_id })
      expect(r.status).toBe(500)
      expect(h.downloads).toBe(1)
    }
  })

  it('a value that cannot be an ID is refused with a plain sentence — 400, and the staged file is not touched', async () => {
    for (const filing_id of ['12/34', 'abc', 'NOTANUMBER', '2026 002103965', '1'.repeat(31)]) {
      h.downloads = 0
      const r = await call({ filing_id })
      expect(r.status).toBe(400)
      expect(r.body.detail).toContain('can only contain letters, numbers and dashes')
      expect(r.body.error).toBe(r.body.detail) // the window reads either (R099: show the server's reason)
      expect(h.downloads).toBe(0)
    }
  })

  it('a non-text value (a number, a list, an object, true) is refused, never silently ignored', async () => {
    for (const filing_id of [2026002103965, ['2026-002103965'], { id: '2026-002103965' }, true, 0]) {
      h.downloads = 0
      const r = await call({ filing_id })
      expect(r.status).toBe(400)
      expect(r.body.detail).toContain('can only contain letters, numbers and dashes')
      expect(h.downloads).toBe(0)
    }
  })
})
