/**
 * Tax Return plan item 7 (dev job 6f555c9f) — "Yes, that number is the IRS" (POST /api/flows/[id]/extension-fax/confirm-recipient): the person's
 * confirmation that lets a HELD extension fax (delivered to a number nobody had confirmed) be filed. It confirms only what the delivery check really
 * held, once, records who confirmed it, and then runs the same delivery check.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const fx = vi.hoisted(() => ({
  staff: true,
  job: null as Record<string, unknown> | null,
  fax: null as { created_at: string; record_id: string | null; details: Record<string, unknown> } | null,
  markers: new Set<string>(),
  written: [] as Array<{ kind: string; details: Record<string, unknown> }>,
  fail: {} as Record<string, boolean>,
  process: { outcome: 'filed', documentSaved: true, messagePosted: true } as Record<string, unknown>,
  processCalls: 0,
}))

vi.mock('@/lib/supabase/server', () => ({ createClient: () => ({ auth: { getUser: async () => ({ data: { user: { id: 'user-1', email: 'luca@example.test' } } }) } }) }))
vi.mock('@/lib/auth', () => ({ isDashboardUser: () => fx.staff }))
vi.mock('@/lib/fax/extension-fax-delivery', () => ({
  realExtensionFaxDeps: async () => ({
    loadJob: async () => (fx.fail.job ? { job: null, error: 'db' } : { job: fx.job, error: null }),
    latestFax: async () => (fx.fail.fax ? { row: null, error: 'db' } : { row: fx.fax, error: null }),
    markerExists: async (kind: string) => (fx.fail[kind] ? { exists: false, error: 'db' } : { exists: fx.markers.has(kind), error: null }),
    writeMarker: async (kind: string, p: { details: Record<string, unknown> }) => {
      if (fx.fail.write) return { error: 'db' }
      fx.written.push({ kind, details: p.details })
      fx.markers.add(kind)
      return { error: null }
    },
  }),
  processExtensionFaxDelivery: async () => { fx.processCalls++; return fx.process },
}))

import { POST } from '@/app/api/flows/[id]/extension-fax/confirm-recipient/route'
import { EXTENSION_FAX_MARKERS } from '@/lib/fax/extension-fax'

const call = () => POST({} as never, { params: { id: 'sd-1' } })

beforeEach(() => {
  fx.staff = true
  fx.job = { id: 'sd-1', service_type: 'Tax Return', stage: '1st Installment Paid', status: 'active', account_id: 'acc-1' }
  fx.fax = { created_at: '2026-11-09T10:00:00Z', record_id: 'doc-1', details: { job_id: 'F1', faxno: '1 (800) 555-0199' } }
  fx.markers = new Set([EXTENSION_FAX_MARKERS.recipientUnverified])
  fx.written = []; fx.fail = {}; fx.processCalls = 0
  fx.process = { outcome: 'filed', documentSaved: true, messagePosted: true }
})

describe('confirm-recipient', () => {
  it('staff only', async () => {
    fx.staff = false
    expect((await call()).status).toBe(403)
    expect(fx.written).toEqual([])
  })
  it('records ONE confirmation for THIS fax (with the number and who confirmed it), then runs the delivery check', async () => {
    const res = await call()
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ success: true, result: { outcome: 'filed' } })
    expect(fx.written).toEqual([{ kind: EXTENSION_FAX_MARKERS.recipientConfirmed, details: { job_id: 'F1', faxno: '1 (800) 555-0199', faxno_digits: '8005550199', confirmed_by: 'luca@example.test' } }])
    expect(fx.processCalls).toBe(1)
  })
  it('pressing it again does not write a second confirmation (it only runs the check)', async () => {
    fx.markers.add(EXTENSION_FAX_MARKERS.recipientConfirmed)
    expect((await call()).status).toBe(200)
    expect(fx.written).toEqual([])
    expect(fx.processCalls).toBe(1)
  })
  it('refuses to confirm a fax the check never held: nothing is written and nothing is filed', async () => {
    fx.markers = new Set()
    const res = await call()
    expect(res.status).toBe(409)
    expect(fx.written).toEqual([])
    expect(fx.processCalls).toBe(0)
  })
  it('refuses when there is no fax, the job is not waiting, is cancelled, or is not a Tax Return', async () => {
    fx.fax = null
    expect((await call()).status).toBe(409)
    fx.fax = { created_at: '2026-11-09T10:00:00Z', record_id: 'doc-1', details: { job_id: 'F1' } }
    fx.job = { ...fx.job, stage: 'Extension Filed' }
    expect((await call()).status).toBe(409)
    fx.job = { ...fx.job, stage: '1st Installment Paid', status: 'cancelled' }
    expect((await call()).status).toBe(409)
    fx.job = { ...fx.job, status: 'active', service_type: 'ITIN' }
    expect((await call()).status).toBe(400)
    fx.job = null
    expect((await call()).status).toBe(404)
    expect(fx.written).toEqual([])
    expect(fx.processCalls).toBe(0)
  })
  it('FAILS CLOSED: a lookup or a write that fails is a 503 and nothing is filed', async () => {
    for (const key of ['job', 'fax', EXTENSION_FAX_MARKERS.recipientUnverified, 'write']) {
      fx.markers = new Set([EXTENSION_FAX_MARKERS.recipientUnverified]); fx.written = []; fx.processCalls = 0; fx.fail = { [key]: true }
      expect((await call()).status, key).toBe(503)
      expect(fx.processCalls, key).toBe(0)
    }
  })
  it('if the check then cannot file yet, the confirmation is kept and the person is told it is retried', async () => {
    fx.process = { outcome: 'error', error: 'chat down' }
    const res = await call()
    expect(res.status).toBe(502)
    expect((await res.json()).error).toContain('retried every few minutes')
    expect(fx.written).toHaveLength(1)
  })
})
