import { describe, it, expect } from 'vitest'
import {
  isInvoiceHubOnFor, visibleInvoiceTabs, resolveInvoiceTab, setupItems, missingRequiredCount, evaluateChecklist, missingRequired,
  type InvoiceTabContext,
} from '@/lib/portal/invoice-hub'

const client: InvoiceTabContext = { hasAccount: true, hubOn: true, isClient: true }
const ids = (c: InvoiceTabContext) => visibleInvoiceTabs(c).map(t => t.id)

describe('roll-out switch fails closed', () => {
  it('only an explicit on counts', () => {
    expect(isInvoiceHubOnFor(true, 'a')).toBe(true)
    expect(isInvoiceHubOnFor({ enabled: true }, 'a')).toBe(true)
    for (const off of [false, null, undefined, 0, 'true', 'yes', {}, { enabled: false }, { enabled: 'true' }, []]) {
      expect(isInvoiceHubOnFor(off, 'a')).toBe(false)
    }
  })
  it('a list restricts it to those companies', () => {
    const s = { enabled: true, account_ids: ['a', 'b'] }
    expect(isInvoiceHubOnFor(s, 'a')).toBe(true)
    expect(isInvoiceHubOnFor(s, 'z')).toBe(false)
    expect(isInvoiceHubOnFor(s, null)).toBe(false)
    expect(isInvoiceHubOnFor({ enabled: true, account_ids: [] }, 'a')).toBe(false)
  })
})

describe('tab list', () => {
  it('switch on: the five tabs in order, Setup last', () => {
    expect(ids(client)).toEqual(['setup', 'customers', 'sales', 'vendors', 'expenses'])
  })
  it('switch off: exactly the old three tabs', () => {
    expect(ids({ ...client, hubOn: false })).toEqual(['sales', 'expenses', 'vendors'])
  })
  it('a team member never gets Customers or Setup here', () => {
    expect(ids({ ...client, isClient: false })).toEqual(['sales', 'expenses', 'vendors'])
  })
  it('a client with no company only has Expenses', () => {
    expect(ids({ hasAccount: false, hubOn: true, isClient: true })).toEqual(['expenses'])
  })
})

describe('active tab', () => {
  it('picks the requested tab when allowed', () => {
    expect(resolveInvoiceTab({ tab: 'setup' }, client)).toBe('setup')
    expect(resolveInvoiceTab({ tab: 'customers' }, client)).toBe('customers')
    expect(resolveInvoiceTab({ tab: 'vendors' }, client)).toBe('vendors')
  })
  it('the paid-receipt link always opens Expenses', () => {
    expect(resolveInvoiceTab({ view: 'paid' }, client)).toBe('expenses')
    expect(resolveInvoiceTab({ view: 'paid', tab: 'setup' }, client)).toBe('expenses')
  })
  it('a tab that is not allowed falls back, never errors', () => {
    expect(resolveInvoiceTab({ tab: 'setup' }, { ...client, hubOn: false })).toBe('sales')
    expect(resolveInvoiceTab({ tab: 'customers' }, { ...client, isClient: false })).toBe('sales')
    expect(resolveInvoiceTab({ tab: 'nonsense' }, client)).toBe('sales')
    expect(resolveInvoiceTab({}, client)).toBe('sales')
  })
  it('no company: always Expenses', () => {
    const c = { hasAccount: false, hubOn: true, isClient: true }
    expect(resolveInvoiceTab({ tab: 'sales' }, c)).toBe('expenses')
    expect(resolveInvoiceTab({ tab: 'setup' }, c)).toBe('expenses')
  })
})

describe('which tab opens when none was asked for', () => {
  it('a new client with required Setup items missing lands on Setup', () => {
    expect(resolveInvoiceTab({}, client, { hasSalesInvoices: false, setupMissing: 2 })).toBe('setup')
    expect(resolveInvoiceTab({}, client, { hasSalesInvoices: false, setupMissing: 1 })).toBe('setup')
  })
  it('a client who already invoices lands on Sales, even with no bank account', () => {
    expect(resolveInvoiceTab({}, client, { hasSalesInvoices: true, setupMissing: 2 })).toBe('sales')
  })
  it('a new client who finished Setup lands on Sales', () => {
    expect(resolveInvoiceTab({}, client, { hasSalesInvoices: false, setupMissing: 0 })).toBe('sales')
  })
  it('a tab asked for in the link always wins, and the paid link opens Expenses', () => {
    const l = { hasSalesInvoices: false, setupMissing: 2 }
    expect(resolveInvoiceTab({ tab: 'expenses' }, client, l)).toBe('expenses')
    expect(resolveInvoiceTab({ tab: 'sales' }, client, l)).toBe('sales')
    expect(resolveInvoiceTab({ view: 'paid' }, client, l)).toBe('expenses')
  })
  it('switch off, team member, or no company: never Setup', () => {
    const l = { hasSalesInvoices: false, setupMissing: 2 }
    expect(resolveInvoiceTab({}, { ...client, hubOn: false }, l)).toBe('sales')
    expect(resolveInvoiceTab({}, { ...client, isClient: false }, l)).toBe('sales')
    expect(resolveInvoiceTab({}, { hasAccount: false, hubOn: true, isClient: true }, l)).toBe('expenses')
  })
  it('without landing facts it behaves as before (Sales)', () => {
    expect(resolveInvoiceTab({}, client)).toBe('sales')
  })
})

describe('setup status', () => {
  const none = { hasLogo: false, hasBankAccount: false, hasPaymentLink: false, hasCustomerWithEmail: false }
  it('a new client is missing the two required items', () => {
    expect(missingRequiredCount(none)).toBe(2)
  })
  it('a bank account OR a payment link completes payment', () => {
    expect(setupItems({ ...none, hasBankAccount: true }).find(i => i.id === 'payment')?.done).toBe(true)
    expect(setupItems({ ...none, hasPaymentLink: true }).find(i => i.id === 'payment')?.done).toBe(true)
  })
  it('the logo is never required', () => {
    expect(setupItems(none).find(i => i.id === 'logo')?.required).toBe(false)
    expect(missingRequiredCount({ ...none, hasBankAccount: true, hasCustomerWithEmail: true })).toBe(0)
  })
})

describe('the checklist is driven by its definition, with rules owned by code', () => {
  const none = { hasLogo: false, hasBankAccount: false, hasPaymentLink: false, hasCustomerWithEmail: false }
  const items = [
    { id: 'p', rule: 'payment' as const, required: true, labelKey: 'invoices.setup.payment' },
    { id: 'c', rule: 'customer' as const, required: false, labelKey: 'invoices.setup.customer' },
  ]
  it('only the items in the definition are evaluated, in its order, with its required flags', () => {
    const r = evaluateChecklist(items, none)
    expect(r.map(i => i.id)).toEqual(['p', 'c'])
    expect(r.map(i => i.required)).toEqual([true, false])
    expect(missingRequired(r)).toBe(1)
  })
  it('a bank account OR a payment link completes the payment rule', () => {
    expect(evaluateChecklist(items, { ...none, hasPaymentLink: true })[0].done).toBe(true)
    expect(evaluateChecklist(items, { ...none, hasBankAccount: true })[0].done).toBe(true)
  })
  it('an optional item never counts as missing', () => {
    expect(missingRequired(evaluateChecklist(items, { ...none, hasBankAccount: true }))).toBe(0)
  })
})
