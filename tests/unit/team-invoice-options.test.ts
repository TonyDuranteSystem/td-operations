import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import type { User } from '@supabase/supabase-js'
import { normalizeCapabilities } from '@/lib/portal/team/capabilities'
import { teammateHistoryStart } from '@/lib/portal/team/history'
import { isItemHiddenFromUser, type ViewerHistoryDeps } from '@/lib/portal/viewer-history'
import { resolveInvoiceActor } from '@/lib/portal/invoice-actor'
import { toggleWithChildren } from '@/components/portal/team-manager'
import type { PortalIdentity } from '@/lib/portal/resolve-portal-identity'

const read = (p: string) => readFileSync(p, 'utf8')
const JOINED = '2026-10-10T12:00:00.000Z'

describe('owner-ticked options under Invoices & Billing (dev job e5d5400d)', () => {
  it('options are dropped when Invoices & Billing is not granted', () => {
    expect(normalizeCapabilities({ payment_links: true, invoice_history: true })).toEqual({})
    expect(normalizeCapabilities({ invoices_billing: true, payment_links: true })).toEqual({ invoices_billing: true, payment_links: true })
  })
  it('default is OFF: absent means restricted', () => {
    expect(normalizeCapabilities({ invoices_billing: true })).toEqual({ invoices_billing: true })
  })
  it('unticking the main box clears its options', () => {
    expect(toggleWithChildren({ invoices_billing: true, payment_links: true, invoice_history: true, chat: true }, 'invoices_billing'))
      .toEqual({ invoices_billing: false, payment_links: false, invoice_history: false, chat: true })
    expect(toggleWithChildren({ invoices_billing: true }, 'payment_links')).toEqual({ invoices_billing: true, payment_links: true })
  })
})

describe('team member start date for invoices and expenses', () => {
  it('without the option they start the day they joined', () => {
    expect(teammateHistoryStart({ createdAt: JOINED, capabilities: { invoices_billing: true } })).toBe(JOINED)
  })
  it('with the option they see everything', () => {
    expect(teammateHistoryStart({ createdAt: JOINED, capabilities: { invoices_billing: true, invoice_history: true } })).toBeNull()
  })
  it('a missing or bad date never hides anything', () => {
    expect(teammateHistoryStart({ createdAt: null, capabilities: {} })).toBeNull()
    expect(teammateHistoryStart({ createdAt: 'nope', capabilities: {} })).toBeNull()
  })
})

describe('isItemHiddenFromUser: one identity decision', () => {
  const user = { id: 'u', app_metadata: {} } as unknown as User
  const mate = (caps: Record<string, boolean>): PortalIdentity => ({ kind: 'teammate', teamMemberId: 't', accountId: 'A', displayName: 'V', email: null, capabilities: caps, createdAt: JOINED })
  const deps = (id: PortalIdentity, opened: string[] = []): ViewerHistoryDeps => ({
    resolve: async () => id,
    openedIds: async () => new Set(opened),
    contactHidden: async () => true,
  })
  const base = { user, accountId: 'A', kind: 'invoice' as const, itemId: 'i1' }
  it('older invoice is hidden from a team member without the option', async () => {
    expect(await isItemHiddenFromUser({ ...base, createdAt: '2026-10-01T00:00:00Z' }, deps(mate({ invoices_billing: true })))).toBe(true)
  })
  it('newer invoice is visible', async () => {
    expect(await isItemHiddenFromUser({ ...base, createdAt: '2026-10-15T00:00:00Z' }, deps(mate({ invoices_billing: true })))).toBe(false)
  })
  it('older invoice is visible with the option', async () => {
    expect(await isItemHiddenFromUser({ ...base, createdAt: '2026-10-01T00:00:00Z' }, deps(mate({ invoices_billing: true, invoice_history: true })))).toBe(false)
  })
  it('an older invoice staff opened on purpose is visible', async () => {
    expect(await isItemHiddenFromUser({ ...base, createdAt: '2026-10-01T00:00:00Z' }, deps(mate({ invoices_billing: true }), ['i1']))).toBe(false)
  })
  it('a client follows the company-link rule, none/staff is never hidden', async () => {
    expect(await isItemHiddenFromUser({ ...base, createdAt: 'x' }, deps({ kind: 'contact', contactId: 'C', accountIds: ['A'] }))).toBe(true)
    expect(await isItemHiddenFromUser({ ...base, createdAt: 'x' }, deps({ kind: 'none' }))).toBe(false)
  })
})

describe('actor carries the start date', () => {
  it('team member actor has historyStart', async () => {
    const user = { id: 'u', app_metadata: {} } as unknown as User
    const id: PortalIdentity = { kind: 'teammate', teamMemberId: 't', accountId: 'A', displayName: 'V', email: null, capabilities: { invoices_billing: true }, createdAt: JOINED }
    expect(await resolveInvoiceActor(user, 'invoices_billing', { resolve: async () => id })).toMatchObject({ kind: 'teammate', historyStart: JOINED })
  })
})

describe('wiring', () => {
  it('payment-link writes need the option, reading does not', () => {
    const r = read('app/api/portal/payment-links/route.ts')
    expect(r).toContain("canAccessAccount(user, accountId, 'payment_links')")
    const parts = r.split('export async function ')
    for (const p of parts) {
      if (/^(POST|PATCH|DELETE)/.test(p)) expect(p).toContain('verifyWriteAccess(')
      if (/^GET/.test(p)) expect(p).toContain('verifyAccess(')
    }
  })
  it('screen shows links read-only without the option; invite form lists both options under Invoices & Billing', () => {
    expect(read('app/portal/invoices/page.tsx')).toContain('readOnly={!canEditLinks}')
    const tm = read('components/portal/team-manager.tsx')
    expect(tm).toContain("key: 'payment_links'")
    expect(tm).toContain("key: 'invoice_history'")
    expect(tm).toContain("parent: 'invoices_billing'")
  })
  it('invoice page, invoice API and PDF all use the team member start date', () => {
    expect(read('app/portal/invoices/page.tsx')).toContain('actor.historyStart')
    expect(read('app/api/portal/invoices/[id]/route.ts')).toContain('isItemHiddenFromUser(')
    expect(read('app/api/portal/invoices/[id]/pdf/route.ts')).toContain('isItemHiddenFromUser(')
  })
  it('migration keeps existing team members as they are today', () => {
    const m = read('scripts/migrations/20261021-1900-team-invoice-options-keep-existing.sql')
    expect(m).toContain('payment_links')
    expect(m).toContain('invoice_history')
    expect(m).toContain("invoices_billing")
  })
})
