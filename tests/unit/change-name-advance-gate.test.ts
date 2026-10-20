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
import { changeNameAdvanceProblem, NEED_CONFIRMED_NAME, NEED_FILED_NAME, NEED_SIGNED_FORM, NEED_NAME_APPLIED } from '@/lib/flows/change-name-gates'
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
let signedEnvelopes = 0
let accountHistory: unknown[] = []
let accountName = 'Old Name LLC'
let esignReadFails = false

function installFrom() {
  const writes: Array<{ table: string; row: unknown }> = []
  vi.mocked(supabaseAdmin.from).mockImplementation(((table: string) => {
    const result = table === 'service_deliveries' ? delivery : table === 'accounts' ? { is_test: false, name_history: accountHistory, company_name: accountName } : null
    const list = table === 'pipeline_stages' ? catalog : []
    const chain: Record<string, unknown> = {}
    const self = () => chain
    for (const m of ['select', 'eq', 'neq', 'in', 'is', 'or', 'ilike', 'order', 'limit', 'contains']) chain[m] = self
    chain.single = () => Promise.resolve({ data: result, error: null })
    chain.maybeSingle = () => Promise.resolve({ data: result, error: null })
    chain.update = (row: unknown) => { writes.push({ table, row }); return chain }
    chain.insert = (row: unknown) => { writes.push({ table, row }); return chain }
    chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve({ data: list, count: table === 'esign_envelopes' && !esignReadFails ? signedEnvelopes : undefined, error: table === 'esign_envelopes' && esignReadFails ? { message: 'db blinked' } : null }).then(resolve)
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
  signedEnvelopes = 0
  accountHistory = []
  accountName = 'Old Name LLC'
  esignReadFails = false
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

  describe('the signed form must exist before the filing step, and the applied name before the Operating Agreement step', () => {
    const filed = [nc('A', 'filed')]
    it('crossing "File the form with the state" needs a completed e-sign envelope', () => {
      expect(changeNameAdvanceProblem({ stages, fromOrder: 3, checks: filed, targetOrder: 4, hasSignedForm: false })).toBe(NEED_SIGNED_FORM)
      expect(changeNameAdvanceProblem({ stages, fromOrder: 3, checks: filed, targetOrder: 4, hasSignedForm: true })).toBeNull()
    })
    it('a jump from the names straight over the signing and filing steps is refused too (the live QA case)', () => {
      expect(changeNameAdvanceProblem({ stages, fromOrder: 2, checks: filed, targetOrder: 5, hasSignedForm: false })).toBe(NEED_SIGNED_FORM)
      expect(changeNameAdvanceProblem({ stages, fromOrder: 2, checks: filed, targetOrder: 5, hasSignedForm: true })).toBeNull()
    })
    it('a job already PAST the filing step is not trapped by it (an in-flight job from before the rule)', () => {
      expect(changeNameAdvanceProblem({ stages, fromOrder: 4, checks: filed, targetOrder: 5, hasSignedForm: false })).toBeNull()
      expect(changeNameAdvanceProblem({ stages, fromOrder: 5, checks: filed, targetOrder: 6, hasSignedForm: false })).toBeNull()
    })
    it('crossing "Client updates the Operating Agreement" needs the new name applied (the button must not skip Apply)', () => {
      expect(changeNameAdvanceProblem({ stages, fromOrder: 6, checks: filed, targetOrder: 7, nameApplied: false })).toBe(NEED_NAME_APPLIED)
      expect(changeNameAdvanceProblem({ stages, fromOrder: 6, checks: filed, targetOrder: 7, nameApplied: true })).toBeNull()
      expect(changeNameAdvanceProblem({ stages, fromOrder: 5, checks: filed, targetOrder: 8, nameApplied: false })).toBe(NEED_NAME_APPLIED) // a jump to Completed
    })
    it('a job already at or past the Operating Agreement step is not refused (moving on to Completed, or back)', () => {
      expect(changeNameAdvanceProblem({ stages, fromOrder: 7, checks: filed, targetOrder: 8, nameApplied: false })).toBeNull()
      expect(changeNameAdvanceProblem({ stages, fromOrder: 7, checks: filed, targetOrder: 6, nameApplied: false })).toBeNull()
    })
    it('left off (undefined) when the facts were not looked up — the older callers and the old catalog keep working', () => {
      expect(changeNameAdvanceProblem({ stages, fromOrder: 6, checks: filed, targetOrder: 7 })).toBeNull()
      expect(changeNameAdvanceProblem({ stages, fromOrder: 3, checks: filed, targetOrder: 4 })).toBeNull()
      expect(changeNameAdvanceProblem({ stages: OLD_CATALOG, fromOrder: 1, checks: [], targetOrder: 5, hasSignedForm: false, nameApplied: false })).toBeNull()
    })
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

  it('refuses the filing step while no signed form exists, and lets it through once the client has signed', async () => {
    sdAt(CHANGE_NAME_STAGES.sign, 3, [nc('A', 'accepted')])
    let writes = installFrom()
    const refused = await advanceServiceDelivery({ delivery_id: 'sd-cn', target_stage: CHANGE_NAME_STAGES.file })
    expect(refused.success).toBe(false)
    expect(refused.error).toBe(NEED_SIGNED_FORM)
    expect(sdWrites(writes)).toHaveLength(0)

    signedEnvelopes = 1
    writes = installFrom()
    const ok = await advanceServiceDelivery({ delivery_id: 'sd-cn', target_stage: CHANGE_NAME_STAGES.file, skip_tasks: true }).catch(() => null)
    expect(ok?.error ?? '').not.toBe(NEED_SIGNED_FORM)
  })

  it('refuses a stepper jump from the names over the signing step with no signed form (nothing is written)', async () => {
    sdAt(CHANGE_NAME_STAGES.check, 2, [nc('A', 'filed')])
    const writes = installFrom()
    const res = await advanceServiceDelivery({ delivery_id: 'sd-cn', target_stage: CHANGE_NAME_STAGES.wait })
    expect(res.success).toBe(false)
    expect(res.error).toBe(NEED_SIGNED_FORM)
    expect(sdWrites(writes)).toHaveLength(0)
  })

  it('the "Records updated" button cannot skip Apply: refused until this job\'s name change is applied, and not after an undo', async () => {
    sdAt(CHANGE_NAME_STAGES.records, 6, [nc('A', 'filed')])
    let writes = installFrom()
    const refused = await advanceServiceDelivery({ delivery_id: 'sd-cn', target_stage: CHANGE_NAME_STAGES.oa })
    expect(refused.success).toBe(false)
    expect(refused.error).toBe(NEED_NAME_APPLIED)
    expect(sdWrites(writes)).toHaveLength(0)

    // applied and then undone = not applied
    accountHistory = [{ type: 'change', change_id: 'sd-cn' }, { type: 'undo', change_id: 'sd-cn' }]
    writes = installFrom()
    expect((await advanceServiceDelivery({ delivery_id: 'sd-cn', target_stage: CHANGE_NAME_STAGES.oa })).error).toBe(NEED_NAME_APPLIED)

    // applied (this job's change, not undone) = allowed past this gate
    accountHistory = [{ type: 'change', change_id: 'sd-cn' }]
    writes = installFrom()
    const ok = await advanceServiceDelivery({ delivery_id: 'sd-cn', target_stage: CHANGE_NAME_STAGES.oa, skip_tasks: true }).catch(() => null)
    expect(ok?.error ?? '').not.toBe(NEED_NAME_APPLIED)
    // a DIFFERENT job's change does not count
    accountHistory = [{ type: 'change', change_id: 'some-other-job' }]
    installFrom()
    expect((await advanceServiceDelivery({ delivery_id: 'sd-cn', target_stage: CHANGE_NAME_STAGES.oa })).error).toBe(NEED_NAME_APPLIED)
  })

  it('a company that ALREADY carries the filed name has nothing to apply — the job is not stranded (capitals-only change, Fix spelling instead of Apply)', async () => {
    sdAt(CHANGE_NAME_STAGES.records, 6, [nc('Acme LLC', 'filed')])
    accountName = '  ACME   llc '
    installFrom()
    const ok = await advanceServiceDelivery({ delivery_id: 'sd-cn', target_stage: CHANGE_NAME_STAGES.oa, skip_tasks: true }).catch(() => null)
    expect(ok?.error ?? '').not.toBe(NEED_NAME_APPLIED)
    // a DIFFERENT current name still needs Apply
    accountName = 'Old Name LLC'
    installFrom()
    expect((await advanceServiceDelivery({ delivery_id: 'sd-cn', target_stage: CHANGE_NAME_STAGES.oa })).error).toBe(NEED_NAME_APPLIED)
  })

  it('a failed database read leaves the signed-form lock OFF — never a wrong "the client has not signed"', async () => {
    sdAt(CHANGE_NAME_STAGES.sign, 3, [nc('A', 'accepted')])
    esignReadFails = true
    installFrom()
    const res = await advanceServiceDelivery({ delivery_id: 'sd-cn', target_stage: CHANGE_NAME_STAGES.file, skip_tasks: true }).catch(() => null)
    expect(res?.error ?? '').not.toBe(NEED_SIGNED_FORM)
  })

  it('the signed-form refusal tells staff WHERE the form must be sent from', () => {
    expect(NEED_SIGNED_FORM).toMatch(/Prepare the form for signature/)
    expect(NEED_SIGNED_FORM).toMatch(/not linked to this job/)
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
