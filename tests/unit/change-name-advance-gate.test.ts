import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * Company Change Name — what a FORWARD move needs (lib/flows/change-name-gates.ts), enforced in the one
 * shared move (advanceServiceDelivery) so the button, the stepper and the CRM tools agree:
 *   - a confirmed (accepted / filed) name before the signing step, a filed name before "waiting for the state";
 *   - a second press on the stage the job is already at does nothing;
 *   - going back is never refused;
 *   - before the 8-stage catalog exists (the old five stages) the gates are off.
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
import { changeNameAdvanceProblem, NEED_CONFIRMED_NAME, NEED_FILED_NAME } from '@/lib/flows/change-name-gates'
import { CHANGE_NAME_STAGES, CHANGE_NAME_STAGE_ORDER } from '@/lib/flows/change-name-stages'
import type { NameCheck } from '@/lib/flows/name-checks'

const nc = (name: string, status: NameCheck['status']): NameCheck => ({ name, source: 'wizard', status, updated_at: null })
const NEW_CATALOG = CHANGE_NAME_STAGE_ORDER.map((stage_name, i) => ({
  stage_name,
  stage_order: i + 1,
  requires_approval: false,
  sla_days: null,
  auto_tasks: null,
  completes_service: i === 7,
  notify_client_email: false,
  client_notification_message: null,
  client_label: null,
  client_label_it: null,
}))
const OLD_CATALOG = [
  'Collect three company names',
  'Inform Client name available',
  'File the change name form',
  'Ship change name form to teh SoS',
  'Form Change Name received from the SoS',
].map((stage_name, i) => ({ stage_name, stage_order: i + 1, requires_approval: false, sla_days: null, auto_tasks: null, completes_service: i === 4 }))

let delivery: Record<string, unknown>
let catalog: Array<Record<string, unknown>> = NEW_CATALOG

function installFrom() {
  const writes: Array<{ table: string; row: unknown }> = []
  vi.mocked(supabaseAdmin.from).mockImplementation(((table: string) => {
    const result = table === 'service_deliveries' ? delivery : table === 'accounts' ? { is_test: false } : null
    const list = table === 'pipeline_stages' ? catalog : []
    const chain: Record<string, unknown> = {}
    const self = () => chain
    for (const m of ['select', 'eq', 'neq', 'in', 'is', 'or', 'ilike', 'order', 'limit', 'contains']) chain[m] = self
    chain.single = () => Promise.resolve({ data: result, error: null })
    chain.maybeSingle = () => Promise.resolve({ data: result, error: null })
    chain.update = (row: unknown) => { writes.push({ table, row }); return chain }
    chain.insert = (row: unknown) => { writes.push({ table, row }); return chain }
    chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve({ data: list, error: null }).then(resolve)
    return chain
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any)
  return writes
}

function sdAt(stage: string, order: number, name_checks: NameCheck[], extra: Record<string, unknown> = {}) {
  delivery = {
    id: 'sd-cn', service_type: 'Company Change Name', service_name: 'Company Change Name', stage, stage_order: order,
    stage_history: [], status: 'active', account_id: 'acct-1', contact_id: 'c-1', is_test: false, name_checks, ...extra,
  }
}
const sdWrites = (w: Array<{ table: string }>) => w.filter((x) => x.table === 'service_deliveries')

beforeEach(() => {
  vi.clearAllMocks()
  catalog = NEW_CATALOG
})

describe('changeNameAdvanceProblem (pure)', () => {
  const stages = NEW_CATALOG
  const base = { stages, fromOrder: 2 }

  it('refuses the signing step (and anything past it) without a confirmed name', () => {
    expect(changeNameAdvanceProblem({ ...base, checks: [nc('A', 'available')], targetOrder: 3 })).toBe(NEED_CONFIRMED_NAME)
    expect(changeNameAdvanceProblem({ ...base, checks: [], targetOrder: 3 })).toBe(NEED_CONFIRMED_NAME)
    expect(changeNameAdvanceProblem({ ...base, checks: null, targetOrder: 6 })).toBe(NEED_CONFIRMED_NAME)
    expect(changeNameAdvanceProblem({ ...base, checks: [nc('A', 'sent_to_client')], targetOrder: 4 })).toBe(NEED_CONFIRMED_NAME)
  })

  it('allows the signing step and the filing step once a name is accepted', () => {
    expect(changeNameAdvanceProblem({ ...base, checks: [nc('A', 'accepted')], targetOrder: 3 })).toBeNull()
    expect(changeNameAdvanceProblem({ stages, fromOrder: 3, checks: [nc('A', 'accepted')], targetOrder: 4 })).toBeNull()
  })

  it('refuses "waiting for the state" until a name is marked filed (even with an accepted one)', () => {
    expect(changeNameAdvanceProblem({ stages, fromOrder: 4, checks: [nc('A', 'accepted')], targetOrder: 5 })).toBe(NEED_FILED_NAME)
    expect(changeNameAdvanceProblem({ stages, fromOrder: 4, checks: [nc('A', 'filed')], targetOrder: 5 })).toBeNull()
  })

  it('a refused (state-rejected) name cannot unlock anything', () => {
    expect(changeNameAdvanceProblem({ stages, fromOrder: 4, checks: [nc('A', 'rejected_by_sos')], targetOrder: 5 })).toBe(NEED_CONFIRMED_NAME)
  })

  it('later forward moves keep needing the filed name; the records step onwards needs nothing more here', () => {
    expect(changeNameAdvanceProblem({ stages, fromOrder: 5, checks: [nc('A', 'filed')], targetOrder: 6 })).toBeNull()
    expect(changeNameAdvanceProblem({ stages, fromOrder: 7, checks: [nc('A', 'filed')], targetOrder: 8 })).toBeNull()
  })

  it('never refuses a move BACK or sideways', () => {
    expect(changeNameAdvanceProblem({ stages, fromOrder: 5, checks: [], targetOrder: 1 })).toBeNull()
    expect(changeNameAdvanceProblem({ stages, fromOrder: 3, checks: [], targetOrder: 3 })).toBeNull()
  })

  it('the gates are off while the catalog still has the old five stages', () => {
    expect(changeNameAdvanceProblem({ stages: OLD_CATALOG, fromOrder: 1, checks: [], targetOrder: 5 })).toBeNull()
  })
})

describe('advanceServiceDelivery for a Company Change Name', () => {
  it('refuses the signing step with no confirmed name and writes nothing', async () => {
    sdAt(CHANGE_NAME_STAGES.check, 2, [nc('A', 'available')])
    const writes = installFrom()
    const res = await advanceServiceDelivery({ delivery_id: 'sd-cn', target_stage: CHANGE_NAME_STAGES.sign })
    expect(res.success).toBe(false)
    expect(res.error).toBe(NEED_CONFIRMED_NAME)
    expect(sdWrites(writes)).toHaveLength(0)
  })

  it('refuses a jump straight to "waiting for the state" without a filed name', async () => {
    sdAt(CHANGE_NAME_STAGES.file, 4, [nc('A', 'accepted')])
    const writes = installFrom()
    const res = await advanceServiceDelivery({ delivery_id: 'sd-cn', target_stage: CHANGE_NAME_STAGES.wait })
    expect(res.success).toBe(false)
    expect(res.error).toBe(NEED_FILED_NAME)
    expect(sdWrites(writes)).toHaveLength(0)
  })

  it('a second press on the stage the job is already at is a no-op: no write, no notification', async () => {
    sdAt(CHANGE_NAME_STAGES.sign, 3, [nc('A', 'accepted')])
    const writes = installFrom()
    const res = await advanceServiceDelivery({ delivery_id: 'sd-cn', target_stage: CHANGE_NAME_STAGES.sign })
    expect(res.success).toBe(true)
    expect(res.auto_triggers.join(' ')).toMatch(/Already at/)
    expect(writes).toHaveLength(0)
  })

  it('moving back from a later step is allowed whatever the names say', async () => {
    sdAt(CHANGE_NAME_STAGES.wait, 5, [nc('A', 'rejected_by_sos')])
    installFrom()
    const res = await advanceServiceDelivery({ delivery_id: 'sd-cn', target_stage: CHANGE_NAME_STAGES.collect }).catch(() => null)
    expect(res?.error ?? '').not.toMatch(/confirmed a name|marked as filed|Mark the confirmed/)
  })

  it('with the old five-stage catalog the gates stay off', async () => {
    catalog = OLD_CATALOG
    sdAt('Collect three company names', 1, [])
    installFrom()
    const res = await advanceServiceDelivery({ delivery_id: 'sd-cn', target_stage: 'File the change name form' }).catch(() => null)
    expect(res?.error ?? '').not.toMatch(/confirmed a name|marked as filed|Mark the confirmed/)
  })

  it('other services are not affected by the name-change gates', async () => {
    delivery = { id: 'sd-x', service_type: 'DBA', service_name: 'DBA', stage: 'Notarization', stage_order: 4, stage_history: [], status: 'active', account_id: 'a', contact_id: null, is_test: false }
    catalog = [{ stage_name: 'Notarization', stage_order: 4, requires_approval: false, sla_days: null, auto_tasks: null, completes_service: false }, { stage_name: 'Money Order', stage_order: 5, requires_approval: false, sla_days: null, auto_tasks: null, completes_service: false }]
    installFrom()
    const res = await advanceServiceDelivery({ delivery_id: 'sd-x', target_stage: 'Money Order' }).catch(() => null)
    expect(res?.error ?? '').not.toMatch(/confirmed a name|marked as filed|Mark the confirmed/)
  })
})
