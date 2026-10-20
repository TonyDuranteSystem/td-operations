/**
 * S3: the "Action Items" lines for services waiting on the client. Opt-in per step, new services only, the step's own client wording,
 * a link to the page where the client can actually do the step.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const h = vi.hoisted(() => ({
  goLive: null as unknown,
  settingThrows: false,
  sds: [] as Record<string, unknown>[],
  stages: [] as unknown[],
  error: null as { table: string; message: string } | null,
  queries: [] as Array<{ table: string; filters: Array<[string, unknown]> }>,
  reported: [] as Array<{ message: string }>,
}))

vi.mock('@/lib/settings', () => ({
  getAppSetting: async () => {
    if (h.settingThrows) throw new Error('settings read failed')
    return h.goLive
  },
}))
vi.mock('@/lib/system-errors', () => ({
  reportSystemError: async (e: { message: string }) => {
    h.reported.push(e)
    return null
  },
}))
vi.mock('@/lib/supabase-admin', () => {
  const make = (table: string) => {
    const filters: Array<[string, unknown]> = []
    const b: Record<string, unknown> = {}
    for (const m of ['select', 'neq', 'order', 'limit', 'in']) b[m] = () => b
    b.eq = (c: string, v: unknown) => {
      filters.push([c, v])
      return b
    }
    b.is = (c: string, v: unknown) => {
      filters.push([c, v === null ? '__NULL__' : v])
      return b
    }
    b.gte = (c: string, v: unknown) => {
      filters.push([`${c}>=`, v])
      return b
    }
    b.then = (resolve: (v: unknown) => unknown) => {
      h.queries.push({ table, filters })
      if (h.error && h.error.table === table) return resolve({ data: null, error: { message: h.error.message } })
      if (table === 'pipeline_stages') return resolve({ data: h.stages, error: null })
      // apply the scope filters the code asked for, so a service of ANOTHER company or person really is left out
      const data = h.sds.filter((sd) =>
        filters.every(([c, v]) => {
          if (c.endsWith('>=')) return String(sd[c.slice(0, -2)]) >= String(v)
          if (v === '__NULL__') return sd[c] == null
          return sd[c] === v
        }),
      )
      return resolve({ data, error: null })
    }
    return b
  }
  return { supabaseAdmin: { from: (t: string) => make(t) } }
})

import { buildClientTurnItems, clientTurnHref, getClientTurnItems, type ClientTurnSd, type ClientTurnStage } from '@/lib/portal/client-turn-items'

const read = (f: string) => readFileSync(join(process.cwd(), f), 'utf8')
const GO_LIVE = new Date('2026-10-21T12:00:00.000Z')
const NOW = new Date('2026-10-25T12:00:00.000Z')

const stage = (over: Partial<ClientTurnStage> = {}): ClientTurnStage => ({
  service_type: 'Company Change Name',
  stage_name: 'Collect three company names',
  client_label: 'Send us your names',
  client_label_it: 'Inviaci i tuoi nomi',
  ...over,
})
const sd = (over: Partial<ClientTurnSd> = {}): ClientTurnSd => ({
  id: 'sd-1',
  account_id: 'acc-1',
  service_type: 'Company Change Name',
  service_name: 'Company Change Name',
  stage: 'Collect three company names',
  stage_entered_at: '2026-10-24T12:00:00.000Z',
  created_at: '2026-10-22T09:00:00.000Z',
  ...over,
})

// a row as the database returns it for the queries below (they filter on status, account and person)
const row = (over: Record<string, unknown> = {}) => ({ ...sd(), status: 'active', contact_id: null, ...over }) as unknown as Record<string, unknown>

describe('buildClientTurnItems', () => {
  it('one line per service on an opted-in client step, in both languages', () => {
    const items = buildClientTurnItems({ sds: [sd()], stages: [stage()], goLive: GO_LIVE, now: NOW })
    expect(items).toEqual([
      {
        type: 'service',
        title: 'Send us your names',
        titleIt: 'Inviaci i tuoi nomi',
        description: 'Company Change Name',
        descriptionIt: 'Company Change Name',
        href: '/portal/flows/sd-1',
        priority: 'blue',
        createdAt: '2026-10-24T12:00:00.000Z',
      },
    ])
  })

  it('NOTHING without go-live, and nothing for a service created before it', () => {
    expect(buildClientTurnItems({ sds: [sd()], stages: [stage()], goLive: null, now: NOW })).toEqual([])
    expect(buildClientTurnItems({ sds: [sd({ created_at: '2026-10-20T09:00:00.000Z' })], stages: [stage()], goLive: GO_LIVE, now: NOW })).toEqual([])
  })

  it('a step that is not opted in (not in the stage list) shows no line', () => {
    expect(buildClientTurnItems({ sds: [sd({ stage: 'File the form with the state' })], stages: [stage()], goLive: GO_LIVE, now: NOW })).toEqual([])
    expect(buildClientTurnItems({ sds: [sd()], stages: [], goLive: GO_LIVE, now: NOW })).toEqual([])
  })

  it('a step with no client wording is skipped rather than showing a blank or an internal stage name', () => {
    expect(buildClientTurnItems({ sds: [sd()], stages: [stage({ client_label: null })], goLive: GO_LIVE, now: NOW })).toEqual([])
    expect(buildClientTurnItems({ sds: [sd()], stages: [stage({ client_label: '   ' })], goLive: GO_LIVE, now: NOW })).toEqual([])
  })

  it('no Italian label: the English one is shown in Italian too', () => {
    const [i] = buildClientTurnItems({ sds: [sd()], stages: [stage({ client_label_it: null })], goLive: GO_LIVE, now: NOW })
    expect(i.titleIt).toBe('Send us your names')
  })

  it('matches service type AND step: the same step name under another service does not leak', () => {
    const items = buildClientTurnItems({ sds: [sd({ service_type: 'ITIN', service_name: 'ITIN' })], stages: [stage()], goLive: GO_LIVE, now: NOW })
    expect(items).toEqual([])
  })

  it('the colour follows how long the step has waited: blue, orange after 3 days, red after 7', () => {
    const at = (days: number) => new Date(NOW.getTime() - days * 86_400_000).toISOString()
    const prio = (days: number) => buildClientTurnItems({ sds: [sd({ stage_entered_at: at(days) })], stages: [stage()], goLive: GO_LIVE, now: NOW })[0].priority
    expect(prio(1)).toBe('blue')
    expect(prio(3)).toBe('blue')
    expect(prio(4)).toBe('orange')
    expect(prio(7)).toBe('orange')
    expect(prio(8)).toBe('red')
  })

  it('two services on opted-in steps give two lines, each opening its own place', () => {
    const items = buildClientTurnItems({
      sds: [sd(), sd({ id: 'sd-2', account_id: null, service_type: 'ITIN', service_name: 'ITIN', stage: 'Client Signing' })],
      stages: [stage(), stage({ service_type: 'ITIN', stage_name: 'Client Signing', client_label: 'Print, sign & mail documents', client_label_it: 'Stampa, firma e spedisci documenti' })],
      goLive: GO_LIVE,
      now: NOW,
    })
    expect(items.map((i) => i.href)).toEqual(['/portal/flows/sd-1', '/portal/flows/sd-2'])
  })
})

describe('clientTurnHref — the line opens the page where the client can DO the step', () => {
  it('Operating Agreement step: Generate Documents for that company (the service page only shows the journey)', () => {
    expect(clientTurnHref({ id: 'sd-1', account_id: 'acc-1', service_type: 'Company Change Name', stage: 'Client updates the Operating Agreement' })).toBe('/portal/documents/generate?account=acc-1')
  })
  it('signing step: the Sign Documents page', () => {
    expect(clientTurnHref({ id: 'sd-1', account_id: 'acc-1', service_type: 'Company Change Name', stage: 'Client signs the name-change form' })).toBe('/portal/sign')
  })
  it('names step and ITIN signing: the service page (it carries the form / the print-sign-mail card)', () => {
    expect(clientTurnHref({ id: 'sd-9', account_id: 'acc-1', service_type: 'Company Change Name', stage: 'Collect three company names' })).toBe('/portal/flows/sd-9')
    expect(clientTurnHref({ id: 'sd-9', account_id: null, service_type: 'ITIN', stage: 'Client Signing' })).toBe('/portal/flows/sd-9')
  })
  it('a service type with NO client page opens the home page instead of a 404', () => {
    expect(clientTurnHref({ id: 'sd-9', account_id: 'acc-1', service_type: 'DBA', stage: 'Name Collection' })).toBe('/portal')
    expect(clientTurnHref({ id: 'sd-9', account_id: 'acc-1', service_type: 'Public Notary', stage: 'Documents Received' })).toBe('/portal')
  })
  it('the OA link never keeps a literal {account_id} token when the service has no company', () => {
    expect(clientTurnHref({ id: 'sd-1', account_id: null, service_type: 'Company Change Name', stage: 'Client updates the Operating Agreement' })).toBe('/portal/documents/generate')
  })
})

describe('getClientTurnItems', () => {
  beforeEach(() => {
    h.goLive = GO_LIVE.toISOString()
    h.settingThrows = false
    h.sds = [row()]
    h.stages = [stage()]
    h.error = null
    h.queries = []
    h.reported = []
  })

  it('returns the lines for the selected company', async () => {
    const items = await getClientTurnItems({ accountId: 'acc-1', contactId: 'con-1' })
    expect(items).toHaveLength(1)
    expect(items[0].title).toBe('Send us your names')
  })

  it('OFF while the switch is unset or unreadable: NO query at all is made', async () => {
    h.goLive = null
    expect(await getClientTurnItems({ accountId: 'acc-1' })).toEqual([])
    h.goLive = '2026'
    expect(await getClientTurnItems({ accountId: 'acc-1' })).toEqual([])
    h.goLive = GO_LIVE.toISOString()
    h.settingThrows = true
    expect(await getClientTurnItems({ accountId: 'acc-1' })).toEqual([])
    expect(h.queries).toHaveLength(0)
  })

  it('another company\'s service is NOT listed on this company\'s view, nor one created before go-live, nor a finished one', async () => {
    h.sds = [row({ id: 'mine' }), row({ id: 'theirs', account_id: 'acc-2' }), row({ id: 'old', created_at: '2026-10-20T00:00:00.000Z' }), row({ id: 'closed', status: 'completed' })]
    const items = await getClientTurnItems({ accountId: 'acc-1' })
    expect(items.map((i) => i.href)).toEqual(['/portal/flows/mine'])
  })

  it('the person\'s own (account-less) services are listed only for that person, never another person\'s', async () => {
    h.sds = [
      row({ id: 'itin-mine', account_id: null, service_type: 'ITIN', stage: 'Client Signing', contact_id: 'con-1' }),
      row({ id: 'itin-other', account_id: null, service_type: 'ITIN', stage: 'Client Signing', contact_id: 'con-2' }),
    ]
    h.stages = [stage({ service_type: 'ITIN', stage_name: 'Client Signing', client_label: 'Print, sign & mail documents', client_label_it: null })]
    const items = await getClientTurnItems({ contactId: 'con-1' })
    expect(items.map((i) => i.href)).toEqual(['/portal/flows/itin-mine'])
  })

  it('a failed read leaves the box as it was AND is reported (a missing column on a database the migration has not reached must not hide silently)', async () => {
    for (const table of ['service_deliveries', 'pipeline_stages']) {
      h.error = { table, message: 'column pipeline_stages.client_task_in_list does not exist' }
      h.reported = []
      expect(await getClientTurnItems({ accountId: 'acc-1', contactId: 'con-1' }), table).toEqual([])
      expect(h.reported, table).toHaveLength(1)
      expect(h.reported[0].message).toContain('does not exist')
    }
  })
})

describe('wiring', () => {
  it('both Action Items queries add the lines, the box has an icon for them, and the type is registered', () => {
    const q = read('lib/portal/queries.ts')
    expect(q).toContain('items.push(...(await getClientTurnItems({ accountId, contactId })))')
    expect(q).toContain('items.push(...(await getClientTurnItems({ contactId })))')
    expect(q).toContain("type: 'form' | 'invoice' | 'signature' | 'wizard' | 'service'")
    expect(read('components/portal/action-items.tsx')).toContain('service: ListChecks')
  })

  it('the box keeps its heading: "Action Items" / "Azioni da completare" (Antonio, 2026-10-20)', () => {
    const i18n = read('lib/portal/i18n.ts')
    expect(i18n).toContain("'actionItems.title': 'Action Items'")
    expect(i18n).toContain("'actionItems.title': 'Azioni da completare'")
  })

  it('the migration is opt-in, covers exactly the client steps that have a page to open, and refuses to finish unless exactly 4 steps are on', () => {
    const m = read('scripts/migrations/20261020-1900-s3-service-start-notices.sql')
    expect(m).toContain('ADD COLUMN IF NOT EXISTS client_task_in_list boolean NOT NULL DEFAULT false')
    expect(m).toContain("'Collect three company names', 'Client signs the name-change form', 'Client updates the Operating Agreement'")
    expect(m).toContain("service_type = 'ITIN' AND stage_name = 'Client Signing'")
    expect(m).toContain('<> 4 THEN')
    // only the UPDATE statement decides which steps are switched on (the comments explain who is left out)
    const update = m.slice(m.indexOf('UPDATE public.pipeline_stages'), m.indexOf('INSERT INTO public.catalog_entries'))
    expect(update).not.toMatch(/DBA|Consulting|Banking|Formation|Closure/)
    expect(read('scripts/migrations/20261020-1900-s3-service-start-notices.UNDO.sql')).toContain('DROP COLUMN IF EXISTS client_task_in_list')
  })
})
