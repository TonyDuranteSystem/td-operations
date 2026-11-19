/**
 * /api/crm/admin-actions/start-new-company — the door (dev job bf9886a3): staff only, bad input refused before anything runs,
 * a refusal answers 409 with the plain sentence, and the route is allowed the same 60 seconds as the other multi-step admin actions.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { NextResponse } from 'next/server'

const h = vi.hoisted(() => ({
  denied: null as unknown,
  user: { id: 'staff-1', email: 'staff@example.com' } as { id: string; email: string } | null,
  start: vi.fn(),
  preview: vi.fn(),
}))

vi.mock('@/lib/auth/require-staff-route', () => ({ requireStaffRoute: async () => h.denied }))
vi.mock('@/lib/supabase/server', () => ({
  createClient: () => ({ auth: { getUser: async () => ({ data: { user: h.user }, error: null }) } }),
}))
vi.mock('@/lib/operations/start-new-company', () => ({
  previewStartNewCompany: (...a: unknown[]) => h.preview(...a),
  startNewCompany: (...a: unknown[]) => h.start(...a),
}))

import { GET, POST, maxDuration } from '@/app/api/crm/admin-actions/start-new-company/route'

const CONTACT = '11111111-1111-4111-8111-111111111111'
const JOB = '33333333-3333-4333-8333-333333333333'

const post = (body: unknown) =>
  POST(new Request('http://localhost/api/crm/admin-actions/start-new-company', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) as never)
const get = (qs: string) => GET({ nextUrl: new URL(`http://localhost/api/crm/admin-actions/start-new-company${qs}`) } as never)

beforeEach(() => {
  h.denied = null
  h.user = { id: 'staff-1', email: 'staff@example.com' }
  h.start.mockReset()
  h.preview.mockReset()
})

describe('start-new-company route', () => {
  it('is allowed 60 seconds, like the other multi-step admin actions', () => {
    expect(maxDuration).toBe(60)
  })

  it('turns a non-staff caller away before anything runs', async () => {
    h.denied = NextResponse.json({ error: 'Forbidden' }, { status: 403 })
    expect((await post({ contact_id: CONTACT, replace_delivery_id: JOB, message: 'x' })).status).toBe(403)
    expect((await get(`?contact_id=${CONTACT}`)).status).toBe(403)
    expect(h.start).not.toHaveBeenCalled()
    expect(h.preview).not.toHaveBeenCalled()
  })

  it('refuses ids that are not ids, on both calls', async () => {
    expect((await post({ contact_id: 'nope', replace_delivery_id: JOB, message: 'x' })).status).toBe(400)
    expect((await post({ contact_id: CONTACT, replace_delivery_id: "'; drop table", message: 'x' })).status).toBe(400)
    expect((await get('?contact_id=nope')).status).toBe(400)
    expect((await get('')).status).toBe(400)
    expect(h.start).not.toHaveBeenCalled()
  })

  it('does not run without a login id to write as the sender', async () => {
    h.user = null
    const res = await post({ contact_id: CONTACT, replace_delivery_id: JOB, message: 'x' })
    expect(res.status).toBe(401)
    expect(h.start).not.toHaveBeenCalled()
  })

  it('answers 409 with the plain sentence when nothing was changed', async () => {
    h.start.mockResolvedValue({ success: false, error: 'The company has 1 unpaid invoice. Settle or cancel it first.', newDeliveryId: null, resumed: false, finished: false, steps: [], problems: [] })
    const res = await post({ contact_id: CONTACT, replace_delivery_id: JOB, message: 'x' })
    expect(res.status).toBe(409)
    expect((await res.json()).error).toContain('unpaid invoice')
  })

  it('hands the result back, with who pressed and the message exactly as sent', async () => {
    h.start.mockResolvedValue({ success: true, newDeliveryId: 'n1', resumed: false, finished: true, steps: [], problems: [] })
    const res = await post({ contact_id: CONTACT, replace_delivery_id: JOB, message: 'Ciao, nuova società' })
    expect(res.status).toBe(200)
    expect((await res.json()).finished).toBe(true)
    expect(h.start).toHaveBeenCalledWith({ contactId: CONTACT, replaceDeliveryId: JOB, message: 'Ciao, nuova società', actorLabel: 'staff@example.com', actorUserId: 'staff-1' })
  })

  it('answers 500 with a plain sentence when the run throws', async () => {
    h.start.mockRejectedValue(new Error('boom'))
    const res = await post({ contact_id: CONTACT, replace_delivery_id: JOB, message: 'x' })
    expect(res.status).toBe(500)
    expect((await res.json()).error).toContain('Check the formation page before pressing again')
  })

  it('passes the formation workspace\'s own job to the preview, and refuses a job id that is not an id', async () => {
    h.preview.mockResolvedValue({ contact: null, candidates: [] })
    expect((await get(`?contact_id=${CONTACT}&delivery_id=${JOB}`)).status).toBe(200)
    expect(h.preview).toHaveBeenLastCalledWith(CONTACT, JOB)
    expect((await get(`?contact_id=${CONTACT}`)).status).toBe(200)
    expect(h.preview).toHaveBeenLastCalledWith(CONTACT, undefined)
    h.preview.mockClear()
    expect((await get(`?contact_id=${CONTACT}&delivery_id=nope`)).status).toBe(400)
    expect((await get(`?contact_id=${CONTACT}&delivery_id=`)).status).toBe(400)
    expect(h.preview).not.toHaveBeenCalled()
  })

  it('answers the preview, and 500 when it cannot be read', async () => {
    h.preview.mockResolvedValue({ contact: null, candidates: [] })
    expect((await get(`?contact_id=${CONTACT}`)).status).toBe(200)
    h.preview.mockRejectedValue(new Error('could not read the person'))
    expect((await get(`?contact_id=${CONTACT}`)).status).toBe(500)
  })
})
