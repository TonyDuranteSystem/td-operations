/**
 * lib/operations/formation-name-checks.ts::handleNameAction — coverage for the
 * 2026-09-10 Lead Lift LLC incident (dev job ebdb8e20): a "propose 3 new LLC
 * names" client request was created while a sibling candidate name was still
 * unchecked, and was never cancelled once that sibling turned out to be
 * available and got filed — leaving a stale, contradictory "action required"
 * card on the client's portal for weeks after the company had already been
 * named, filed, and had its SS-4 faxed to the IRS.
 *
 * Two fixes covered here:
 * 1. Both request_new_names and mark_sos_rejected now refuse to create the
 *    client-facing request unless allNamesDead(checks) is true (previously
 *    enforced only by the staff panel's button visibility, never the API).
 * 2. send_to_client now cancels any pending "new names" request in the same
 *    step it creates the replacement approval request.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { NameCheck } from '@/lib/flows/name-checks'

let sdFixture: Record<string, unknown> | null = null
let writtenChecks: unknown = null
let cancelUpdateError: { message: string } | null = null
let cancelUpdateCalls = 0

function makeCancelChain() {
  const chain: PromiseLike<{ data: null; error: typeof cancelUpdateError }> & { eq: () => typeof chain } = {
    eq: () => chain,
    then: (resolve: (v: { data: null; error: typeof cancelUpdateError }) => void, reject?: (e: unknown) => void) => {
      cancelUpdateCalls++
      return Promise.resolve({ data: null, error: cancelUpdateError }).then(resolve, reject)
    },
  }
  return chain
}

vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: {
    from: (table: string) => {
      if (table === 'service_deliveries') {
        const chain = {
          select: () => chain,
          eq: () => chain,
          maybeSingle: () => Promise.resolve({ data: sdFixture, error: null }),
          update: (row: Record<string, unknown>) => {
            writtenChecks = row.name_checks
            return { eq: () => Promise.resolve({ data: null, error: null }) }
          },
        }
        return chain
      }
      if (table === 'client_decision_requests') {
        return { update: () => makeCancelChain() }
      }
      const fallback = {
        select: () => fallback,
        eq: () => fallback,
        in: () => fallback,
        order: () => fallback,
        limit: () => fallback,
        maybeSingle: () => Promise.resolve({ data: null, error: null }),
      }
      return fallback
    },
  },
}))

const createDecisionRequestMock = vi.fn()
vi.mock('@/lib/operations/decision-request', () => ({
  createDecisionRequest: (...args: unknown[]) => createDecisionRequestMock(...args),
}))

const advanceServiceDeliveryMock = vi.fn().mockResolvedValue({ success: true })
vi.mock('@/lib/service-delivery', () => ({
  advanceServiceDelivery: (...args: unknown[]) => advanceServiceDeliveryMock(...args),
}))

import { handleNameAction, cancelPendingNewNamesRequests } from '@/lib/operations/formation-name-checks'

const SD_ID = 'sd-lead-lift'

function baseSd(name_checks: NameCheck[]) {
  return {
    id: SD_ID,
    // null account_id/contact_id short-circuits resolveState() to its
    // 'New Mexico' default with zero extra table reads — irrelevant to what
    // these tests assert.
    contact_id: null,
    account_id: null,
    name_checks,
    service_type: 'Company Formation',
    due_date: null,
    stage_entered_at: null,
    created_at: '2026-08-19T00:00:00Z',
  }
}

beforeEach(() => {
  writtenChecks = null
  cancelUpdateError = null
  cancelUpdateCalls = 0
  createDecisionRequestMock.mockReset()
  createDecisionRequestMock.mockResolvedValue({ ok: true, id: 'decision-req-1' })
  advanceServiceDeliveryMock.mockClear()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('request_new_names guard', () => {
  it('refuses when a candidate has not been checked yet (the exact Lead Lift LLC sequence)', async () => {
    sdFixture = baseSd([
      { name: 'Lead Lift LLC', source: 'wizard', status: 'pending', updated_at: null },
      { name: 'Lead Lift Consulting LLC', source: 'wizard', status: 'not_available', updated_at: null },
      { name: 'Lead Lift International LLC', source: 'wizard', status: 'not_available', updated_at: null },
    ])
    const result = await handleNameAction({ sdId: SD_ID, action: 'request_new_names', nameIndex: 0, actor: 'Luca' })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/not every name/i)
    expect(createDecisionRequestMock).not.toHaveBeenCalled()
  })

  it('refuses on an empty name list (nothing has died yet)', async () => {
    sdFixture = baseSd([])
    const result = await handleNameAction({ sdId: SD_ID, action: 'request_new_names', nameIndex: 0, actor: 'Luca' })
    expect(result.ok).toBe(false)
    expect(createDecisionRequestMock).not.toHaveBeenCalled()
  })

  it('allows it once every candidate is genuinely dead', async () => {
    sdFixture = baseSd([
      { name: 'A LLC', source: 'wizard', status: 'not_available', updated_at: null },
      { name: 'B LLC', source: 'wizard', status: 'rejected_by_client', updated_at: null },
    ])
    const result = await handleNameAction({ sdId: SD_ID, action: 'request_new_names', nameIndex: 0, actor: 'Luca' })
    expect(result.ok).toBe(true)
    expect(createDecisionRequestMock).toHaveBeenCalledTimes(1)
    expect(createDecisionRequestMock.mock.calls[0][0]).toMatchObject({ title: 'New LLC Names Needed', request_type: 'text_input' })
  })
})

describe('send_to_client cancels a stale new-names request atomically', () => {
  it('cancels the pending request in the same step the replacement is created', async () => {
    sdFixture = baseSd([{ name: 'Lead Lift LLC', source: 'wizard', status: 'available', updated_at: null }])
    const result = await handleNameAction({ sdId: SD_ID, action: 'send_to_client', nameIndex: 0, actor: 'Luca' })
    expect(result.ok).toBe(true)
    expect(createDecisionRequestMock).toHaveBeenCalledTimes(1)
    expect(cancelUpdateCalls).toBe(1)
    expect((writtenChecks as NameCheck[])[0].status).toBe('sent_to_client')
  })

  it('does NOT cancel anything if creating the approval request fails', async () => {
    createDecisionRequestMock.mockResolvedValue({ ok: false, error: 'boom' })
    sdFixture = baseSd([{ name: 'Lead Lift LLC', source: 'wizard', status: 'available', updated_at: null }])
    const result = await handleNameAction({ sdId: SD_ID, action: 'send_to_client', nameIndex: 0, actor: 'Luca' })
    expect(result.ok).toBe(false)
    expect(cancelUpdateCalls).toBe(0)
  })
})

describe('mark_sos_rejected guard', () => {
  it('records the rejection and still reactivates the panel, but withholds the client ask while a sibling is unchecked', async () => {
    sdFixture = baseSd([
      { name: 'A LLC', source: 'wizard', status: 'filed', updated_at: null },
      { name: 'B LLC', source: 'wizard', status: 'pending', updated_at: null },
      { name: 'C LLC', source: 'wizard', status: 'not_available', updated_at: null },
    ])
    const result = await handleNameAction({ sdId: SD_ID, action: 'mark_sos_rejected', nameIndex: 0, actor: 'Luca' })
    expect(result.ok).toBe(true)
    expect((writtenChecks as NameCheck[])[0].status).toBe('rejected_by_sos')
    expect(createDecisionRequestMock).not.toHaveBeenCalled()
    // The stage-revert-to-"Wizard Submitted" step is unconditional — staff
    // still needs the panel reactivated to work the untried sibling, even
    // though the client isn't being asked for anything new right now.
    expect(advanceServiceDeliveryMock).toHaveBeenCalledTimes(1)
  })

  it('asks the client for new names once every remaining candidate is genuinely dead', async () => {
    sdFixture = baseSd([
      { name: 'A LLC', source: 'wizard', status: 'filed', updated_at: null },
      { name: 'B LLC', source: 'wizard', status: 'not_available', updated_at: null },
      { name: 'C LLC', source: 'wizard', status: 'not_available', updated_at: null },
    ])
    const result = await handleNameAction({ sdId: SD_ID, action: 'mark_sos_rejected', nameIndex: 0, actor: 'Luca' })
    expect(result.ok).toBe(true)
    expect(createDecisionRequestMock).toHaveBeenCalledTimes(1)
    expect(createDecisionRequestMock.mock.calls[0][0]).toMatchObject({ title: 'New LLC Names Needed' })
    expect(cancelUpdateCalls).toBe(1)
  })
})

describe('cancelPendingNewNamesRequests error handling', () => {
  it('logs instead of throwing when the cancel write fails', async () => {
    cancelUpdateError = { message: 'db down' }
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(cancelPendingNewNamesRequests(SD_ID)).resolves.toBeUndefined()
    expect(spy).toHaveBeenCalledTimes(1)
    expect(spy.mock.calls[0][0]).toMatch(new RegExp(SD_ID))
  })
})
