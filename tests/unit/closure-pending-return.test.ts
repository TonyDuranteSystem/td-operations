/** Dev job 0a60f416, part C — the pure rules of "a Tax Return still to be filed holds the closing", the brief text and the nightly-job guard. */
import { describe, it, expect, vi } from 'vitest'
import { belongsToKeptOffer, CLOSING_ENDED_MARKER, CLOSING_WAITS_MARKER, endedNote, hasWaitsMarker, holdingReturns, isDeadEndStage, isWaitingClosureJob, keptOfferTokens, newestMarker, returnLabel, waitsNote } from '@/lib/closure/pending-return'
import { closingBriefLines, closingHeadline, type ClosingBrief } from '@/lib/closure/closing-brief'

const job = (over: Record<string, unknown>) => ({ id: 'j', service_type: 'Tax Return', status: 'active', ...over }) as Parameters<typeof returnLabel>[0]

describe('which open jobs hold the closing', () => {
  it('both Tax Return job types hold it; nothing else does', () => {
    const open = [job({ id: 'a' }), job({ id: 'b', service_type: 'Tax Return One-Time' }), job({ id: 'c', service_type: 'State RA Renewal' }), job({ id: 'd', service_type: 'ITIN' })]
    expect(holdingReturns(open).map((j) => j.id)).toEqual(['a', 'b'])
  })
  it('the kept offers are the offers the kept tax returns came from (a return with no offer adds none)', () => {
    expect([...keptOfferTokens([job({ source_offer_token: 'x-2026' }), job({ source_offer_token: null })])]).toEqual(['x-2026'])
  })
  it('an invoice belongs to a kept offer only through its plan token', () => {
    const tokens = new Set(['x-2026'])
    expect(belongsToKeptOffer({ tranche_offer_token: 'x-2026' }, tokens)).toBe(true)
    expect(belongsToKeptOffer({ tranche_offer_token: 'y-2026' }, tokens)).toBe(false)
    expect(belongsToKeptOffer({ tranche_offer_token: null }, tokens)).toBe(false)
    expect(belongsToKeptOffer({}, tokens)).toBe(false)
  })
})

describe('a dead-end step does not hold the closing', () => {
  it('"Terminated…" steps are dead ends; ordinary steps are not', () => {
    expect(isDeadEndStage('Terminated - Non Payment')).toBe(true)
    expect(isDeadEndStage('  terminated')).toBe(true)
    for (const s of ['Wizard Available', 'TR Filed', null, undefined, '']) expect(isDeadEndStage(s as string | null | undefined)).toBe(false)
  })
  it('an open Tax Return at a dead-end step is not a holding return', () => {
    expect(holdingReturns([job({ id: 'a', stage: 'Terminated - Non Payment' }), job({ id: 'b', stage: 'Wizard Available' })]).map((j) => j.id)).toEqual(['b'])
  })
})

describe('the wait is the NEWEST marker on a closure job that is still finished at Closing', () => {
  const waits = { body: waitsNote([job({})]) }
  const ended = { body: endedNote('the company was closed') }
  it('newest marker wins, oldest first', () => {
    expect(newestMarker([])).toBeNull()
    expect(newestMarker([{ body: 'an ordinary note' }])).toBeNull()
    expect(newestMarker([waits])).toBe('waits')
    expect(newestMarker([waits, ended])).toBe('ended')
    expect(newestMarker([waits, ended, waits])).toBe('waits')
    expect(endedNote('x')).toContain(CLOSING_ENDED_MARKER)
  })
  it('waits only while the job is completed AND at Closing', () => {
    expect(isWaitingClosureJob({ status: 'completed', stage: 'Closing' }, [waits])).toBe(true)
    expect(isWaitingClosureJob({ status: 'active', stage: 'IRS Closure' }, [waits])).toBe(false) // went back
    expect(isWaitingClosureJob({ status: 'cancelled', stage: 'Closing' }, [waits])).toBe(false)
    expect(isWaitingClosureJob({ status: 'completed', stage: 'Closing' }, [waits, ended])).toBe(false)
    expect(isWaitingClosureJob({ status: 'completed', stage: 'Closing' }, [])).toBe(false)
  })
})

describe('the words staff read', () => {
  it('names the return with its year when the job name has one', () => {
    expect(returnLabel(job({ service_name: 'Tax Return 2026 - Carasso LLC' }))).toBe('Tax Return 2026')
    expect(returnLabel(job({ service_name: 'Tax Return - Carasso LLC' }))).toBe('Tax Return')
    expect(returnLabel(job({ service_name: null }))).toBe('Tax Return')
  })
  it('the marker note carries the marker, and only a note that carries it counts', () => {
    const note = waitsNote([job({ service_name: 'Tax Return 2026 - X' })])
    expect(note).toContain(CLOSING_WAITS_MARKER)
    expect(note).toMatch(/until Tax Return 2026 is filed/)
    expect(hasWaitsMarker(note)).toBe(true)
    expect(hasWaitsMarker('a note about closing')).toBe(false)
    expect(hasWaitsMarker(null)).toBe(false)
  })
})

describe('the ask-first question', () => {
  const base: ClosingBrief = { companyName: 'Carasso LLC', alreadyClosed: false, openServices: [], pendingDeadlines: 0, unpaid: { count: 0, totals: {} }, openTasks: 0, members: 2, hasLease: false, checkNote: null }
  it('says the company stays open and the portal stays on, and does not promise the portal loss', () => {
    const b = { ...base, keptReturns: ['Tax Return 2026'] }
    expect(closingHeadline(b)).toMatch(/stays open until its tax return is filed/)
    const lines = closingBriefLines(b).join(' | ')
    expect(lines).toMatch(/Tax Return 2026 is still to be filed: it and its unpaid invoices are NOT cancelled/)
    expect(lines).not.toMatch(/lose portal access/)
  })
  it('without a kept tax return it reads exactly as before', () => {
    expect(closingHeadline(base)).toBe('Finishing this job closes Carasso LLC.')
    expect(closingBriefLines(base).join(' | ')).toMatch(/2 people linked to the company will lose portal access/)
  })
})

describe('companiesWaitingForFinalReturn — the nightly-job guard', () => {
  async function run(tables: Record<string, Array<Record<string, unknown>>>, failOn?: string) {
    vi.resetModules()
    vi.doMock('@/lib/supabase-admin', () => ({
      supabaseAdmin: {
        from: (t: string) => {
          const filters: Array<(r: Record<string, unknown>) => boolean> = []
          const api: Record<string, unknown> = {
            select: () => api,
            ilike: (c: string, pat: string) => { const n = pat.replace(/%/g, '').toLowerCase(); filters.push((r) => String(r[c] ?? '').toLowerCase().includes(n)); return api },
            order: () => api,
            in: (c: string, vs: unknown[]) => { filters.push((r) => vs.includes(r[c])); return api },
            not: (c: string, _op: string, v: unknown) => { filters.push((r) => (r[c] ?? null) !== v); return api },
            then: (res: (v: unknown) => unknown) => res(failOn === t ? { data: null, error: { message: 'boom' } } : { data: (tables[t] ?? []).filter((r) => filters.every((f) => f(r))), error: null }),
          }
          return api
        },
      },
    }))
    const mod = await import('@/lib/closure/closing-wait')
    return mod.companiesWaitingForFinalReturn()
  }
  const tables = {
    service_delivery_notes: [{ service_delivery_id: 'job-1', body: `${CLOSING_WAITS_MARKER}: ...` }, { service_delivery_id: 'job-2', body: 'an ordinary note' }],
    service_deliveries: [{ id: 'job-1', account_id: 'acc-1', status: 'completed', stage: 'Closing' }, { id: 'job-2', account_id: 'acc-2', status: 'completed', stage: 'Closing' }],
    accounts: [{ id: 'acc-1', status: 'Active' }, { id: 'acc-2', status: 'Active' }, { id: 'acc-3', status: 'Active' }],
  }
  it('lists only the companies whose closure job left the marker', async () => {
    expect([...(await run(tables))]).toEqual(['acc-1'])
  })
  it('a closure job that went back, or was cancelled, no longer holds its company', async () => {
    expect([...(await run({ ...tables, service_deliveries: [{ id: 'job-1', account_id: 'acc-1', status: 'active', stage: 'IRS Closure' }] }))]).toEqual([])
    expect([...(await run({ ...tables, service_deliveries: [{ id: 'job-1', account_id: 'acc-1', status: 'cancelled', stage: 'Closing' }] }))]).toEqual([])
  })
  it('a wait that was ended no longer counts (the newest note wins)', async () => {
    const withEnd = { ...tables, service_delivery_notes: [...tables.service_delivery_notes, { service_delivery_id: 'job-1', body: `${CLOSING_ENDED_MARKER}: the company was closed.` }] }
    expect([...(await run(withEnd))]).toEqual([])
  })
  it('a company that has since been Closed is no longer waiting', async () => {
    expect([...(await run({ ...tables, accounts: [{ id: 'acc-1', status: 'Closed' }] }))]).toEqual([])
  })
  it('no marker anywhere = nobody waits', async () => {
    expect((await run({ ...tables, service_delivery_notes: [] })).size).toBe(0)
  })
  it('a read error stops the money job instead of guessing', async () => {
    await expect(run(tables, 'service_deliveries')).rejects.toThrow(/could not read the closure jobs/)
  })
})
