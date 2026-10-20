/**
 * S3 (workspace-only plan, dev job 0a07e0cd): the "your service has started" message for services where WE act first.
 * The rule that matters most: NOTHING happens until the go-live switch is set, and then only for services created after it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const h = vi.hoisted(() => ({
  tables: {} as Record<string, unknown[]>,
  errors: {} as Record<string, string>,
  inserts: [] as Array<{ table: string; row: Record<string, unknown> }>,
  goLive: null as unknown,
  settingThrows: false,
  bell: [] as Array<Record<string, unknown>>,
  bellError: null as string | null,
  reported: [] as Array<{ message: string }>,
}))

vi.mock('@/lib/supabase-admin', () => {
  const builder = (table: string) => {
    const filters: Array<[string, unknown]> = []
    // A filter applies only to rows that carry that column, so a fixture can stay small — but a row that carries it MUST match.
    const rows = () =>
      ((h.tables[table] ?? []) as Record<string, unknown>[]).filter((r) => filters.every(([c, v]) => !(c in r) || r[c] === v))
    const b: Record<string, unknown> = {}
    for (const m of ['select', 'neq', 'order', 'limit', 'gte', 'is', 'in']) b[m] = () => b
    b.eq = (c: string, v: unknown) => {
      filters.push([c, v])
      return b
    }
    b.maybeSingle = async () => (h.errors[table] ? { data: null, error: { message: h.errors[table] } } : { data: rows()[0] ?? null, error: null })
    b.insert = async (row: Record<string, unknown>) => {
      h.inserts.push({ table, row })
      return { error: null }
    }
    b.then = (resolve: (v: unknown) => unknown) => resolve({ data: rows(), error: null })
    return b
  }
  return { supabaseAdmin: { from: (t: string) => builder(t) } }
})
vi.mock('@/lib/settings', () => ({
  getAppSetting: async () => {
    if (h.settingThrows) throw new Error('settings read failed')
    return h.goLive
  },
}))
vi.mock('@/lib/services', () => ({
  getEntryByServiceType: async (t: string) =>
    ({ Shipping: { display_name: 'Shipping Service' }, 'Public Notary': { display_name: 'Public Notary' }, 'Certificate of Incumbency': { display_name: 'Certificate of Incumbency' } } as Record<string, { display_name: string }>)[t] ?? null,
}))
vi.mock('@/lib/portal/notifications', () => ({
  createPortalNotification: async (p: Record<string, unknown>) => {
    h.bell.push(p)
    return { error: h.bellError }
  },
}))
vi.mock('@/lib/mcp/action-log', () => ({ logAction: () => {} }))
vi.mock('@/lib/system-errors', () => ({
  reportSystemError: async (e: { message: string }) => {
    h.reported.push(e)
    return null
  },
}))

import {
  parseGoLive,
  createdAfterGoLive,
  getServiceStartGoLive,
  renderServiceStartedText,
  announceServiceStarted,
  SERVICE_STARTED_FALLBACK,
} from '@/lib/operations/service-start-notice'
import { wantsServiceStartNotice, SERVICE_START_NOTICE_TYPES } from '@/lib/operations/service-start-types'

const read = (f: string) => readFileSync(join(process.cwd(), f), 'utf8')

const GO_LIVE = '2026-10-21T12:00:00.000Z'
const SYSTEM = 'b0da5d9c-acf6-4761-9cae-2c3b14dbc631'
const sd = (over: Record<string, unknown> = {}) => ({
  id: 'sd-1',
  service_type: 'Public Notary',
  service_name: 'Public Notary',
  status: 'active',
  account_id: 'acc-1',
  contact_id: 'con-1',
  created_at: '2026-10-22T09:00:00.000Z',
  stage_entered_at: '2026-10-22T09:00:00.000Z',
  due_date: null,
  ...over,
})
const EN_BODY = (service: string, company = 'Acme Holdings LLC') =>
  `Hi Mario, your ${service} for ${company} has started. Nothing is needed from you right now. We will write to you here as soon as we need something, or when it is done.`

beforeEach(() => {
  h.tables = {
    service_deliveries: [sd()],
    contacts: [{ language: 'English', full_name: 'Mario Rossi', first_name: 'Mario' }],
    accounts: [{ company_name: 'Acme Holdings LLC', status: 'Active' }],
    catalog_entries: [],
    portal_messages: [],
    account_contacts: [],
  }
  h.errors = {}
  h.inserts = []
  h.bell = []
  h.bellError = null
  h.reported = []
  h.goLive = GO_LIVE
  h.settingThrows = false
})

describe('which services get the message', () => {
  it('exactly the four services where we act first (the STORED type values)', () => {
    expect([...SERVICE_START_NOTICE_TYPES].sort()).toEqual(['Certificate of Incumbency', 'EIN Change Name', 'Public Notary', 'Shipping'])
  })
  it('not Consulting Call (left out by Antonio), Company Closure, Company Change Name, "Shipping Service" (not a stored type) or anything else', () => {
    for (const t of ['Consulting Call', 'Company Closure', 'Company Change Name', 'Shipping Service', 'Tax Return', 'ITIN', 'Company Formation', '', null, undefined]) {
      expect(wantsServiceStartNotice(t as string | null | undefined), String(t)).toBe(false)
    }
  })
})

describe('go-live gate (pure)', () => {
  it('parseGoLive accepts a full ISO timestamp and rejects everything else', () => {
    expect(parseGoLive(GO_LIVE)?.toISOString()).toBe(GO_LIVE)
    expect(parseGoLive('2026-10-21T08:00:00-04:00')?.toISOString()).toBe('2026-10-21T12:00:00.000Z')
    expect(parseGoLive('2026-10-21T12:00Z')?.toISOString()).toBe('2026-10-21T12:00:00.000Z')
    for (const bad of [null, undefined, '', '   ', 'tomorrow', 42, {}, true]) expect(parseGoLive(bad), String(bad)).toBeNull()
  })
  it('a typo that JavaScript would still read as a date is refused: "1", "12", "2026", a bare date', () => {
    for (const typo of ['1', '12', '2026', '2026-10', '2026-10-21', '2026-10-2', 'Oct 21 2026', '2026-10-21 12:00:00']) {
      expect(parseGoLive(typo), typo).toBeNull()
    }
  })
  it('a date from before S3 existed is refused (it would list every existing service)', () => {
    expect(parseGoLive('2001-01-01T00:00:00Z')).toBeNull()
    expect(parseGoLive('2026-09-30T23:59:59Z')).toBeNull()
    expect(parseGoLive('2026-10-01T00:00:00Z')).not.toBeNull()
  })
  it('createdAfterGoLive: no go-live = never; before = no; at the exact moment and after = yes', () => {
    const g = parseGoLive(GO_LIVE)
    expect(createdAfterGoLive(null, '2026-12-01T00:00:00Z')).toBe(false)
    expect(createdAfterGoLive(g, '2026-10-21T11:59:59Z')).toBe(false)
    expect(createdAfterGoLive(g, GO_LIVE)).toBe(true)
    expect(createdAfterGoLive(g, '2026-10-22T00:00:00Z')).toBe(true)
    expect(createdAfterGoLive(g, null)).toBe(false)
    expect(createdAfterGoLive(g, 'not a date')).toBe(false)
  })
  it('FAILS CLOSED: a settings read that throws means OFF', async () => {
    h.settingThrows = true
    expect(await getServiceStartGoLive()).toBeNull()
    h.settingThrows = false
    expect((await getServiceStartGoLive())?.toISOString()).toBe(GO_LIVE)
  })
})

describe('the approved wording', () => {
  it('English: greets by first name, names the service and company, says nothing is needed', () => {
    const t = renderServiceStartedText(SERVICE_STARTED_FALLBACK.en, { firstName: 'Mario', serviceName: 'Public Notary', companyName: 'Acme Holdings LLC' })
    expect(t.body).toBe(EN_BODY('Public Notary'))
    expect(t.title).toBe('Public Notary — nothing needed from you for now')
  })
  it('Italian: "Ciao" (Antonio, 2026-10-20), never "Caro"', () => {
    const t = renderServiceStartedText(SERVICE_STARTED_FALLBACK.it, { firstName: 'Mario', serviceName: 'Public Notary', companyName: 'Acme Holdings LLC' })
    expect(t.body).toBe('Ciao Mario, il servizio Public Notary per Acme Holdings LLC è partito. Per ora non devi fare nulla. Ti scriviamo qui appena ci serve qualcosa, oppure quando è completato.')
    expect(t.title).toBe('Public Notary — per ora non devi fare nulla')
    expect(t.body).not.toMatch(/Caro/)
  })
  it('a person-level service (no company) drops the company part instead of printing a placeholder', () => {
    const en = renderServiceStartedText(SERVICE_STARTED_FALLBACK.en, { firstName: 'Mario', serviceName: 'Shipping Service', companyName: null })
    expect(en.body).toBe('Hi Mario, your Shipping Service has started. Nothing is needed from you right now. We will write to you here as soon as we need something, or when it is done.')
    const it = renderServiceStartedText(SERVICE_STARTED_FALLBACK.it, { firstName: 'Mario', serviceName: 'Shipping Service', companyName: '  ' })
    expect(it.body).toBe('Ciao Mario, il servizio Shipping Service è partito. Per ora non devi fare nulla. Ti scriviamo qui appena ci serve qualcosa, oppure quando è completato.')
    for (const t of [en.body, it.body]) expect(t).not.toContain('{{')
  })
  it('no first name on file: no "Hi ,"', () => {
    const t = renderServiceStartedText(SERVICE_STARTED_FALLBACK.en, { firstName: null, serviceName: 'Public Notary', companyName: 'Acme LLC' })
    expect(t.body.startsWith('Hi, your Public Notary')).toBe(true)
    expect(t.body).not.toContain('{{')
  })
})

describe('announceServiceStarted', () => {
  it('goes live: one chat message in the service topic + one bell row that the digest will email', async () => {
    const r = await announceServiceStarted('sd-1')
    expect(r).toEqual({ ok: true })
    const chat = h.inserts.filter((i) => i.table === 'portal_messages')
    expect(chat).toHaveLength(1)
    expect(chat[0].row).toMatchObject({
      account_id: 'acc-1',
      contact_id: 'con-1',
      service_delivery_id: 'sd-1',
      topic: 'Public Notary 2026',
      sender_type: 'admin',
      sender_id: SYSTEM,
    })
    expect(chat[0].row.message).toBe(EN_BODY('Public Notary'))
    expect(h.bell).toHaveLength(1)
    expect(h.bell[0]).toMatchObject({ type: 'service_started', account_id: 'acc-1', contact_id: 'con-1' })
    // the digest must email it: the bell row is NOT kept out of the digest
    expect(h.bell[0]).not.toHaveProperty('suppressDigestEmail')
    expect(String(h.bell[0].link)).toContain('/portal/chat/open')
    expect(String(h.bell[0].link)).toContain('topic=Public%20Notary%202026')
    expect(h.reported).toHaveLength(0)
  })

  it('the client reads the CATALOG name, never the internal label every creator stores ("Shipping - Mario Rossi #2")', async () => {
    for (const stored of ['Shipping - Mario Rossi', 'Shipping - Mario Rossi #2', 'Shipping — Acme Holdings LLC', 'Shipping']) {
      h.inserts = []
      h.tables.service_deliveries = [sd({ service_type: 'Shipping', service_name: stored })]
      h.tables.portal_messages = []
      await announceServiceStarted('sd-1')
      expect(h.inserts[0].row.message, stored).toBe(EN_BODY('Shipping Service'))
    }
    expect(h.bell.at(-1)?.title).toBe('Shipping Service — nothing needed from you for now')
  })

  it('Italian client gets the Italian text', async () => {
    h.tables.contacts = [{ language: 'Italian', full_name: 'Giulia Bianchi', first_name: 'Giulia' }]
    await announceServiceStarted('sd-1')
    expect(h.inserts[0].row.message).toContain('Ciao Giulia, il servizio Public Notary per Acme Holdings LLC è partito.')
    expect(String(h.bell[0].title)).toBe('Public Notary — per ora non devi fare nulla')
  })

  it('the catalog row wins over the built-in text (editable in /catalog)', async () => {
    h.tables.catalog_entries = [
      { display_name: '{{serviceName}} started', display_name_translations: {}, description: 'Hello {{firstName}}: {{serviceName}} / {{companyName}}', description_translations: {}, status: 'active' },
    ]
    await announceServiceStarted('sd-1')
    expect(h.inserts[0].row.message).toBe('Hello Mario: Public Notary / Acme Holdings LLC')
    expect(h.bell[0].title).toBe('Public Notary started')
  })

  it('OFF by default: no go-live setting = nothing is sent', async () => {
    for (const off of [null, undefined, '', 'garbage', '1', '2026']) {
      h.goLive = off
      h.inserts = []
      h.bell = []
      const r = await announceServiceStarted('sd-1')
      expect(r.skipped, String(off)).toMatch(/S3 is off/)
      expect(h.inserts).toHaveLength(0)
      expect(h.bell).toHaveLength(0)
    }
  })

  it('a service created BEFORE go-live is never messaged', async () => {
    h.tables.service_deliveries = [sd({ created_at: '2026-10-20T09:00:00.000Z' })]
    const r = await announceServiceStarted('sd-1')
    expect(r.skipped).toMatch(/before go-live/)
    expect(h.inserts).toHaveLength(0)
    expect(h.bell).toHaveLength(0)
  })

  it('skips services that send no start message, and services that are not active', async () => {
    h.tables.service_deliveries = [sd({ service_type: 'Tax Return' })]
    expect((await announceServiceStarted('sd-1')).skipped).toMatch(/sends no start message/)
    h.tables.service_deliveries = [sd({ status: 'on_hold' })]
    expect((await announceServiceStarted('sd-1')).skipped).toMatch(/on_hold/)
    expect(h.inserts).toHaveLength(0)
  })

  it('idempotent: the exact message already in THIS service thread is not posted twice — a different message or another service does not count', async () => {
    h.tables.portal_messages = [{ id: 'm-1', service_delivery_id: 'sd-1', sender_id: SYSTEM, message: EN_BODY('Public Notary') }]
    const r = await announceServiceStarted('sd-1')
    expect(r.skipped).toBe('already announced')
    expect(h.inserts).toHaveLength(0)
    expect(h.bell).toHaveLength(0)

    // a staff message in the same thread, or the same text on another service, must not suppress it
    for (const other of [
      { id: 'm-2', service_delivery_id: 'sd-1', sender_id: SYSTEM, message: 'Something else' },
      { id: 'm-3', service_delivery_id: 'sd-OTHER', sender_id: SYSTEM, message: EN_BODY('Public Notary') },
      { id: 'm-4', service_delivery_id: 'sd-1', sender_id: 'staff-user', message: EN_BODY('Public Notary') },
    ]) {
      h.tables.portal_messages = [other]
      h.inserts = []
      h.bell = []
      expect((await announceServiceStarted('sd-1')).skipped, other.id).toBeUndefined()
      expect(h.inserts.filter((i) => i.table === 'portal_messages'), other.id).toHaveLength(1)
    }
  })

  it('a company the portal hides gets the message in the personal thread (account_id null)', async () => {
    h.tables.accounts = [{ company_name: 'Acme Holdings LLC', status: 'Closed' }]
    await announceServiceStarted('sd-1')
    expect(h.inserts[0].row.account_id).toBeNull()
  })

  it('a company-less service goes to the person, without a company part', async () => {
    // the stored type is "Shipping"; the client reads the catalog's name, "Shipping Service"
    h.tables.service_deliveries = [sd({ account_id: null, service_type: 'Shipping', service_name: 'Shipping - Mario Rossi' })]
    await announceServiceStarted('sd-1')
    expect(h.inserts[0].row.account_id).toBeNull()
    expect(h.inserts[0].row.message).toBe('Hi Mario, your Shipping Service has started. Nothing is needed from you right now. We will write to you here as soon as we need something, or when it is done.')
  })

  it('nobody to tell (no contact and no company) is skipped, not an error', async () => {
    h.tables.service_deliveries = [sd({ account_id: null, contact_id: null })]
    const r = await announceServiceStarted('sd-1')
    expect(r).toMatchObject({ ok: true })
    expect(r.skipped).toMatch(/nobody to tell/)
  })

  it('a bell failure never undoes the chat message — and it is REPORTED, not just logged', async () => {
    h.bellError = 'insert failed'
    const r = await announceServiceStarted('sd-1')
    expect(r).toEqual({ ok: true })
    expect(h.inserts.filter((i) => i.table === 'portal_messages')).toHaveLength(1)
    expect(h.reported).toHaveLength(1)
    expect(h.reported[0].message).toContain('insert failed')
    expect(h.reported[0].message).toContain('sd-1')
  })

  it('a failed read of the client or the company sends NOTHING (never an English message to an Italian client, never the wrong thread) and is reported', async () => {
    for (const table of ['contacts', 'accounts', 'service_deliveries']) {
      h.errors = { [table]: 'database is down' }
      h.inserts = []
      h.bell = []
      h.reported = []
      const r = await announceServiceStarted('sd-1')
      expect(r.ok, table).toBe(false)
      expect(r.error, table).toContain('database is down')
      expect(h.inserts, table).toHaveLength(0)
      expect(h.bell, table).toHaveLength(0)
      expect(h.reported, table).toHaveLength(1)
    }
  })

  it('a company that cannot be found is a failure too (the message would otherwise lose its company and thread)', async () => {
    h.tables.accounts = []
    const r = await announceServiceStarted('sd-1')
    expect(r.ok).toBe(false)
    expect(h.inserts).toHaveLength(0)
  })

  it('unknown service id returns an error result, never throws', async () => {
    h.tables.service_deliveries = []
    const r = await announceServiceStarted('nope')
    expect(r.ok).toBe(false)
  })
})

describe('wiring', () => {
  it('createSD asks for the message right after the SD exists, behind the cheap type check and the skip option, and a failure never rolls the SD back', () => {
    const s = read('lib/operations/service-delivery.ts')
    expect(s).toContain('if (!params.skip_client_notice && wantsServiceStartNotice(row.service_type)) {')
    expect(s).toContain('await announceServiceStarted(row.id)')
    expect(s).toContain('service start message failed (non-fatal)')
    expect(s.indexOf('await announceServiceStarted(row.id)')).toBeGreaterThan(s.indexOf('"service_deliveries.insert"'))
  })

  it('the chain-audit repair (a service the client paid for long ago) never announces it as new', () => {
    const s = read('app/api/crm/admin-actions/audit-chain/route.ts')
    expect(s.split('skip_client_notice: true').length - 1).toBe(2) // both createParams shapes
  })

  it('the message goes straight into portal_messages (no R103 chat email) and the bell row is NOT kept out of the digest', () => {
    const s = read('lib/operations/service-start-notice.ts')
    expect(s).toContain('sender_id: SYSTEM_ADMIN_SENDER_ID')
    expect(s).not.toContain('suppressDigestEmail')
    expect(s).toContain('type: SERVICE_STARTED_NOTIFICATION_TYPE')
  })

  it('the settings key is registered', () => {
    expect(read('lib/settings.ts')).toContain('"service_start_notices_go_live"')
    expect(read('lib/operations/service-start-notice.ts')).toContain("SERVICE_START_GO_LIVE_KEY = 'service_start_notices_go_live'")
  })
})
