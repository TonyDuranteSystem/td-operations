import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createHmac } from 'node:crypto'

// A tiny fake of the parts of the database client the route touches.
const state: { rows: Array<{ id: string; gmail_message_id: string; delivery_status: string | null }>; updates: Array<Record<string, unknown>>; events: number } = { rows: [], updates: [], events: 0 }
vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: {
    from: (table: string) => {
      if (table === 'webhook_events') return { insert: () => { state.events++; return Promise.resolve({ error: null }) } }
      return {
        select: () => ({ eq: (_c: string, v: string) => ({ maybeSingle: () => Promise.resolve({ data: state.rows.find(r => r.gmail_message_id === v) ?? null, error: null }) }) }),
        update: (u: Record<string, unknown>) => ({ eq: () => { state.updates.push(u); return Promise.resolve({ error: null }) } }),
      }
    },
  },
}))

import { POST } from '@/app/api/webhooks/resend/route'

const keyBytes = Buffer.from('route-test-secret')
const secret = `whsec_${keyBytes.toString('base64')}`
function request(body: unknown, opts: { sign?: boolean; ts?: number } = {}) {
  const payload = JSON.stringify(body)
  const id = 'msg_test'
  const ts = String(opts.ts ?? Math.floor(Date.now() / 1000))
  const sig = opts.sign === false ? 'v1,AAAA' : `v1,${createHmac('sha256', keyBytes).update(`${id}.${ts}.${payload}`).digest('base64')}`
  return new Request('http://localhost/api/webhooks/resend', { method: 'POST', body: payload, headers: { 'svix-id': id, 'svix-timestamp': ts, 'svix-signature': sig } }) as never
}

beforeEach(() => {
  state.rows = [{ id: 'row1', gmail_message_id: 'em_1', delivery_status: null }]
  state.updates = []
  state.events = 0
  process.env.RESEND_WEBHOOK_SECRET = secret
})

describe('POST /api/webhooks/resend', () => {
  it('says 503 while the secret is not configured', async () => {
    delete process.env.RESEND_WEBHOOK_SECRET
    expect((await POST(request({ type: 'email.bounced', data: { email_id: 'em_1' } }))).status).toBe(503)
  })
  it('rejects an unsigned or wrongly signed request and changes nothing', async () => {
    const res = await POST(request({ type: 'email.bounced', data: { email_id: 'em_1' } }, { sign: false }))
    expect(res.status).toBe(401)
    expect(state.updates).toHaveLength(0)
  })
  it('rejects a replayed old request', async () => {
    const res = await POST(request({ type: 'email.bounced', data: { email_id: 'em_1' } }, { ts: Math.floor(Date.now() / 1000) - 3600 }))
    expect(res.status).toBe(401)
  })
  it('records a block on the matching email', async () => {
    const res = await POST(request({ type: 'email.suppressed', data: { email_id: 'em_1' } }))
    expect(res.status).toBe(200)
    expect(state.updates).toHaveLength(1)
    expect(state.updates[0]).toMatchObject({ delivery_status: 'not_delivered', delivery_detail: 'suppressed' })
    expect(state.events).toBe(1)
  })
  it('does not let a later "delivered" erase a failure', async () => {
    state.rows[0].delivery_status = 'not_delivered'
    const res = await POST(request({ type: 'email.delivered', data: { email_id: 'em_1' } }))
    expect(res.status).toBe(200)
    expect(state.updates).toHaveLength(0)
  })
  it('ignores an email we do not track and events that say nothing about delivery', async () => {
    expect((await POST(request({ type: 'email.bounced', data: { email_id: 'someone_else' } }))).status).toBe(200)
    expect((await POST(request({ type: 'email.opened', data: { email_id: 'em_1' } }))).status).toBe(200)
    expect(state.updates).toHaveLength(0)
  })
})
