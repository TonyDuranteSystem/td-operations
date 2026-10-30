/**
 * lib/operations/formation-name-checks.ts — the shared names-loop fixes made for the
 * Company Change Name project (track A0). Formation keeps working exactly as before
 * (formation-name-checks-stale-request.test.ts is unchanged and still green); this file
 * pins what is new:
 *   - an action must fit the name's current status (no sending an unchecked name, no
 *     re-marking a state-refused name "filed");
 *   - send_to_client reserves the name FIRST with the guarded save, then creates the
 *     client's card, and undoes the reservation when the card cannot be created;
 *   - withdraw takes a name back and cancels its open approval card;
 *   - a finished case is never messaged / reopened from here;
 *   - the version stamp comes from the same read as the list;
 *   - a client's "new names" answer never brings back a name already tried, and a
 *     "lines" ask keeps a comma inside a name.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { NameCheck } from '@/lib/flows/name-checks'

let sdFixture: Record<string, unknown> | null = null
const order: string[] = []
interface WriteRec { checks: NameCheck[]; eqs: unknown[][] }
let writes: WriteRec[] = []
let conflictOnWrite = new Set<number>()
interface CancelRec { eqs: unknown[][] }
let cancels: CancelRec[] = []

vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: {
    from: (table: string) => {
      if (table === 'service_deliveries') {
        const chain = {
          select: () => chain,
          eq: () => chain,
          maybeSingle: () => Promise.resolve({ data: sdFixture ? structuredClone(sdFixture) : null, error: null }),
          update: (row: Record<string, unknown>) => {
            const rec: WriteRec = { checks: structuredClone(row.name_checks as NameCheck[]), eqs: [] }
            writes.push(rec)
            order.push('write')
            const n = writes.length
            const upd = {
              eq: (...a: unknown[]) => {
                rec.eqs.push(a)
                return upd
              },
              select: () => Promise.resolve({ data: conflictOnWrite.has(n) ? [] : [{ id: 'sd' }], error: null }),
            }
            return upd
          },
        }
        return chain
      }
      if (table === 'client_decision_requests') {
        return {
          update: () => {
            const rec: CancelRec = { eqs: [] }
            cancels.push(rec)
            order.push('cancel')
            const c = {
              eq: (...a: unknown[]) => {
                rec.eqs.push(a)
                return c
              },
              then: (resolve: (v: { data: null; error: null }) => void, reject?: (e: unknown) => void) =>
                Promise.resolve({ data: null, error: null }).then(resolve, reject),
            }
            return c
          },
        }
      }
      const fallback = {
        select: () => fallback,
        eq: () => fallback,
        in: () => fallback,
        order: () => fallback,
        limit: () => fallback,
        insert: () => Promise.resolve({ data: null, error: null }),
        maybeSingle: () => Promise.resolve({ data: null, error: null }),
      }
      return fallback
    },
  },
}))

const createDecisionRequestMock = vi.fn()
vi.mock('@/lib/operations/decision-request', () => ({
  createDecisionRequest: (...args: unknown[]) => {
    order.push('create')
    return createDecisionRequestMock(...args)
  },
}))

const advanceServiceDeliveryMock = vi.fn().mockResolvedValue({ success: true })
vi.mock('@/lib/service-delivery', () => ({
  advanceServiceDelivery: (...args: unknown[]) => advanceServiceDeliveryMock(...args),
}))

const reportSystemErrorMock = vi.fn().mockResolvedValue(null)
vi.mock('@/lib/system-errors', () => ({
  reportSystemError: (...args: unknown[]) => reportSystemErrorMock(...args),
}))

vi.mock('@/lib/portal/notifications', () => ({
  notifyClientOfAdminMessage: () => Promise.resolve(),
}))

import { handleNameAction, applyNameDecisionResponse } from '@/lib/operations/formation-name-checks'

const SD_ID = 'sd-a0'

function baseSd(name_checks: NameCheck[], stage = 'Wizard Submitted', extra: Record<string, unknown> = {}) {
  return {
    id: SD_ID,
    contact_id: null,
    account_id: null,
    name_checks,
    service_type: 'Company Formation',
    due_date: null,
    stage_entered_at: null,
    created_at: '2026-10-19T00:00:00Z',
    stage,
    updated_at: 'v1',
    ...extra,
  }
}
const nc = (name: string, status: NameCheck['status'], extra: Partial<NameCheck> = {}): NameCheck => ({ name, source: 'wizard', status, updated_at: null, ...extra })

beforeEach(() => {
  sdFixture = null
  order.length = 0
  writes = []
  conflictOnWrite = new Set()
  cancels = []
  reportSystemErrorMock.mockClear()
  createDecisionRequestMock.mockReset()
  createDecisionRequestMock.mockResolvedValue({ ok: true, id: 'decision-req-1' })
  advanceServiceDeliveryMock.mockClear()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('an action must fit the name status', () => {
  it.each([
    ['send_to_client', 'pending'],
    ['send_to_client', 'not_available'],
    ['send_to_client', 'rejected_by_sos'],
    ['mark_filed', 'available'],
    ['mark_filed', 'sent_to_client'],
    ['mark_filed', 'rejected_by_sos'],
    ['mark_available', 'filed'],
    ['mark_available', 'accepted'],
    ['mark_not_available', 'accepted'],
    ['mark_not_available', 'filed'],
    ['withdraw', 'available'],
    ['withdraw', 'accepted'],
  ] as const)('%s on a %s name is refused with nothing written or sent', async (action, status) => {
    sdFixture = baseSd([nc('A LLC', status)])
    const result = await handleNameAction({ sdId: SD_ID, action, nameIndex: 0, actor: 'Luca' })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/^Only a name /)
    expect(writes).toHaveLength(0)
    expect(createDecisionRequestMock).not.toHaveBeenCalled()
    expect(cancels).toHaveLength(0)
  })

  it('still allows the transitions the panel offers', async () => {
    sdFixture = baseSd([nc('A LLC', 'pending')])
    expect((await handleNameAction({ sdId: SD_ID, action: 'mark_available', nameIndex: 0, actor: 'Luca' })).ok).toBe(true)
    sdFixture = baseSd([nc('A LLC', 'accepted')])
    expect((await handleNameAction({ sdId: SD_ID, action: 'mark_filed', nameIndex: 0, actor: 'Luca' })).ok).toBe(true)
  })

  it('an unknown action still gets the unknown-action error (not a crash)', async () => {
    sdFixture = baseSd([nc('A LLC', 'pending')])
    const result = await handleNameAction({ sdId: SD_ID, action: 'bogus' as never, nameIndex: 0, actor: 'Luca' })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/unknown action/i)
  })
})

describe('send_to_client reserves the name first', () => {
  it('writes the reservation, THEN creates the client card, THEN links the card to the name', async () => {
    sdFixture = baseSd([nc('Lead Lift LLC', 'available')])
    const result = await handleNameAction({ sdId: SD_ID, action: 'send_to_client', nameIndex: 0, actor: 'Luca' })
    expect(result.ok).toBe(true)
    expect(order.slice(0, 3)).toEqual(['write', 'create', 'write'])
    // reservation: waiting for the client, no card linked yet; guarded by the stamp it read
    expect(writes[0].checks[0].status).toBe('sent_to_client')
    expect(writes[0].checks[0].decision_request_id).toBeUndefined()
    expect(writes[0].eqs).toContainEqual(['updated_at', 'v1'])
    // link: the card id, guarded by the stamp the reservation wrote (not the old one)
    expect(writes[1].checks[0].decision_request_id).toBe('decision-req-1')
    const stampUsed = writes[1].eqs.find((e) => e[0] === 'updated_at')?.[1]
    expect(stampUsed).toBeTruthy()
    expect(stampUsed).not.toBe('v1')
  })

  it('a conflicting save (someone else just acted) sends NOTHING to the client', async () => {
    sdFixture = baseSd([nc('Lead Lift LLC', 'available')])
    conflictOnWrite = new Set([1])
    const result = await handleNameAction({ sdId: SD_ID, action: 'send_to_client', nameIndex: 0, actor: 'Luca' })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/changed while you were working/i)
    expect(createDecisionRequestMock).not.toHaveBeenCalled()
    expect(cancels).toHaveLength(0)
  })

  it('when the card cannot be created the reservation is undone (name back to available)', async () => {
    createDecisionRequestMock.mockResolvedValue({ ok: false, error: 'boom' })
    sdFixture = baseSd([nc('Lead Lift LLC', 'available')])
    const result = await handleNameAction({ sdId: SD_ID, action: 'send_to_client', nameIndex: 0, actor: 'Luca' })
    expect(result.ok).toBe(false)
    expect(result.error).toBe('boom')
    expect(writes).toHaveLength(2)
    expect(writes[0].checks[0].status).toBe('sent_to_client')
    expect(writes[1].checks[0].status).toBe('available')
    expect(cancels).toHaveLength(0)
    expect(reportSystemErrorMock).not.toHaveBeenCalled()
  })

  it('reports to the error dashboard when the reservation cannot be undone either', async () => {
    createDecisionRequestMock.mockResolvedValue({ ok: false, error: 'boom' })
    conflictOnWrite = new Set([2])
    vi.spyOn(console, 'error').mockImplementation(() => {})
    sdFixture = baseSd([nc('Lead Lift LLC', 'available')])
    const result = await handleNameAction({ sdId: SD_ID, action: 'send_to_client', nameIndex: 0, actor: 'Luca' })
    expect(result.ok).toBe(false)
    expect(reportSystemErrorMock).toHaveBeenCalledTimes(1)
  })
})

describe('withdraw', () => {
  it('puts the name back to available, clears the card link and cancels the open approval request', async () => {
    sdFixture = baseSd([nc('A LLC', 'sent_to_client', { decision_request_id: 'dr-9' })])
    const result = await handleNameAction({ sdId: SD_ID, action: 'withdraw', nameIndex: 0, actor: 'Luca' })
    expect(result.ok).toBe(true)
    expect(writes).toHaveLength(1)
    expect(writes[0].checks[0].status).toBe('available')
    expect(writes[0].checks[0].decision_request_id).toBeNull()
    expect(cancels).toHaveLength(1)
    expect(cancels[0].eqs).toContainEqual(['id', 'dr-9'])
    expect(cancels[0].eqs).toContainEqual(['status', 'pending'])
    // status first, THEN the retraction
    expect(order).toEqual(['write', 'cancel'])
  })

  it('does not touch the client card when the save conflicts', async () => {
    sdFixture = baseSd([nc('A LLC', 'sent_to_client', { decision_request_id: 'dr-9' })])
    conflictOnWrite = new Set([1])
    const result = await handleNameAction({ sdId: SD_ID, action: 'withdraw', nameIndex: 0, actor: 'Luca' })
    expect(result.ok).toBe(false)
    expect(cancels).toHaveLength(0)
  })

  it('a name without a linked card (link failed) is still withdrawn', async () => {
    sdFixture = baseSd([nc('A LLC', 'sent_to_client')])
    const result = await handleNameAction({ sdId: SD_ID, action: 'withdraw', nameIndex: 0, actor: 'Luca' })
    expect(result.ok).toBe(true)
    expect(cancels).toHaveLength(0)
  })

  it('a late answer to a withdrawn name is ignored', async () => {
    sdFixture = baseSd([nc('A LLC', 'available')])
    await applyNameDecisionResponse(
      { id: 'dr-9', service_delivery_id: SD_ID, account_id: null, contact_id: null, options: { name_check: { kind: 'approval', name_index: 0 } } } as never,
      'approved',
      {},
    )
    expect(writes).toHaveLength(0)
  })
})

describe('reinstate', () => {
  it('sends a client-rejected name back to the client with a fresh card and clears the old note', async () => {
    sdFixture = baseSd([nc('AC Digital LLC', 'rejected_by_client', { note: 'no thanks', decision_request_id: 'dr-old' })])
    const result = await handleNameAction({ sdId: SD_ID, action: 'reinstate', nameIndex: 0, actor: 'Luca' })
    expect(result.ok).toBe(true)
    expect(createDecisionRequestMock).toHaveBeenCalledTimes(1)
    const last = writes[writes.length - 1].checks[0]
    expect(last.status).toBe('sent_to_client')
    expect(last.note).toBeNull()
    expect(last.decision_request_id).toBe('decision-req-1')
    // reserve first, then the card
    expect(order.indexOf('write')).toBeLessThan(order.indexOf('create'))
  })

  it('puts the rejection back if the client card cannot be created', async () => {
    createDecisionRequestMock.mockResolvedValue({ ok: false, error: 'boom' })
    sdFixture = baseSd([nc('AC Digital LLC', 'rejected_by_client', { note: 'no thanks' })])
    const result = await handleNameAction({ sdId: SD_ID, action: 'reinstate', nameIndex: 0, actor: 'Luca' })
    expect(result.ok).toBe(false)
    const last = writes[writes.length - 1].checks[0]
    expect(last.status).toBe('rejected_by_client')
    expect(last.note).toBe('no thanks')
  })

  it.each(['rejected_by_sos', 'filed', 'not_available', 'accepted'] as const)('is refused on a %s name', async (status) => {
    sdFixture = baseSd([nc('A LLC', status)])
    const result = await handleNameAction({ sdId: SD_ID, action: 'reinstate', nameIndex: 0, actor: 'Luca' })
    expect(result.ok).toBe(false)
    expect(writes).toHaveLength(0)
    expect(createDecisionRequestMock).not.toHaveBeenCalled()
  })

  it('is refused on a finished case', async () => {
    sdFixture = baseSd([nc('A LLC', 'rejected_by_client')], 'Company Created', { status: 'completed' })
    const result = await handleNameAction({ sdId: SD_ID, action: 'reinstate', nameIndex: 0, actor: 'Luca' })
    expect(result.ok).toBe(false)
    expect(createDecisionRequestMock).not.toHaveBeenCalled()
  })
})

describe('a finished case is not messaged or reopened from here', () => {
  it('send_to_client is refused on a completed case', async () => {
    sdFixture = baseSd([nc('A LLC', 'available')], 'Company Created', { status: 'completed' })
    const result = await handleNameAction({ sdId: SD_ID, action: 'send_to_client', nameIndex: 0, actor: 'Luca' })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/already finished/i)
    expect(writes).toHaveLength(0)
    expect(createDecisionRequestMock).not.toHaveBeenCalled()
  })

  it('mark_sos_rejected is refused on a cancelled case and never calls the stage revert', async () => {
    sdFixture = baseSd([nc('A LLC', 'filed')], 'Filed with State', { status: 'cancelled' })
    const result = await handleNameAction({ sdId: SD_ID, action: 'mark_sos_rejected', nameIndex: 0, actor: 'Luca' })
    expect(result.ok).toBe(false)
    expect(writes).toHaveLength(0)
    expect(advanceServiceDeliveryMock).not.toHaveBeenCalled()
  })

  it('request_new_names is refused on a completed case', async () => {
    sdFixture = baseSd([nc('A LLC', 'not_available')], 'Company Created', { status: 'completed' })
    const result = await handleNameAction({ sdId: SD_ID, action: 'request_new_names', nameIndex: 0, actor: 'Luca' })
    expect(result.ok).toBe(false)
    expect(createDecisionRequestMock).not.toHaveBeenCalled()
  })

  it('an active case (or one with no status column value) behaves exactly as before', async () => {
    sdFixture = baseSd([nc('A LLC', 'available')], 'Wizard Submitted', { status: 'active' })
    expect((await handleNameAction({ sdId: SD_ID, action: 'send_to_client', nameIndex: 0, actor: 'Luca' })).ok).toBe(true)
  })
})

describe('the version stamp comes from the same read as the list', () => {
  it('guards the save with the stamp of the row it read', async () => {
    sdFixture = baseSd([nc('A LLC', 'pending')])
    await handleNameAction({ sdId: SD_ID, action: 'mark_available', nameIndex: 0, actor: 'Luca' })
    expect(writes).toHaveLength(1)
    expect(writes[0].eqs).toContainEqual(['updated_at', 'v1'])
  })
})

describe('a client "new names" answer', () => {
  const askReq = (marker: Record<string, unknown> = { kind: 'new_names' }) =>
    ({ id: 'dr-n', service_delivery_id: SD_ID, account_id: null, contact_id: null, options: { name_check: marker } }) as never

  it('does not bring back a name already tried, dead names included', async () => {
    sdFixture = baseSd([nc('Acme Holdings LLC', 'rejected_by_sos'), nc('Beta LLC', 'not_available')])
    await applyNameDecisionResponse(askReq(), 'responded', { text: 'ACME HOLDINGS\nBeta, LLC\nGamma Trading LLC' })
    expect(writes).toHaveLength(1)
    expect(writes[0].checks.map((c) => c.name)).toEqual(['Acme Holdings LLC', 'Beta LLC', 'Gamma Trading LLC'])
    expect(writes[0].checks[2]).toMatchObject({ source: 'client_resubmit', status: 'pending' })
  })

  it('by default still splits on commas (Formation behaviour unchanged)', async () => {
    sdFixture = baseSd([nc('Old LLC', 'not_available')])
    await applyNameDecisionResponse(askReq(), 'responded', { text: 'One Name LLC, Two Name LLC' })
    expect(writes[0].checks.map((c) => c.name)).toEqual(['Old LLC', 'One Name LLC', 'Two Name LLC'])
  })

  it('a "lines" ask keeps the comma inside a name', async () => {
    sdFixture = baseSd([nc('Old LLC', 'not_available')])
    await applyNameDecisionResponse(askReq({ kind: 'new_names', split: 'lines' }), 'responded', { text: 'Zeta Trading, LLC' })
    expect(writes[0].checks.map((c) => c.name)).toEqual(['Old LLC', 'Zeta Trading, LLC'])
  })

  it('keeps only `max` names when the ask says so', async () => {
    sdFixture = baseSd([nc('Old LLC', 'not_available')])
    await applyNameDecisionResponse(askReq({ kind: 'new_names', split: 'lines', max: 1 }), 'responded', { text: 'First New LLC\nSecond New LLC' })
    expect(writes[0].checks.map((c) => c.name)).toEqual(['Old LLC', 'First New LLC'])
  })
})
