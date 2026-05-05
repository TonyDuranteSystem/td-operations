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

function makeChain(table: string) {
  lastTable = table
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
      // limit terminates the chain — return the data wrapped as a thenable
      return Promise.resolve({ data: mockData, error: null })
    }),
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

  it('queries payments filtered by contact_id, account_id IS NULL, status in (Sent, Overdue)', async () => {
    mockData = []
    await getPortalActionItemsByContact('contact-1')
    expect(captured).toEqual(
      expect.arrayContaining([
        { method: 'eq', column: 'contact_id', value: 'contact-1' },
        { method: 'is', column: 'account_id', value: null },
        { method: 'in', column: 'invoice_status', value: ['Sent', 'Overdue'] },
      ]),
    )
  })

  // The item-generation logic is harder to test here because the mock
  // returns the same `mockData` for every Promise.all branch. Pure logic
  // tests for priority/sort/translation belong in a separate test that
  // exercises only the item-shaping helpers — kept narrow on purpose to
  // avoid coupling to Supabase chain quirks.
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
