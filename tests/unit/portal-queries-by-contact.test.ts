/**
 * Unit tests for the contact-scoped portal query helpers added in PR 2 Step 4
 * (2026-05-05): getPortalPaymentsByContact, getPortalExpensesByContact,
 * getPortalActionItemsByContact.
 *
 * These exist so formation-gap clients (paid, no company yet) can see their
 * personal TD invoices in the portal — and so the home-page action-items
 * widget stops being silently blank for clients without an account.
 *
 * R086: every new function in lib/ gets a unit test.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ─── Capture filter calls so tests can assert on the SQL shape ───
type FilterCall = { method: 'eq' | 'is' | 'in' | 'order' | 'limit'; column: string; value: unknown }

let captured: FilterCall[] = []
let lastTable = ''
let mockData: unknown = null
/**
 * Per-table fixtures. The original harness returned the SAME `mockData` for
 * every branch of the builder's Promise.all, which made item generation
 * untestable — the file said so in a comment, and a real defect hid there:
 * a tax service for a client with no company produced a card promising a
 * "Tax Return" form they could never reach. Keyed by table name; falls back
 * to `mockData` so the existing filter-shape tests are unaffected.
 */
let mockByTable: Record<string, unknown> = {}

function dataFor(table: string): unknown {
  return table in mockByTable ? mockByTable[table] : mockData
}

function makeChain(table: string) {
  lastTable = table
  const settle = () => Promise.resolve({ data: dataFor(table), error: null })
  const chain = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn(function (this: unknown, column: string, value: unknown) {
      captured.push({ method: 'eq', column, value })
      return chain
    }),
    is: vi.fn(function (this: unknown, column: string, value: unknown) {
      captured.push({ method: 'is', column, value })
      return chain
    }),
    in: vi.fn(function (this: unknown, column: string, value: unknown) {
      captured.push({ method: 'in', column, value })
      return chain
    }),
    order: vi.fn(function (this: unknown, column: string, opts: unknown) {
      captured.push({ method: 'order', column, value: opts })
      return chain
    }),
    limit: vi.fn(function (this: unknown, n: number) {
      captured.push({ method: 'limit', column: '', value: n })
      return settle()
    }),
    maybeSingle: vi.fn(() => settle()),
    single: vi.fn(() => settle()),
    // Thenable so a query that never calls .limit() still resolves — without
    // this the builder saw `undefined` for those branches and produced nothing.
    then: (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
      settle().then(resolve, reject),
  }
  return chain
}

vi.mock('@/lib/supabase-admin', () => ({
  supabaseAdmin: {
    from: (table: string) => makeChain(table),
  },
}))

import {
  getPortalPaymentsByContact,
  getPortalExpensesByContact,
  getPortalActionItemsByContact,
} from '@/lib/portal/queries'

beforeEach(() => {
  captured = []
  lastTable = ''
  mockData = []
  mockByTable = {}
})

// ─── getPortalPaymentsByContact ────────────────────────────

describe('getPortalPaymentsByContact', () => {
  it('queries the payments table filtered by contact_id and account_id IS NULL', async () => {
    mockData = [
      { id: 'p1', invoice_number: 'INV-001', total: 100, status: 'Paid' },
    ]
    const result = await getPortalPaymentsByContact('contact-1')

    expect(lastTable).toBe('payments')
    expect(captured).toEqual(
      expect.arrayContaining([
        { method: 'eq', column: 'contact_id', value: 'contact-1' },
        { method: 'is', column: 'account_id', value: null },
      ]),
    )
    expect(result).toEqual(mockData)
  })

  it('returns empty array when no rows match', async () => {
    mockData = null
    const result = await getPortalPaymentsByContact('contact-empty')
    expect(result).toEqual([])
  })

  it('orders by due_date desc and limits to 20', async () => {
    mockData = []
    await getPortalPaymentsByContact('contact-1')
    expect(captured).toEqual(
      expect.arrayContaining([
        { method: 'order', column: 'due_date', value: { ascending: false } },
        { method: 'limit', column: '', value: 20 },
      ]),
    )
  })
})

// ─── getPortalExpensesByContact ────────────────────────────

describe('getPortalExpensesByContact', () => {
  it('queries the client_expenses table filtered by contact_id and account_id IS NULL', async () => {
    mockData = [
      { id: 'e1', vendor_name: 'TD LLC', invoice_number: 'INV-001', total: 100, status: 'Paid' },
    ]
    const result = await getPortalExpensesByContact('contact-1')

    expect(lastTable).toBe('client_expenses')
    expect(captured).toEqual(
      expect.arrayContaining([
        { method: 'eq', column: 'contact_id', value: 'contact-1' },
        { method: 'is', column: 'account_id', value: null },
      ]),
    )
    expect(result).toEqual(mockData)
  })

  it('returns empty array when no rows match', async () => {
    mockData = null
    const result = await getPortalExpensesByContact('contact-empty')
    expect(result).toEqual([])
  })

  it('orders by created_at desc and limits to 100', async () => {
    mockData = []
    await getPortalExpensesByContact('contact-1')
    expect(captured).toEqual(
      expect.arrayContaining([
        { method: 'order', column: 'created_at', value: { ascending: false } },
        { method: 'limit', column: '', value: 100 },
      ]),
    )
  })
})

// ─── getPortalActionItemsByContact ────────────────────────

describe('getPortalActionItemsByContact', () => {
  it('returns empty items + zero counts when no wizards or invoices match', async () => {
    mockData = []
    const result = await getPortalActionItemsByContact('contact-empty')
    expect(result.items).toEqual([])
    expect(result.counts).toEqual({ red: 0, orange: 0, blue: 0, total: 0 })
  })

  it('queries wizard_progress filtered by contact_id and status=in_progress', async () => {
    mockData = []
    await getPortalActionItemsByContact('contact-1')
    expect(captured).toEqual(
      expect.arrayContaining([
        { method: 'eq', column: 'status', value: 'in_progress' },
        { method: 'eq', column: 'contact_id', value: 'contact-1' },
      ]),
    )
  })

  it('queries payments filtered by contact_id, account_id IS NULL, status in (Sent, Overdue, Partial)', async () => {
    mockData = []
    await getPortalActionItemsByContact('contact-1')
    expect(captured).toEqual(
      expect.arrayContaining([
        { method: 'eq', column: 'contact_id', value: 'contact-1' },
        { method: 'is', column: 'account_id', value: null },
        { method: 'in', column: 'invoice_status', value: ['Sent', 'Overdue', 'Partial'] },
      ]),
    )
  })

  // ── The tax card for a client with no company yet ──────────────────────
  // A client who bought a tax return but has no company in the portal was
  // shown "Tax Return — start your form". They could never reach that form:
  // this builder only ever runs for a client with NO account, and
  // decideTaxWizardEligibility returns `company_info` for every accountless
  // subject, so the wizard page rewrote ?type=tax and served them a page
  // headed "Company Information". Right destination, wrong promise.
  it('names a tax service Company Information — the form a company-less client actually gets', async () => {
    mockByTable = {
      service_deliveries: [{ service_type: 'Tax Return', created_at: new Date().toISOString() }],
      wizard_progress: [],
      payments: [],
    }
    const result = await getPortalActionItemsByContact('contact-tax-no-company')
    const card = result.items.find(i => i.type === 'form')
    expect(card, 'the client must still get an entry point — suppressing the card strands them').toBeDefined()
    expect(card!.href, 'must link to the form they will actually be served').toBe('/portal/wizard?type=company_info')
    expect(card!.title).toBe('Company Information — start your form')
    expect(card!.title).not.toContain('Tax Return')
    expect(card!.titleIt).not.toContain('Dichiarazione')
  })

  it('leaves a non-tax service alone (ITIN keeps its own wizard and name)', async () => {
    mockByTable = {
      service_deliveries: [{ service_type: 'ITIN', created_at: new Date().toISOString() }],
      wizard_progress: [],
      payments: [],
    }
    const result = await getPortalActionItemsByContact('contact-itin')
    const card = result.items.find(i => i.type === 'form')
    expect(card!.href).toBe('/portal/wizard?type=itin')
    expect(card!.title).toBe('ITIN Application — start your form')
  })
})

// ─── Priority + label logic (pure helpers extracted from the body) ────

describe('Action-item priority logic', () => {
  // Mirrors the rules inside getPortalActionItemsByContact + getPortalActionItems:
  //   age > 7 days → red, > 3 days → orange, else blue
  function priorityForWizard(daysOld: number): 'red' | 'orange' | 'blue' {
    return daysOld > 7 ? 'red' : daysOld > 3 ? 'orange' : 'blue'
  }
  // Invoice priority: overdue → red, dueSoon (within 7 days) → orange, else blue
  function priorityForInvoice(args: { isOverdue: boolean; dueInDays: number | null }): 'red' | 'orange' | 'blue' {
    return args.isOverdue ? 'red' : (args.dueInDays !== null && args.dueInDays <= 7) ? 'orange' : 'blue'
  }

  it('wizard older than 7 days is red', () => {
    expect(priorityForWizard(8)).toBe('red')
    expect(priorityForWizard(30)).toBe('red')
  })
  it('wizard 4-7 days old is orange', () => {
    expect(priorityForWizard(4)).toBe('orange')
    expect(priorityForWizard(7)).toBe('orange')
  })
  it('wizard 0-3 days old is blue', () => {
    expect(priorityForWizard(0)).toBe('blue')
    expect(priorityForWizard(3)).toBe('blue')
  })
  it('overdue invoice is red regardless of due date', () => {
    expect(priorityForInvoice({ isOverdue: true, dueInDays: 100 })).toBe('red')
  })
  it('invoice due within 7 days is orange', () => {
    expect(priorityForInvoice({ isOverdue: false, dueInDays: 5 })).toBe('orange')
    expect(priorityForInvoice({ isOverdue: false, dueInDays: 7 })).toBe('orange')
  })
  it('invoice due more than 7 days out is blue', () => {
    expect(priorityForInvoice({ isOverdue: false, dueInDays: 30 })).toBe('blue')
  })
  it('invoice with no due_date is blue (when not overdue)', () => {
    expect(priorityForInvoice({ isOverdue: false, dueInDays: null })).toBe('blue')
  })
})
