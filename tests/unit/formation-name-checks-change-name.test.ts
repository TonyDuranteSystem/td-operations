/**
 * The names loop for a COMPANY CHANGE NAME (dev job bb64c417, track A): the service-specific rules
 * in lib/flows/name-loop-policy.ts as the engine applies them — no wizard seeding, the first ask,
 * one name at a time, the company's own state (refused when unknown, never New Mexico), no
 * automatic stage revert on a state refusal, a single new name after the names are used up.
 * Formation's behaviour is pinned by the older test files (unchanged).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { NameCheck } from '@/lib/flows/name-checks'

let sdFixture: Record<string, unknown> | null = null
let accountState: string | null = null
let wizardData: Record<string, unknown> | null = null
let pendingAsk = false
let writes: Array<{ checks: NameCheck[] }> = []
let chatInserts: Array<Record<string, unknown>> = []

vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: {
    from: (table: string) => {
      if (table === 'service_deliveries') {
        const chain = {
          select: () => chain,
          eq: () => chain,
          maybeSingle: () => Promise.resolve({ data: sdFixture ? structuredClone(sdFixture) : null, error: null }),
          update: (row: Record<string, unknown>) => {
            writes.push({ checks: structuredClone(row.name_checks as NameCheck[]) })
            const upd = { eq: () => upd, select: () => Promise.resolve({ data: [{ id: 'sd' }], error: null }) }
            return upd
          },
        }
        return chain
      }
      if (table === 'accounts') {
        const c = { select: () => c, eq: () => c, maybeSingle: () => Promise.resolve({ data: accountState ? { state_of_formation: accountState } : null, error: null }) }
        return c
      }
      if (table === 'wizard_progress') {
        const c = { select: () => c, eq: () => c, order: () => c, limit: () => c, maybeSingle: () => Promise.resolve({ data: wizardData ? { data: wizardData } : null, error: null }) }
        return c
      }
      if (table === 'client_decision_requests') {
        const c = {
          select: () => c,
          eq: () => c,
          limit: () => Promise.resolve({ data: pendingAsk ? [{ id: 'dr-open' }] : [], error: null }),
          update: () => ({ eq: () => ({ eq: () => ({ eq: () => ({ eq: () => ({ then: (r: (v: unknown) => void) => Promise.resolve({ data: null, error: null }).then(r) }) }) }) }) }),
        }
        return c
      }
      if (table === 'portal_messages') {
        return { insert: (row: Record<string, unknown>) => { chatInserts.push(row); return Promise.resolve({ data: null, error: null }) } }
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

vi.mock('@/lib/system-errors', () => ({ reportSystemError: vi.fn().mockResolvedValue(null) }))
vi.mock('@/lib/portal/notifications', () => ({ notifyClientOfAdminMessage: () => Promise.resolve() }))

import { handleNameAction, applyNameDecisionResponse, getNameLoopPolicyForSd, getOrInitNameChecks } from '@/lib/operations/formation-name-checks'

const SD_ID = 'sd-change-name'
const nc = (name: string, status: NameCheck['status'], extra: Partial<NameCheck> = {}): NameCheck => ({ name, source: 'client_resubmit', status, updated_at: null, ...extra })

function changeNameSd(name_checks: NameCheck[], extra: Record<string, unknown> = {}) {
  return {
    id: SD_ID,
    contact_id: 'contact-1',
    account_id: 'acct-1',
    name_checks,
    service_type: 'Company Change Name',
    due_date: null,
    stage_entered_at: null,
    created_at: '2026-10-19T00:00:00Z',
    stage: 'Collect three company names',
    updated_at: 'v1',
    status: 'active',
    ...extra,
  }
}

beforeEach(() => {
  sdFixture = null
  accountState = 'Florida'
  wizardData = null
  pendingAsk = false
  writes = []
  chatInserts = []
  createDecisionRequestMock.mockReset()
  createDecisionRequestMock.mockResolvedValue({ ok: true, id: 'decision-req-1' })
  advanceServiceDeliveryMock.mockClear()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('seeding', () => {
  it('a name change is NOT seeded from the contact\'s old formation wizard', async () => {
    wizardData = { llc_name_1: 'Old Formation Name LLC', llc_name_2: 'Another Old LLC' }
    sdFixture = changeNameSd([])
    expect(await getOrInitNameChecks(SD_ID)).toEqual([])
    expect(writes).toHaveLength(0)
  })

  it('Company Formation still seeds from the wizard (unchanged)', async () => {
    wizardData = { llc_name_1: 'Formation Name LLC' }
    sdFixture = changeNameSd([], { service_type: 'Company Formation' })
    const list = await getOrInitNameChecks(SD_ID)
    expect(list.map((c) => c.name)).toEqual(['Formation Name LLC'])
  })
})

describe('a service with no names loop', () => {
  it('is refused by the engine and has no policy', async () => {
    sdFixture = changeNameSd([nc('A LLC', 'pending')], { service_type: 'ITIN' })
    const result = await handleNameAction({ sdId: SD_ID, action: 'mark_available', nameIndex: 0, actor: 'Luca' })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/not available for this service/i)
    expect(await getNameLoopPolicyForSd(SD_ID)).toBeNull()
    expect(writes).toHaveLength(0)
  })

  it('a name change and a formation each have one', async () => {
    sdFixture = changeNameSd([])
    expect((await getNameLoopPolicyForSd(SD_ID))?.key).toBe('change_name')
    sdFixture = changeNameSd([], { service_type: 'Company Formation' })
    expect((await getNameLoopPolicyForSd(SD_ID))?.key).toBe('formation')
  })
})

describe('ask_first_names', () => {
  it('asks the client for up to 3 names, one per line, and only that', async () => {
    sdFixture = changeNameSd([])
    const result = await handleNameAction({ sdId: SD_ID, action: 'ask_first_names', nameIndex: 0, actor: 'Luca' })
    expect(result.ok).toBe(true)
    expect(createDecisionRequestMock).toHaveBeenCalledTimes(1)
    const req = createDecisionRequestMock.mock.calls[0][0]
    expect(req).toMatchObject({ request_type: 'text_input', service_delivery_id: SD_ID })
    expect(req.options.name_check).toEqual({ kind: 'new_names', split: 'lines', max: 3 })
    expect(req.message).toContain('up to 3 names')
  })

  it('refuses when names are already on the list', async () => {
    sdFixture = changeNameSd([nc('A LLC', 'pending')])
    const result = await handleNameAction({ sdId: SD_ID, action: 'ask_first_names', nameIndex: 0, actor: 'Luca' })
    expect(result.ok).toBe(false)
    expect(createDecisionRequestMock).not.toHaveBeenCalled()
  })

  it('refuses a second ask while the first is still open (no duplicate card)', async () => {
    sdFixture = changeNameSd([])
    pendingAsk = true
    const result = await handleNameAction({ sdId: SD_ID, action: 'ask_first_names', nameIndex: 0, actor: 'Luca' })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/already been asked/i)
    expect(createDecisionRequestMock).not.toHaveBeenCalled()
  })

  it('is not an action of Company Formation', async () => {
    sdFixture = changeNameSd([], { service_type: 'Company Formation' })
    const result = await handleNameAction({ sdId: SD_ID, action: 'ask_first_names', nameIndex: 0, actor: 'Luca' })
    expect(result.ok).toBe(false)
    expect(createDecisionRequestMock).not.toHaveBeenCalled()
  })

  it('is refused on a finished case', async () => {
    sdFixture = changeNameSd([], { status: 'completed' })
    const result = await handleNameAction({ sdId: SD_ID, action: 'ask_first_names', nameIndex: 0, actor: 'Luca' })
    expect(result.ok).toBe(false)
    expect(createDecisionRequestMock).not.toHaveBeenCalled()
  })

  it('surfaces a failure to create the card (never swallowed)', async () => {
    sdFixture = changeNameSd([])
    createDecisionRequestMock.mockResolvedValue({ ok: false, error: 'No client contact to send this request to (the service delivery has no contact).' })
    const result = await handleNameAction({ sdId: SD_ID, action: 'ask_first_names', nameIndex: 0, actor: 'Luca' })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/no client contact/i)
  })
})

describe('send_to_client for a name change', () => {
  it('names the company\'s own state and never says "first choice"', async () => {
    sdFixture = changeNameSd([nc('Second Choice', 'available')])
    const result = await handleNameAction({ sdId: SD_ID, action: 'send_to_client', nameIndex: 0, actor: 'Luca', actorId: 'user-1' })
    expect(result.ok).toBe(true)
    const req = createDecisionRequestMock.mock.calls[0][0]
    expect(req.title).toBe('Second Choice LLC')
    expect(req.message).toContain('available in Florida')
    expect(req.message).not.toMatch(/first choice|New Mexico/i)
    expect(chatInserts[0]?.message).toContain('available in Florida')
  })

  it('normalises a state code on the account ("FL" → Florida)', async () => {
    accountState = 'FL'
    sdFixture = changeNameSd([nc('Acme', 'available')])
    await handleNameAction({ sdId: SD_ID, action: 'send_to_client', nameIndex: 0, actor: 'Luca' })
    expect(createDecisionRequestMock.mock.calls[0][0].message).toContain('available in Florida')
  })

  it('REFUSES (never New Mexico) when the company has no state on record — nothing sent, nothing reserved', async () => {
    accountState = null
    sdFixture = changeNameSd([nc('Acme', 'available')])
    const result = await handleNameAction({ sdId: SD_ID, action: 'send_to_client', nameIndex: 0, actor: 'Luca' })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/no state of formation on record/i)
    expect(createDecisionRequestMock).not.toHaveBeenCalled()
    expect(writes).toHaveLength(0)
  })

  it('a contact-only case (no account) is refused for the same reason', async () => {
    sdFixture = changeNameSd([nc('Acme', 'available')], { account_id: null })
    const result = await handleNameAction({ sdId: SD_ID, action: 'send_to_client', nameIndex: 0, actor: 'Luca' })
    expect(result.ok).toBe(false)
    expect(createDecisionRequestMock).not.toHaveBeenCalled()
  })

  it.each(['sent_to_client', 'accepted', 'filed'] as const)('only ONE name at a time: refused while another name is %s', async (other) => {
    sdFixture = changeNameSd([nc('First LLC', other), nc('Second LLC', 'available')])
    const result = await handleNameAction({ sdId: SD_ID, action: 'send_to_client', nameIndex: 1, actor: 'Luca' })
    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/another name is already with the client/i)
    expect(createDecisionRequestMock).not.toHaveBeenCalled()
    expect(writes).toHaveLength(0)
  })

  it('a dead name does not block the next one', async () => {
    sdFixture = changeNameSd([nc('First LLC', 'not_available'), nc('Second LLC', 'rejected_by_client'), nc('Third LLC', 'available')])
    const result = await handleNameAction({ sdId: SD_ID, action: 'send_to_client', nameIndex: 2, actor: 'Luca' })
    expect(result.ok).toBe(true)
  })

  it('Formation keeps allowing two names with the client (its rule is unchanged)', async () => {
    sdFixture = changeNameSd([nc('First LLC', 'sent_to_client'), nc('Second LLC', 'available')], { service_type: 'Company Formation', account_id: null, contact_id: null })
    const result = await handleNameAction({ sdId: SD_ID, action: 'send_to_client', nameIndex: 1, actor: 'Luca' })
    expect(result.ok).toBe(true)
  })
})

describe('a state refusal', () => {
  it('does NOT move the stage for a name change (staff presses Go back)', async () => {
    sdFixture = changeNameSd([nc('Acme', 'filed'), nc('Other', 'not_available')], { stage: 'Waiting for the state' })
    const result = await handleNameAction({ sdId: SD_ID, action: 'mark_sos_rejected', nameIndex: 0, actor: 'Luca' })
    expect(result.ok).toBe(true)
    expect(advanceServiceDeliveryMock).not.toHaveBeenCalled()
  })

  it('asks the client for ONE new name once every name is used up', async () => {
    sdFixture = changeNameSd([nc('Acme', 'filed'), nc('Other', 'not_available')], { stage: 'Waiting for the state' })
    await handleNameAction({ sdId: SD_ID, action: 'mark_sos_rejected', nameIndex: 0, actor: 'Luca' })
    expect(createDecisionRequestMock).toHaveBeenCalledTimes(1)
    const req = createDecisionRequestMock.mock.calls[0][0]
    expect(req.message).toContain('"Acme" was rejected by the Secretary of State')
    expect(req.message).toMatch(/send us a new name/i)
    expect(req.options.name_check).toEqual({ kind: 'new_names', split: 'lines', max: 1 })
  })

  it('Formation still reverts the stage (unchanged)', async () => {
    sdFixture = changeNameSd([nc('Acme', 'filed')], { service_type: 'Company Formation', stage: 'Filed with State', account_id: null, contact_id: null })
    await handleNameAction({ sdId: SD_ID, action: 'mark_sos_rejected', nameIndex: 0, actor: 'Luca' })
    expect(advanceServiceDeliveryMock).toHaveBeenCalledTimes(1)
    expect(advanceServiceDeliveryMock.mock.calls[0][0]).toMatchObject({ target_stage: 'Wizard Submitted' })
  })
})

describe('add_name', () => {
  it('works at any stage of a name change (the layout decides where the panel shows)', async () => {
    sdFixture = changeNameSd([], { stage: 'Check names and client confirms' })
    const result = await handleNameAction({ sdId: SD_ID, action: 'add_name', nameIndex: 0, name: 'Typed By Staff', actor: 'Luca' })
    expect(result.ok).toBe(true)
    expect(writes[0].checks[0]).toMatchObject({ name: 'Typed By Staff', source: 'staff_added', status: 'pending' })
  })
})

describe('the client\'s answer to a name-change ask', () => {
  const askReq = (marker: Record<string, unknown>) =>
    ({ id: 'dr-n', service_delivery_id: SD_ID, account_id: 'acct-1', contact_id: 'contact-1', options: { name_check: marker } }) as never

  it('the first ask keeps "Acme Holdings, LLC" as ONE name and caps at 3', async () => {
    sdFixture = changeNameSd([])
    await applyNameDecisionResponse(askReq({ kind: 'new_names', split: 'lines', max: 3 }), 'responded', {
      text: 'Acme Holdings, LLC\nBeta Trading LLC\nGamma Works LLC\nDelta Extra LLC',
    })
    expect(writes[0].checks.map((c) => c.name)).toEqual(['Acme Holdings, LLC', 'Beta Trading LLC', 'Gamma Works LLC'])
  })

  it('the single new name after a refusal adds just one', async () => {
    sdFixture = changeNameSd([nc('Old LLC', 'rejected_by_sos')])
    await applyNameDecisionResponse(askReq({ kind: 'new_names', split: 'lines', max: 1 }), 'responded', { text: 'Fresh Name LLC\nIgnored Second LLC' })
    expect(writes[0].checks.map((c) => c.name)).toEqual(['Old LLC', 'Fresh Name LLC'])
  })

  it('does not accept a name the state already refused', async () => {
    sdFixture = changeNameSd([nc('Old LLC', 'rejected_by_sos')])
    await applyNameDecisionResponse(askReq({ kind: 'new_names', split: 'lines', max: 1 }), 'responded', { text: 'old llc' })
    expect(writes[0].checks.map((c) => c.name)).toEqual(['Old LLC'])
  })
})
