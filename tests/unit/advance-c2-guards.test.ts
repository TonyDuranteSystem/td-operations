import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * N1a C2 — the two refusals in the ONE shared move (advanceServiceDelivery):
 *   §4g a finished or cancelled job does not move FORWARD (DBA has "Renewal Due" after its done step "Registered";
 *       moving on used to reopen the job silently). Going back stays allowed.
 *   §4f a forward move that leaves or jumps over a "needs a document" step is refused in plain words unless a document
 *       was uploaded on that step; test jobs / test companies are exempt (same as the database rule).
 */

vi.mock('@/lib/supabase-admin', () => ({ supabaseAdmin: { from: vi.fn() } }))
vi.mock('@/lib/db', () => ({
  dbWrite: vi.fn(async (p: PromiseLike<{ data: unknown }>) => (await p).data),
  dbWriteSafe: vi.fn(async (p: PromiseLike<{ data: unknown; error: unknown }>) => await p),
}))
vi.mock('@/lib/mcp/action-log', () => ({ logAction: vi.fn() }))
vi.mock('@/lib/operations/formation-materialize', () => ({
  preflightFormationMaterialization: vi.fn(async () => ({ ok: true })),
  materializeFormationCompany: vi.fn(),
}))

import { advanceServiceDelivery } from '@/lib/service-delivery'
import { supabaseAdmin } from '@/lib/supabase-admin'

let delivery: Record<string, unknown>
let docs: Array<{ flow_stage: string }> = []
let account: Record<string, unknown> | null = null

const DBA = [
  { stage_name: 'Notarization', stage_order: 4 },
  { stage_name: 'Money Order', stage_order: 5, requires_document_to_advance: true },
  { stage_name: 'Mailed to State', stage_order: 6 },
  { stage_name: 'Registered', stage_order: 7, completes_service: true },
  { stage_name: 'Renewal Due', stage_order: 8 },
].map(s => ({ requires_approval: false, sla_days: null, auto_tasks: null, completes_service: false, ...s }))

function installFrom() {
  const writes: Array<{ table: string; row: unknown }> = []
  vi.mocked(supabaseAdmin.from).mockImplementation(((table: string) => {
    const result = table === 'service_deliveries' ? delivery : table === 'accounts' ? account : null
    const list = table === 'pipeline_stages' ? DBA : table === 'documents' ? docs : []
    const chain: Record<string, unknown> = {}
    const self = () => chain
    for (const m of ['select', 'eq', 'neq', 'in', 'is', 'or', 'ilike', 'order', 'limit', 'contains']) chain[m] = self
    chain.single = () => Promise.resolve({ data: result, error: null })
    chain.maybeSingle = () => Promise.resolve({ data: result, error: null })
    chain.update = (row: unknown) => {
      writes.push({ table, row })
      return chain
    }
    chain.insert = (row: unknown) => {
      writes.push({ table, row })
      return chain
    }
    chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve({ data: list, error: null }).then(resolve)
    return chain
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any)
  return writes
}

function dbaAt(stage: string, order: number, extra: Record<string, unknown> = {}) {
  delivery = {
    id: 'sd-1', service_type: 'DBA', service_name: 'DBA', stage, stage_order: order, stage_history: [],
    status: 'active', account_id: 'acct-1', contact_id: null, is_test: false, ...extra,
  }
}

const sdUpdates = (w: Array<{ table: string }>) => w.filter(x => x.table === 'service_deliveries')

beforeEach(() => {
  vi.clearAllMocks()
  docs = []
  account = { is_test: false }
})

describe('§4g — a finished job does not move forward', () => {
  it('refuses Registered (completed) -> Renewal Due, and writes nothing', async () => {
    dbaAt('Registered', 7, { status: 'completed' })
    const writes = installFrom()
    const res = await advanceServiceDelivery({ delivery_id: 'sd-1', target_stage: 'Renewal Due' })
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/complete — reopen it/)
    expect(sdUpdates(writes)).toHaveLength(0)
  })

  it('refuses a cancelled job moving forward', async () => {
    dbaAt('Notarization', 4, { status: 'cancelled' })
    installFrom()
    const res = await advanceServiceDelivery({ delivery_id: 'sd-1', target_stage: 'Money Order' })
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/cancelled/)
  })

  it('still allows moving a finished job BACK (reopen)', async () => {
    dbaAt('Registered', 7, { status: 'completed' })
    installFrom()
    const res = await advanceServiceDelivery({ delivery_id: 'sd-1', target_stage: 'Mailed to State' }).catch(() => null)
    expect(res?.error ?? '').not.toMatch(/reopen it/)
  })
})

describe('§4f — needs a document', () => {
  it('refuses leaving Money Order without its document, in plain words, and writes nothing', async () => {
    dbaAt('Money Order', 5)
    const writes = installFrom()
    const res = await advanceServiceDelivery({ delivery_id: 'sd-1', target_stage: 'Mailed to State' })
    expect(res.success).toBe(false)
    expect(res.error).toBe('A document must be uploaded on "Money Order" before this job can move on.')
    expect(sdUpdates(writes)).toHaveLength(0)
  })

  it('refuses JUMPING over Money Order too', async () => {
    dbaAt('Notarization', 4)
    installFrom()
    const res = await advanceServiceDelivery({ delivery_id: 'sd-1', target_stage: 'Registered' })
    expect(res.success).toBe(false)
    expect(res.error).toMatch(/Money Order/)
  })

  it('lets the job move on once the document is there', async () => {
    dbaAt('Money Order', 5)
    docs = [{ flow_stage: 'Money Order' }]
    installFrom()
    const res = await advanceServiceDelivery({ delivery_id: 'sd-1', target_stage: 'Mailed to State' }).catch(() => null)
    expect(res?.error ?? '').not.toMatch(/document must be uploaded/)
  })

  it('moving ONTO Money Order needs nothing yet', async () => {
    dbaAt('Notarization', 4)
    installFrom()
    const res = await advanceServiceDelivery({ delivery_id: 'sd-1', target_stage: 'Money Order' }).catch(() => null)
    expect(res?.error ?? '').not.toMatch(/document must be uploaded/)
  })

  it('test jobs and test companies are exempt, like the database rule', async () => {
    dbaAt('Money Order', 5, { is_test: true })
    installFrom()
    const a = await advanceServiceDelivery({ delivery_id: 'sd-1', target_stage: 'Mailed to State' }).catch(() => null)
    expect(a?.error ?? '').not.toMatch(/document must be uploaded/)

    dbaAt('Money Order', 5)
    account = { is_test: true }
    installFrom()
    const b = await advanceServiceDelivery({ delivery_id: 'sd-1', target_stage: 'Mailed to State' }).catch(() => null)
    expect(b?.error ?? '').not.toMatch(/document must be uploaded/)
  })
})
