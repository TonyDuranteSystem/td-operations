import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import type { User } from '@supabase/supabase-js'
import { isItemHiddenFromTeamMember, getTeamMemberHistoryView, type ViewerHistoryDeps } from '@/lib/portal/viewer-history'
import { authorizeInvoice, type AccessDeps } from '@/lib/portal/invoice-access'
import type { PortalIdentity } from '@/lib/portal/resolve-portal-identity'

const read = (p: string) => readFileSync(p, 'utf8')
const JOINED = '2026-10-10T12:00:00.000Z'
const user = { id: 'u', app_metadata: {} } as unknown as User
const mate = (caps: Record<string, boolean>): PortalIdentity => ({ kind: 'teammate', teamMemberId: 't', accountId: 'A', displayName: 'V', email: null, capabilities: caps, createdAt: JOINED })
const deps = (id: PortalIdentity, opened: string[] = []): ViewerHistoryDeps => ({ resolve: async () => id, openedIds: async () => new Set(opened), contactHidden: async () => true })
const base = { user, accountId: 'A', kind: 'invoice' as const, itemId: 'i1' }

describe('isItemHiddenFromTeamMember (side doors: send, remind, edit, duplicate, expenses)', () => {
  it('hides an older invoice from a team member without the option', async () => {
    expect(await isItemHiddenFromTeamMember({ ...base, createdAt: '2026-10-01T00:00:00Z' }, deps(mate({ invoices_billing: true })))).toBe(true)
  })
  it('does not hide a newer one, or anything with the option, or an item staff opened', async () => {
    expect(await isItemHiddenFromTeamMember({ ...base, createdAt: '2026-10-20T00:00:00Z' }, deps(mate({ invoices_billing: true })))).toBe(false)
    expect(await isItemHiddenFromTeamMember({ ...base, createdAt: '2026-10-01T00:00:00Z' }, deps(mate({ invoices_billing: true, invoice_history: true })))).toBe(false)
    expect(await isItemHiddenFromTeamMember({ ...base, createdAt: '2026-10-01T00:00:00Z' }, deps(mate({ invoices_billing: true }), ['i1']))).toBe(false)
  })
  it('never hides anything from a client or staff (their rule lives where it always did)', async () => {
    expect(await isItemHiddenFromTeamMember({ ...base, createdAt: '2020-01-01T00:00:00Z' }, deps({ kind: 'contact', contactId: 'C', accountIds: ['A'] }))).toBe(false)
    expect(await isItemHiddenFromTeamMember({ ...base, createdAt: '2020-01-01T00:00:00Z' }, deps({ kind: 'none' }))).toBe(false)
  })
  it('a missing date never hides anything', async () => {
    expect(await isItemHiddenFromTeamMember({ ...base, createdAt: null }, deps(mate({ invoices_billing: true })))).toBe(false)
  })
})

describe('getTeamMemberHistoryView', () => {
  it('start date for a team member without the option, none otherwise', async () => {
    expect((await getTeamMemberHistoryView({ user, accountId: 'A', kind: 'invoice' }, deps(mate({ invoices_billing: true })))).cutoff).toBe(JOINED)
    expect((await getTeamMemberHistoryView({ user, accountId: 'A', kind: 'invoice' }, deps(mate({ invoices_billing: true, invoice_history: true })))).cutoff).toBeNull()
    expect((await getTeamMemberHistoryView({ user, accountId: 'A', kind: 'invoice' }, deps({ kind: 'contact', contactId: 'C', accountIds: ['A'] }))).cutoff).toBeNull()
  })
})

describe('authorizeInvoice applies the start date', () => {
  const ad = (hidden: boolean): AccessDeps => ({
    getUser: async () => user,
    canAccess: async () => true,
    loadInvoiceAccount: async () => 'A',
    hiddenFromTeamMember: async () => hidden,
  })
  it('hidden invoice answers like a missing one', async () => {
    expect(await authorizeInvoice('i1', 'invoices_billing', ad(true))).toEqual({ ok: false, error: 'Invoice not found' })
  })
  it('visible invoice passes', async () => {
    expect(await authorizeInvoice('i1', 'invoices_billing', ad(false))).toMatchObject({ ok: true })
  })
})

describe('wiring: every door applies the start date', () => {
  it('send, remind and customer-email routes', () => {
    for (const r of ['send', 'remind', 'customer-email']) {
      const s = read(`app/api/portal/invoices/[id]/${r}/route.ts`)
      expect(s, r).toContain('isItemHiddenFromTeamMember(')
    }
  })
  it('expense actions read created_at and check it', () => {
    const s = read('app/portal/invoices/expense-actions.ts')
    expect(s).toContain('isItemHiddenFromTeamMember(')
    expect((s.match(/select\('id, source, account_id, contact_id, created_at'\)/g) ?? []).length).toBe(3)
  })
  it("customer detail API filters the customer's invoices; customer list counts follow the start date", () => {
    expect(read('app/api/portal/customers/[id]/route.ts')).toContain('getTeamMemberHistoryView(')
    expect(read('components/portal/customers-panel.tsx')).toContain('invoicesFrom')
    expect(read('app/portal/invoices/page.tsx')).toContain("invoicesFrom={actor.kind === 'teammate' ? actor.historyStart : null}")
    expect(read('app/portal/customers/page.tsx')).toContain("invoicesFrom={actor.kind === 'teammate' ? actor.historyStart : null}")
  })
  it('documents page: invoice archive needs invoices_billing for a team member and follows the start date', () => {
    const s = read('app/portal/documents/page.tsx')
    expect(s).toContain("canAccessAccount(user, selectedAccountId, 'invoices_billing')")
    expect(s).toContain('getTeamMemberHistoryView(')
  })
})
