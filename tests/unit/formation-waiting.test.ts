/**
 * hasFormationWaitingForItsCompany (lib/portal/formation-waiting.ts) — what the wizard-reminder cron asks before it closes a
 * formation wizard as "done elsewhere". It must look for an ACTIVE Company Formation job of THIS person with NO company yet, and on a
 * read error it must answer "yes" (leave the wizard open) rather than let the cron close it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const h = vi.hoisted(() => ({
  filters: [] as Array<[string, string, unknown]>,
  result: { count: 0, error: null as { message: string } | null },
}))

vi.mock('@/lib/supabase-admin', () => {
  const chain: Record<string, unknown> = {}
  chain.select = () => chain
  chain.eq = (c: string, v: unknown) => { h.filters.push(['eq', c, v]); return chain }
  chain.is = (c: string, v: unknown) => { h.filters.push(['is', c, v]); return chain }
  chain.then = (res: (v: unknown) => unknown) => res({ count: h.result.count, error: h.result.error })
  return { supabaseAdmin: { from: (t: string) => { h.filters.push(['from', t, null]); return chain } } }
})

import { hasFormationWaitingForItsCompany } from '@/lib/portal/formation-waiting'

beforeEach(() => { h.filters = []; h.result = { count: 0, error: null } })

describe('hasFormationWaitingForItsCompany', () => {
  it('asks for an active Company Formation job of this person that has no company yet', async () => {
    h.result.count = 1
    expect(await hasFormationWaitingForItsCompany('c1')).toBe(true)
    expect(h.filters).toEqual([
      ['from', 'service_deliveries', null],
      ['eq', 'contact_id', 'c1'],
      ['eq', 'service_type', 'Company Formation'],
      ['eq', 'status', 'active'],
      ['is', 'account_id', null],
    ])
  })

  it('says no when there is none', async () => {
    expect(await hasFormationWaitingForItsCompany('c1')).toBe(false)
  })

  it('says no, without asking the database, when the wizard has no person', async () => {
    expect(await hasFormationWaitingForItsCompany(null)).toBe(false)
    expect(await hasFormationWaitingForItsCompany(undefined)).toBe(false)
    expect(h.filters).toEqual([])
  })

  it('says YES on a read error — the wizard stays open and reminders go on', async () => {
    h.result.error = { message: 'database busy' }
    expect(await hasFormationWaitingForItsCompany('c1')).toBe(true)
  })
})
