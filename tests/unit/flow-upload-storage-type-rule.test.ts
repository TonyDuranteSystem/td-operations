/**
 * Dev job e3215801 — the workspace upload route follows the STORAGE rule for the document type: a box with a type picker sends the chosen type, a bad
 * one is refused BEFORE anything is downloaded or saved (and the staged file is removed); a box without a picker (no type sent) is untouched.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextRequest, NextResponse } from 'next/server'

const fx = vi.hoisted(() => ({
  staff: true,
  resolved: { ok: true, slug: 'itin_letter' } as { ok: true; slug: string | null } | { ok: false; error: string },
  resolveCalls: [] as Array<Record<string, unknown>>,
  removed: [] as string[],
  downloads: [] as string[],
}))

vi.mock('@/lib/auth/require-staff-route', () => ({
  requireStaffRoute: async () => (fx.staff ? null : NextResponse.json({ error: 'Staff only' }, { status: 403 })),
}))
vi.mock('@/lib/flows/flow-upload-type', () => ({
  resolveFlowUploadType: async (input: Record<string, unknown>) => { fx.resolveCalls.push(input); return fx.resolved },
}))
vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: {
    from: () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const b: any = {}
      b.select = () => b
      b.eq = () => b
      b.single = async () => ({ data: { id: 'sd-1', account_id: null, contact_id: 'c-1', stage: 'ITIN Approved', service_type: 'ITIN', due_date: null }, error: null })
      return b
    },
    storage: {
      from: () => ({
        remove: async (paths: string[]) => { fx.removed.push(...paths); return { data: null, error: null } },
        download: async (p: string) => { fx.downloads.push(p); return { data: null, error: { message: 'stop here' } } },
      }),
    },
  },
}))

import { POST as upload } from '@/app/api/flows/[id]/upload-document/route'

const req = (body: Record<string, unknown>) => new NextRequest('http://localhost/api/flows/sd-1/upload-document', { method: 'POST', body: JSON.stringify(body) })
const call = (body: Record<string, unknown>) => upload(req(body), { params: { id: 'sd-1' } })
const BODY = { storage_path: 'flow-uploads/sd-1/1_letter.pdf', file_name: 'letter.pdf', mime_type: 'application/pdf', flow_stage: 'ITIN Approved' }

beforeEach(() => { fx.staff = true; fx.resolved = { ok: true, slug: 'itin_letter' }; fx.resolveCalls = []; fx.removed = []; fx.downloads = [] })

describe('POST /api/flows/[id]/upload-document — the document type follows the Storage rule', () => {
  it('a refused type -> 400 with the plain sentence, NOTHING downloaded, the staged file removed', async () => {
    fx.resolved = { ok: false, error: 'Choose a document type from the list.' }
    const res = await call({ ...BODY, document_type: 'made_up' })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ success: false, detail: 'Choose a document type from the list.' })
    expect(fx.downloads).toEqual([])
    expect(fx.removed).toEqual([BODY.storage_path])
  })

  it('the check knows where the file lands and whether the client will see it (the ITIN letter at ITIN Approved: a person\'s storage, ITIN folder, visible)', async () => {
    await call({ ...BODY, document_type: 'itin_letter' })
    expect(fx.resolveCalls[0]).toEqual({ slug: 'itin_letter', ownerKind: 'person', visibleToClient: true, folderKind: 'itin' })
  })

  it('an accepted type goes on (it reaches the download); no type sent (a box without a picker) goes on exactly as before', async () => {
    await call({ ...BODY, document_type: 'itin_letter' })
    expect(fx.downloads).toEqual([BODY.storage_path])
    fx.downloads = []
    fx.resolved = { ok: true, slug: null }
    await call(BODY)
    expect(fx.resolveCalls[1].slug).toBeUndefined()
    expect(fx.downloads).toEqual([BODY.storage_path])
  })

  it('a staged file outside the flow-uploads area is never removed by a refusal', async () => {
    fx.resolved = { ok: false, error: 'x' }
    await call({ ...BODY, storage_path: 'elsewhere/../secret.pdf', document_type: 'nope' })
    expect(fx.removed).toEqual([])
  })
})
