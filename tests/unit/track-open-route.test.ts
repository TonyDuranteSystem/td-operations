/**
 * POST /api/offers/track-open — a never-sent DRAFT records nothing (dev job b834e4ae).
 *
 * Reproduced on the sandbox with the production host split: the Create Offer dialog opened the
 * bare `<offer_url>?preview=td` link on the client host, which carries no staff proof, so this
 * route counted it as the client opening the offer and flipped draft -> 'viewed'. The Send button
 * renders only for drafts and publishOffer refuses anything else, so staff had to delete and
 * recreate the offer. The guard lives here, at the single place that writes the view.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

type Access =
  | { error: string; status: number }
  | { error: null; status: 200; kind: 'offer'; staffPreview: boolean; offer: { id: string; token: string; status: string; view_count: number } }
  | { error: null; status: 200; kind: 'renewal' }

let access: Access
let updates: Array<{ payload: Record<string, unknown>; eq: Array<[string, unknown]>; in: Array<[string, unknown[]]> }> = []
let firstUpdateError: { message: string } | null = null

vi.mock('@/lib/offers/public-offer-request', () => ({
  readOfferRequest: vi.fn().mockResolvedValue({ token: 't', code: 'c', body: {} }),
}))
vi.mock('@/lib/offers/public-offer-access', () => ({
  resolvePublicOfferAccess: vi.fn(async () => access),
}))
vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: {
    from: () => ({
      update: (payload: Record<string, unknown>) => {
        const call = { payload, eq: [] as Array<[string, unknown]>, in: [] as Array<[string, unknown[]]> }
        updates.push(call)
        const isFirst = updates.length === 1
        const result = { error: isFirst ? firstUpdateError : null }
        const chain: Record<string, unknown> = {}
        chain.eq = (col: string, val: unknown) => { call.eq.push([col, val]); return chain }
        chain.in = (col: string, vals: unknown[]) => { call.in.push([col, vals]); return Promise.resolve(result) }
        chain.then = (resolve: (v: unknown) => unknown) => resolve(result)
        return chain
      },
    }),
  },
}))

import { POST } from '@/app/api/offers/track-open/route'
import type { NextRequest } from 'next/server'

const req = {} as NextRequest
const offerAccess = (over: Partial<{ status: string; view_count: number; staffPreview: boolean }> = {}): Access => ({
  error: null,
  status: 200,
  kind: 'offer',
  staffPreview: over.staffPreview ?? false,
  offer: { id: 'o1', token: 't', status: over.status ?? 'sent', view_count: over.view_count ?? 0 },
})

beforeEach(() => {
  updates = []
  firstUpdateError = null
})

describe('track-open', () => {
  it('a DRAFT records nothing — no view count, no viewed_at, no status flip', async () => {
    access = offerAccess({ status: 'draft' })
    const res = await POST(req)
    const body = await res.json()
    expect(body).toEqual({ ok: true, skipped: 'draft' })
    expect(updates).toHaveLength(0)
  })

  it('a SENT offer is counted and becomes viewed (the client really opened it)', async () => {
    access = offerAccess({ status: 'sent', view_count: 2 })
    const res = await POST(req)
    expect((await res.json()).ok).toBe(true)
    expect(updates[0].payload).toMatchObject({ view_count: 3 })
    expect(updates[0].payload.viewed_at).toBeTruthy()
    expect(updates[1].payload).toEqual({ status: 'viewed' })
    expect(updates[1].in).toEqual([['status', ['sent', 'published']]])
  })

  it('the status flip never includes draft (it can only move an already-sent offer)', async () => {
    access = offerAccess({ status: 'published' })
    await POST(req)
    const flip = updates.find(u => u.payload.status === 'viewed')!
    expect(flip.in[0][1]).not.toContain('draft')
  })

  it('a signed offer still counts the view and keeps its status', async () => {
    access = offerAccess({ status: 'signed', view_count: 5 })
    await POST(req)
    expect(updates[0].payload).toMatchObject({ view_count: 6 })
    // The conditional flip is attempted but its filter excludes 'signed', so it matches nothing.
    expect(updates[1].in[0][1]).toEqual(['sent', 'published'])
  })

  it('a staff preview is skipped before anything is written', async () => {
    access = offerAccess({ status: 'sent', staffPreview: true })
    const body = await (await POST(req)).json()
    expect(body).toEqual({ ok: true, skipped: 'staff_preview' })
    expect(updates).toHaveLength(0)
  })

  it('an access error is passed through', async () => {
    access = { error: 'Offer not found.', status: 404 }
    const res = await POST(req)
    expect(res.status).toBe(404)
    expect(updates).toHaveLength(0)
  })

  it('a failed view write returns 500 and does not flip the status', async () => {
    access = offerAccess({ status: 'sent' })
    firstUpdateError = { message: 'boom' }
    const res = await POST(req)
    expect(res.status).toBe(500)
    expect(updates).toHaveLength(1)
  })
})
