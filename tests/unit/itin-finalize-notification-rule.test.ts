/**
 * Dev job e3215801 (Antonio 2026-10-28) — when the ITIN approval letter is uploaded in the workspace, the client gets the MESSAGE in the portal chat
 * plus the bell/push; an email only as the "you have an unread message" nudge for a client without push (notifyClientOfAdminMessage skips the email for
 * anyone with push). NOT the immediate-email rail used for "you must act" moments.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const fx = vi.hoisted(() => ({
  sd: { id: 'sd-1', status: 'active', stage: 'ITIN Approved', service_type: 'ITIN', contact_id: 'c-1', account_id: null } as Record<string, unknown> | null,
  language: null as string | null,
  completed: true,
  action: null as Record<string, unknown> | null,
  nudges: [] as Array<Record<string, unknown>>,
  nudgeThrows: false,
}))

vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: {
    from: (table: string) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const b: any = {}
      b.select = () => b
      b.eq = () => b
      b.single = async () => ({ data: table === 'service_deliveries' ? fx.sd : null, error: null })
      b.maybeSingle = async () => ({ data: table === 'contacts' ? { language: fx.language } : null, error: null })
      return b
    },
  },
}))
vi.mock('@/lib/docai', () => ({ ocrRawContent: async () => ({ fullText: 'Your ITIN is 912-70-1234 issued May 12, 2026' }) }))
vi.mock('@/lib/itin/write-itin-fields', () => ({ writeITINFields: async () => ({ itin_renewal_date: '2033-05-12' }) }))
vi.mock('@/lib/operations/service-delivery', () => ({ completeSDInPlace: async () => ({ completed: fx.completed }) }))
vi.mock('@/lib/flows/resolve-flows', () => ({ buildFlowTopic: () => 'ITIN 2026', deriveFlowYear: () => 2026 }))
vi.mock('@/lib/portal/action-required', () => ({
  notifyClientActionRequired: async (p: Record<string, unknown>) => { fx.action = p; return { chat: 'sent', notification: 'sent', email: 'skipped: skipEmail' } },
}))
vi.mock('@/lib/portal/notifications', () => ({
  notifyClientOfAdminMessage: async (p: Record<string, unknown>) => { fx.nudges.push(p); if (fx.nudgeThrows) throw new Error('gmail down') },
}))

import { finalizeItinApproval } from '@/lib/itin/finalize-approval'

const run = () => finalizeItinApproval({ serviceDeliveryId: 'sd-1', contactId: 'c-1', fileName: 'letter.pdf', content: new ArrayBuffer(8), mimeType: 'application/pdf' })

beforeEach(() => {
  fx.sd = { id: 'sd-1', status: 'active', stage: 'ITIN Approved', service_type: 'ITIN', contact_id: 'c-1', account_id: null }
  fx.language = null
  fx.completed = true
  fx.action = null
  fx.nudges = []
  fx.nudgeThrows = false
})

describe('ITIN approval letter — how the client is told', () => {
  it('portal message + bell/push through the dispatcher with ITS OWN email skipped, then the push-aware "unread message" nudge — in English by default', async () => {
    const r = await run()
    expect(r.finalized).toBe(true)
    expect(r.itin_number).toBe('912-70-1234')
    expect(fx.action).toMatchObject({ contact_id: 'c-1', service_delivery_id: 'sd-1', link: '/portal/documents', skipEmail: true, bellType: 'new_document' })   // good news: the bell notice is an ordinary type the client can dismiss
    expect(fx.nudges).toHaveLength(1)
    expect(fx.nudges[0]).toMatchObject({ contact_id: 'c-1', account_id: null, topic: 'ITIN 2026' })
    expect(String(fx.nudges[0].messagePreview)).toContain('the IRS has approved your ITIN application')
    expect(r.notify?.chat).toBe('sent')
    expect(r.notify?.email).toContain('only if the client has no push')
  })

  it('an Italian client gets the Italian preview', async () => {
    fx.language = 'Italian'
    await run()
    expect(String(fx.nudges[0].messagePreview)).toContain('Ottima notizia')
  })

  it('a double upload (the flow was completed a moment ago by another call) notifies NOBODY a second time', async () => {
    fx.completed = false
    const r = await run()
    expect(r.finalized).toBe(false)
    expect(fx.action).toBeNull()
    expect(fx.nudges).toHaveLength(0)
  })

  it('an already-completed flow is not re-processed or re-notified', async () => {
    fx.sd = { ...fx.sd, status: 'completed' }
    const r = await run()
    expect(r.finalized).toBe(false)
    expect(fx.action).toBeNull()
    expect(fx.nudges).toHaveLength(0)
  })

  it('a nudge that fails NEVER undoes the finalize: the ITIN is saved, the case is closed, the message was posted — the warning says what failed', async () => {
    fx.nudgeThrows = true
    const r = await run()
    expect(r.finalized).toBe(true)
    expect(r.notify?.chat).toBe('sent')
    expect(r.notify?.email).toContain('failed')
  })
})
