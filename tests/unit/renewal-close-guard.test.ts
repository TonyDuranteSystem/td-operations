import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'

/**
 * N1a C0 — a registered-agent renewal or an annual report can only be CLOSED by "Mark Filed" (Antonio 2026-10-02).
 * advanceServiceDelivery §4e refuses every other path with a plain message before anything is written; Mark Filed
 * passes the filing receipt and goes through. The database rule (20261002-2300-renewal-close-guard.sql) is the safety
 * net for every other writer (tested against the database). Other services, test jobs, and moves that do not close
 * are untouched.
 */

vi.mock('@/lib/supabase-admin', () => ({ supabaseAdmin: { from: vi.fn() } }))
vi.mock('@/lib/db', () => ({
  dbWrite: vi.fn(async (p: PromiseLike<{ data: unknown }>) => (await p).data),
  dbWriteSafe: vi.fn(async (p: PromiseLike<{ data: unknown; error: unknown }>) => await p),
}))
vi.mock('@/lib/mcp/action-log', () => ({ logAction: vi.fn() }))
const closesOnlyByFiling = vi.fn()
vi.mock('@/lib/services/renewal-close', async () => {
  const real = await vi.importActual<typeof import('@/lib/services/renewal-close')>('@/lib/services/renewal-close')
  return { ...real, closesOnlyByFiling: (...a: unknown[]) => closesOnlyByFiling(...a) }
})

import { advanceServiceDelivery } from '@/lib/service-delivery'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { cardClosesOnlyByFiling, CLOSES_ONLY_BY_FILING_MESSAGE } from '@/lib/services/renewal-close'
import { renewalJobMismatch } from '@/lib/operations/file-renewal'

let delivery: Record<string, unknown>
const RA_STAGES = [
  { stage_name: 'Upcoming', stage_order: 1 },
  { stage_name: 'In Progress', stage_order: 2 },
  { stage_name: 'Completed', stage_order: 3 },
].map(s => ({ ...s, requires_approval: false, sla_days: null, auto_tasks: null }))

function installFrom() {
  const writes: Array<{ table: string; op: 'update' | 'insert'; row: unknown }> = []
  vi.mocked(supabaseAdmin.from).mockImplementation(((table: string) => {
    const make = (result: unknown): Record<string, unknown> => {
      const chain: Record<string, unknown> = {}
      const self = () => chain
      for (const m of ['select', 'eq', 'neq', 'in', 'is', 'or', 'ilike', 'order', 'limit', 'contains', 'gte', 'lte']) chain[m] = self
      chain.single = () => Promise.resolve({ data: result, error: null })
      chain.maybeSingle = () => Promise.resolve({ data: result, error: null })
      chain.update = (row: unknown) => { writes.push({ table, op: 'update', row }); return chain }
      chain.insert = (row: unknown) => { writes.push({ table, op: 'insert', row }); return chain }
      chain.then = (resolve: (v: unknown) => unknown) =>
        Promise.resolve({ data: table === 'pipeline_stages' ? RA_STAGES : [], error: null }).then(resolve)
      return chain
    }
    if (table === 'service_deliveries') return make(delivery)
    if (table === 'pipeline_stages') return make(RA_STAGES)
    return make(null)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any)
  return writes
}

function raAt(stage: string, order: number, extra: Record<string, unknown> = {}) {
  delivery = {
    id: 'sd-1', service_type: 'State RA Renewal', service_name: 'RA', stage, stage_order: order, stage_history: [],
    status: 'active', account_id: 'acc-1', contact_id: null, is_test: false, service_type_entry_id: 'card-ra', ...extra,
  }
}

const sdUpdates = (w: ReturnType<typeof installFrom>) =>
  w.filter(x => x.table === 'service_deliveries' && x.op === 'update') as Array<{ row: Record<string, unknown> }>

beforeEach(() => {
  vi.clearAllMocks()
  closesOnlyByFiling.mockReset()
})

describe('advanceServiceDelivery §4e — closes only by filing', () => {
  it('REFUSES closing an RA renewal without the filing receipt, with the plain message, and writes nothing', async () => {
    raAt('Upcoming', 1)
    closesOnlyByFiling.mockResolvedValue(true)
    const writes = installFrom()
    const res = await advanceServiceDelivery({ delivery_id: 'sd-1', target_stage: 'Completed', actor: 'crm-tracker' })
    expect(res.success).toBe(false)
    expect(res.error).toBe(CLOSES_ONLY_BY_FILING_MESSAGE)
    expect(res.error).toMatch(/Mark Filed/)
    expect(sdUpdates(writes)).toHaveLength(0)
    expect(closesOnlyByFiling).toHaveBeenCalledWith('State RA Renewal', 'card-ra')
  })

  it('a blocked (unpaid) renewal is refused the same way', async () => {
    raAt('Upcoming', 1, { status: 'blocked' })
    closesOnlyByFiling.mockResolvedValue(true)
    installFrom()
    const res = await advanceServiceDelivery({ delivery_id: 'sd-1', target_stage: 'Completed' })
    expect(res.success).toBe(false)
  })

  it('Mark Filed (receipt passed) is NOT refused, and the receipt is written in the same update that closes the job', async () => {
    raAt('Upcoming', 1)
    closesOnlyByFiling.mockResolvedValue(true)
    const writes = installFrom()
    await advanceServiceDelivery({
      delivery_id: 'sd-1', target_stage: 'Completed', actor: 'dashboard:calendar', filing_receipt_document_id: 'doc-9',
    }).catch(() => null)
    expect(closesOnlyByFiling).not.toHaveBeenCalled()
    const closing = sdUpdates(writes).find(w => w.row.status === 'completed')
    expect(closing?.row.filing_receipt_document_id).toBe('doc-9')
  })

  it('a move that does not close (Upcoming -> In Progress) is untouched and carries no receipt', async () => {
    raAt('Upcoming', 1)
    const writes = installFrom()
    await advanceServiceDelivery({ delivery_id: 'sd-1', target_stage: 'In Progress' }).catch(() => null)
    expect(closesOnlyByFiling).not.toHaveBeenCalled()
    for (const w of sdUpdates(writes)) expect(w.row).not.toHaveProperty('filing_receipt_document_id')
  })

  it('a service whose card does not say "closes only by filing" closes normally', async () => {
    raAt('Upcoming', 1, { service_type: 'EIN', service_type_entry_id: 'card-ein' })
    closesOnlyByFiling.mockResolvedValue(false)
    const writes = installFrom()
    const res = await advanceServiceDelivery({ delivery_id: 'sd-1', target_stage: 'Completed' }).catch(() => null)
    expect(res?.error ?? '').not.toMatch(/Mark Filed/)
    expect(sdUpdates(writes).some(w => w.row.status === 'completed')).toBe(true)
  })

  it('test jobs are exempt (same as the database rule)', async () => {
    raAt('Upcoming', 1, { is_test: true })
    installFrom()
    await advanceServiceDelivery({ delivery_id: 'sd-1', target_stage: 'Completed' }).catch(() => null)
    expect(closesOnlyByFiling).not.toHaveBeenCalled()
  })

  it('a job already marked completed but NOT on its final step cannot be re-closed (no second date roll)', async () => {
    raAt('In Progress', 2, { status: 'completed' })
    closesOnlyByFiling.mockResolvedValue(true)
    const writes = installFrom()
    const res = await advanceServiceDelivery({ delivery_id: 'sd-1', target_stage: 'Completed' })
    expect(res.success).toBe(false)
    expect(res.error).toBe(CLOSES_ONLY_BY_FILING_MESSAGE)
    expect(sdUpdates(writes)).toHaveLength(0)
  })

  it('a failed CHECK (transient read) does not block here — the database rule is still the net', async () => {
    raAt('Upcoming', 1)
    closesOnlyByFiling.mockRejectedValue(new Error('read timeout'))
    installFrom()
    const res = await advanceServiceDelivery({ delivery_id: 'sd-1', target_stage: 'Completed' }).catch(() => null)
    expect(res?.error ?? '').not.toBe(CLOSES_ONLY_BY_FILING_MESSAGE)
  })
})

describe('cardClosesOnlyByFiling — same match as the database rule', () => {
  const cards = [
    { id: 'card-ra', metadata: { closes_only_by_filing: true, delivery_service_type: 'State RA Renewal' } },
    { id: 'card-ar', metadata: { closes_only_by_filing: true, delivery_service_type: 'State Annual Report' } },
    { id: 'card-ein', metadata: { delivery_service_type: 'EIN' } },
  ]
  it('matches by the job card link', () => expect(cardClosesOnlyByFiling(cards, 'Anything', 'card-ar')).toBe(true))
  it('matches an UNLINKED job by its job name', () => expect(cardClosesOnlyByFiling(cards, 'State RA Renewal', null)).toBe(true))
  it('does not match a card without the setting', () => expect(cardClosesOnlyByFiling(cards, 'EIN', 'card-ein')).toBe(false))
  it('does not match an unknown service', () => expect(cardClosesOnlyByFiling(cards, 'Shipping', null)).toBe(false))
  it('accepts the setting stored as text "true"', () =>
    expect(cardClosesOnlyByFiling([{ id: 'x', metadata: { closes_only_by_filing: 'true', delivery_service_type: 'X' } }], 'X', null)).toBe(true))
  it('handles empty input', () => {
    expect(cardClosesOnlyByFiling([], 'State RA Renewal', 'card-ra')).toBe(false)
    expect(cardClosesOnlyByFiling([{ id: 'n', metadata: null }], null, null)).toBe(false)
  })
})

describe('only Mark Filed passes the filing receipt', () => {
  it('no code outside the renewal-filing module and the pass-through plumbing sets filing_receipt_document_id', () => {
    const allowed = new Set([
      'lib/operations/file-renewal.ts', // Mark Filed — the one legitimate caller
      'lib/operations/service-delivery.ts', // completeSD pass-through
      'lib/service-delivery.ts', // advanceServiceDelivery: the param + the write
      'lib/database.types.ts', // generated types
    ])
    const hits: string[] = []
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const p = join(dir, name)
        if (name === 'node_modules' || name.startsWith('.')) continue
        if (statSync(p).isDirectory()) walk(p)
        else if (/\.(ts|tsx)$/.test(name) && readFileSync(p, 'utf8').includes('filing_receipt_document_id')) hits.push(p)
      }
    }
    for (const root of ['app', 'lib', 'components']) walk(join(process.cwd(), root))
    const offenders = hits.map(h => h.replace(process.cwd() + '/', '')).filter(h => !allowed.has(h))
    expect(offenders).toEqual([])
  })
})

describe('renewalJobMismatch — Mark Filed checks the job before writing anything', () => {
  const ok = { account_id: 'acc-1', service_type: 'State RA Renewal', status: 'active' }
  it('accepts this company\'s open job of the right kind (active or blocked)', () => {
    expect(renewalJobMismatch(ok, 'acc-1', 'State RA Renewal')).toBeNull()
    expect(renewalJobMismatch({ ...ok, status: 'blocked' }, 'acc-1', 'State RA Renewal')).toBeNull()
  })
  it('refuses a missing job', () => expect(renewalJobMismatch(null, 'acc-1', 'State RA Renewal')).toMatch(/no longer exists/))
  it('refuses another company\'s job', () => expect(renewalJobMismatch(ok, 'acc-2', 'State RA Renewal')).toMatch(/different company/))
  it('refuses the wrong kind', () => expect(renewalJobMismatch(ok, 'acc-1', 'State Annual Report')).toMatch(/not a State Annual Report/))
  it('refuses an already-filed job', () => expect(renewalJobMismatch({ ...ok, status: 'completed' }, 'acc-1', 'State RA Renewal')).toMatch(/already filed/))
  it('refuses a cancelled job', () => expect(renewalJobMismatch({ ...ok, status: 'cancelled' }, 'acc-1', 'State RA Renewal')).toMatch(/cancelled/))
})
