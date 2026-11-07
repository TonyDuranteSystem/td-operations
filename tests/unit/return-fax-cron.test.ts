/**
 * Tax Return plan item 6 (dev job 6f555c9f) — the delivery-check cron (app/api/cron/return-fax-confirm/route.ts): who may call it, which jobs it
 * looks at, and — the gap found after shipping — that EVERY run is written to cron_log, because the System Health page and the cron monitor
 * read that log and show a registered cron with no logged run as stale.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const fx = vi.hoisted(() => ({
  jobs: [] as Array<{ id: string }>,
  listError: null as { message: string } | null,
  outcomes: {} as Record<string, { outcome: string; error?: string }>,
  throwOnReal: false,
  filters: [] as string[],
  logs: [] as Array<Record<string, unknown>>,
}))

vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: {
    from: (table: string) => {
      fx.filters.push(`from:${table}`)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const b: any = {}
      b.select = () => b
      b.eq = (col: string, val: string) => { fx.filters.push(`eq:${col}=${val}`); return b }
      b.neq = (col: string, val: string) => { fx.filters.push(`neq:${col}=${val}`); return b }
      b.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) => Promise.resolve({ data: fx.listError ? null : fx.jobs, error: fx.listError }).then(res, rej)
      return b
    },
  },
}))
vi.mock('@/lib/cron-log', () => ({ logCron: (e: Record<string, unknown>) => { fx.logs.push(e) } }))
vi.mock('@/lib/fax/return-fax-delivery', () => ({
  realReturnFaxDeps: async () => { if (fx.throwOnReal) throw new Error('deps exploded'); return {} },
  processReturnFaxDelivery: async (id: string) => fx.outcomes[id] ?? { outcome: 'no_fax' },
}))

import { GET } from '@/app/api/cron/return-fax-confirm/route'

const req = (auth?: string) => ({ headers: { get: (h: string) => (h.toLowerCase() === 'authorization' ? auth ?? null : null) } }) as never
const ENDPOINT = '/api/cron/return-fax-confirm'

beforeEach(() => {
  fx.jobs = []; fx.listError = null; fx.outcomes = {}; fx.throwOnReal = false; fx.filters = []; fx.logs = []
  delete process.env.CRON_SECRET
})
afterEach(() => { delete process.env.CRON_SECRET })

describe('who may call the cron', () => {
  it('with a CRON_SECRET set, a call without the right secret is refused and nothing is looked at or logged', async () => {
    process.env.CRON_SECRET = 's3cret'
    expect((await GET(req())).status).toBe(401)
    expect((await GET(req('Bearer nope'))).status).toBe(401)
    expect(fx.filters).toEqual([])
    expect(fx.logs).toEqual([])
  })
  it('with the right secret it runs', async () => {
    process.env.CRON_SECRET = 's3cret'
    expect((await GET(req('Bearer s3cret'))).status).toBe(200)
  })
})

describe('which jobs it checks', () => {
  it('only Tax Return jobs at "Signed" that are not cancelled', async () => {
    await GET(req())
    expect(fx.filters).toEqual(['from:service_deliveries', 'eq:service_type=Tax Return', 'eq:stage=Signed', 'neq:status=cancelled'])
  })
})

describe('every run is written to cron_log', () => {
  it('a run with nothing to do is logged as a success', async () => {
    const res = await GET(req())
    expect(await res.json()).toMatchObject({ success: true, checked: 0, tally: {}, errors: [] })
    expect(fx.logs).toHaveLength(1)
    expect(fx.logs[0]).toMatchObject({ endpoint: ENDPOINT, status: 'success', details: { checked: 0, tally: {}, errors: [] } })
    expect(typeof fx.logs[0].duration_ms).toBe('number')
  })
  it('the outcomes of the checks are counted in the log (a delivered fax, a waiting one, a job with no fax)', async () => {
    fx.jobs = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
    fx.outcomes = { a: { outcome: 'filed' }, b: { outcome: 'pending' }, c: { outcome: 'no_fax' } }
    await GET(req())
    expect(fx.logs[0]).toMatchObject({ status: 'success', details: { checked: 3, tally: { filed: 1, pending: 1, no_fax: 1 } } })
  })
  it('a check that could not be completed makes the run "error" (it is retried next run) and says which one', async () => {
    fx.jobs = [{ id: 'a' }, { id: 'b' }]
    fx.outcomes = { a: { outcome: 'filed' }, b: { outcome: 'error', error: 'Faxage login failed' } }
    const res = await GET(req())
    expect(res.status).toBe(200) // the run itself worked; the check is retried
    expect(fx.logs[0]).toMatchObject({ status: 'error', error_message: 'b: Faxage login failed', details: { checked: 2, tally: { filed: 1, error: 1 } } })
  })
  it('a job list that cannot be read is a 500 and an "error" row', async () => {
    fx.listError = { message: 'db down' }
    const res = await GET(req())
    expect(res.status).toBe(500)
    expect(fx.logs).toHaveLength(1)
    expect(fx.logs[0]).toMatchObject({ endpoint: ENDPOINT, status: 'error', error_message: 'db down' })
  })
  it('an exception anywhere is a 500 and an "error" row, never a silent failure', async () => {
    fx.throwOnReal = true
    const res = await GET(req())
    expect(res.status).toBe(500)
    expect(fx.logs).toHaveLength(1)
    expect(fx.logs[0]).toMatchObject({ endpoint: ENDPOINT, status: 'error', error_message: 'deps exploded' })
  })
  it('exactly one row per run', async () => {
    fx.jobs = [{ id: 'a' }, { id: 'b' }]
    await GET(req())
    expect(fx.logs).toHaveLength(1)
  })
})
