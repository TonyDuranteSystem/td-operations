import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import type { User } from '@supabase/supabase-js'
import { hubAccess, visibleInvoiceTabs, resolveInvoiceTab, type InvoiceTabContext } from '@/lib/portal/invoice-hub'
import { resolveInvoiceActor } from '@/lib/portal/invoice-actor'
import type { PortalIdentity } from '@/lib/portal/resolve-portal-identity'

const base: InvoiceTabContext = { hasAccount: true, hubOn: true, isClient: false, teammateCapabilities: null }
const ids = (c: InvoiceTabContext) => visibleInvoiceTabs(c).map(t => t.id)

describe('hubAccess / tabs for team members (dev job e5d5400d)', () => {
  it('client sees the whole hub', () => {
    expect(ids({ ...base, isClient: true })).toEqual(['setup', 'customers', 'sales', 'vendors', 'expenses'])
  })
  it('hub off: nobody gets hub tabs, legacy order', () => {
    expect(ids({ ...base, hubOn: false, isClient: true })).toEqual(['sales', 'expenses', 'vendors'])
    expect(ids({ ...base, hubOn: false, teammateCapabilities: { invoices_billing: true, sales_customers: true } })).toEqual(['sales', 'expenses', 'vendors'])
  })
  it('teammate with invoices_billing only: Setup, no Customers', () => {
    expect(ids({ ...base, teammateCapabilities: { invoices_billing: true } })).toEqual(['setup', 'sales', 'vendors', 'expenses'])
  })
  it('teammate with both: whole hub', () => {
    expect(ids({ ...base, teammateCapabilities: { invoices_billing: true, sales_customers: true } })).toEqual(['setup', 'customers', 'sales', 'vendors', 'expenses'])
  })
  it('teammate with sales_customers only: Customers, no Setup', () => {
    expect(ids({ ...base, teammateCapabilities: { sales_customers: true } })).toEqual(['customers', 'sales', 'vendors', 'expenses'])
  })
  it('teammate with unrelated capabilities gets legacy tabs', () => {
    expect(ids({ ...base, teammateCapabilities: { chat: true, documents: true } })).toEqual(['sales', 'expenses', 'vendors'])
  })
  it('partner (not client, not teammate) gets no hub tabs', () => {
    expect(hubAccess(base)).toEqual({ customers: false, setup: false, hubLayout: false })
  })
  it('no company: no hub', () => {
    expect(hubAccess({ ...base, hasAccount: false, isClient: true }).hubLayout).toBe(false)
  })
  it('?tab=customers cannot bypass a missing capability', () => {
    const ctx = { ...base, teammateCapabilities: { invoices_billing: true } }
    expect(resolveInvoiceTab({ tab: 'customers' }, ctx)).toBe('sales')
    expect(resolveInvoiceTab({ tab: 'setup' }, { ...base, teammateCapabilities: { sales_customers: true } })).toBe('sales')
  })
})

describe('resolveInvoiceActor: team member wins, even with a contact id', () => {
  const user = { id: 'u1', app_metadata: {} } as unknown as User
  const mate: PortalIdentity = { kind: 'teammate', teamMemberId: 't', accountId: 'A1', displayName: 'V', email: null, capabilities: { invoices_billing: true } }
  const contact: PortalIdentity = { kind: 'contact', contactId: 'C1', accountIds: ['A1', 'A2'] }
  it('teammate with the capability', async () => {
    expect(await resolveInvoiceActor(user, 'invoices_billing', { resolve: async () => mate })).toEqual({ kind: 'teammate', accountId: 'A1', capabilities: { invoices_billing: true } })
  })
  it('teammate without the capability is denied', async () => {
    expect(await resolveInvoiceActor(user, 'sales_customers', { resolve: async () => mate })).toBeNull()
  })
  it('capability null only identifies', async () => {
    expect((await resolveInvoiceActor(user, null, { resolve: async () => mate }))?.kind).toBe('teammate')
  })
  it('client passes', async () => {
    expect(await resolveInvoiceActor(user, 'invoices_billing', { resolve: async () => contact })).toMatchObject({ kind: 'contact', contactId: 'C1' })
  })
  it('none is denied', async () => {
    expect(await resolveInvoiceActor(user, 'invoices_billing', { resolve: async () => ({ kind: 'none' }) })).toBeNull()
  })
})

describe('source guards: one rule for page, sidebar and new-pages', () => {
  const read = (p: string) => readFileSync(p, 'utf8')
  it('page and sidebar use hubAccess; page has no contact-first identity', () => {
    expect(read('app/portal/invoices/page.tsx')).toContain('hubAccess(')
    expect(read('app/portal/invoices/page.tsx')).not.toContain('getClientContactId')
    expect(read('components/portal/portal-sidebar.tsx')).toContain('hubAccess(')
  })
  it('new invoice / new customer pages resolve through the actor with the right capability', () => {
    expect(read('app/portal/invoices/new/page.tsx')).toContain("resolveInvoiceActor(user, 'invoices_billing')")
    expect(read('app/portal/customers/new/page.tsx')).toContain("resolveInvoiceActor(user, 'sales_customers')")
    expect(read('app/portal/invoices/new/page.tsx')).not.toContain('getClientContactId')
  })
  it('bank block is read-only without bank_applications; checklist/tour are client-only', () => {
    const p = read('app/portal/invoices/page.tsx')
    expect(p).toContain("hasCapability(teammateCaps, 'bank_applications')")
    expect(p).toContain('readOnly={!canEditBank}')
    expect(p).toContain('isClientHub')
  })
})

describe('dead ends closed (bug-hunter round)', () => {
  const read = (p: string) => readFileSync(p, 'utf8')
  it('invoice detail API tells the page whether the viewer may edit the customer; the banner link follows it', () => {
    expect(read('app/api/portal/invoices/[id]/route.ts')).toContain("can_edit_customer: await canAccessAccount(user, invoice.account_id, 'sales_customers')")
    expect(read('app/portal/invoices/[id]/page.tsx')).toContain('invoice.can_edit_customer === false ? null : invoice.customer_id')
  })
  it("customer detail API does not hand a customers-only team member the customer's invoices; page hides the invoices card", () => {
    const api = read('app/api/portal/customers/[id]/route.ts')
    expect(api).toContain("canAccessAccount(user, customer.account_id, 'invoices_billing')")
    expect(api).toContain('can_invoice: canInvoice')
    expect(read('app/portal/customers/[id]/page.tsx')).toContain('{canInvoice && (')
  })
  it('the old customers page uses the same identity decision', () => {
    const p = read('app/portal/customers/page.tsx')
    expect(p).toContain("resolveInvoiceActor(user, 'sales_customers')")
    expect(p).not.toContain('getClientContactId')
  })
})
