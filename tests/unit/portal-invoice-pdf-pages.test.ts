/**
 * The invoice PDF used to draw everything on ONE page, so a long invoice lost its totals and bank details off the
 * bottom edge without any error. dev job 1a23f5f1.
 */
import { describe, it, expect, vi } from 'vitest'
import { PDFDocument } from 'pdf-lib'
import { makeFakeDb, hasOp, type Call } from './helpers/fake-supabase'

let fake = makeFakeDb(() => undefined)
vi.mock('@/lib/supabase-admin', () => ({ supabaseAdmin: { from: (t: string) => fake.db.from(t) } }))

import { renderInvoicePdf } from '@/lib/portal/invoice-pdf'

const lines = (n: number) => Array.from({ length: n }, (_, i) => ({ description: `Line item number ${i + 1} with a description long enough to take a little room on the page`, quantity: 1, unit_price: 10, amount: 10, tax_rate: 0, tax_amount: 0, sort_order: i }))

function dbFor(itemCount: number, extra: { bank?: boolean; link?: string | null } = {}) {
  return (c: Call) => {
    if (c.table === 'client_customers') return { data: { name: 'Marco Rossi', email: 'm@rossi.it', address: null, vat_number: null } }
    if (c.table === 'client_invoice_items') return { data: lines(itemCount) }
    if (c.table === 'accounts') return { data: { company_name: 'Acme LLC', invoice_logo_url: null, physical_address: null, suite_number: null, ein_number: '12-3456789', state_of_formation: 'Delaware', mailing_address: null } }
    if (c.table === 'payment_links') return { data: extra.link === null ? [] : [{ url: extra.link ?? 'https://buy.stripe.com/abc123', is_default: true, created_at: '2026-01-01' }] }
    if (c.table === 'client_bank_accounts') return { data: extra.bank === false ? null : { label: 'Main', account_holder: 'Acme', bank_name: 'QA Bank', iban: 'US00QA', notes: null } }
    return { data: null }
  }
}
const invoice = { id: 'inv', account_id: 'acc', customer_id: 'cust', contact_id: null, invoice_number: 'INV-1', status: 'Sent', currency: 'USD', issue_date: '2026-10-01', due_date: '2026-10-31', subtotal: 100, discount: 0, tax_total: 0, total: 100, amount_paid: 0, amount_due: 100, message: 'Pay soon', bank_account_id: 'bank-1' }

describe('renderInvoicePdf pagination', () => {
  it('a short invoice stays on one page', async () => {
    fake = makeFakeDb(dbFor(3))
    const doc = await PDFDocument.load(await renderInvoicePdf({ invoice, shownStatus: 'Sent' }))
    expect(doc.getPageCount()).toBe(1)
  })
  it('a long invoice continues on more pages instead of drawing off the page', async () => {
    fake = makeFakeDb(dbFor(60))
    const doc = await PDFDocument.load(await renderInvoicePdf({ invoice, shownStatus: 'Sent' }))
    expect(doc.getPageCount()).toBeGreaterThan(1)
  })
  it("reads the bank account only from this invoice's own company", async () => {
    fake = makeFakeDb(dbFor(3))
    await renderInvoicePdf({ invoice, shownStatus: 'Sent' })
    const bank = fake.calls.find(c => c.table === 'client_bank_accounts')!
    expect(hasOp(bank, 'eq', 'account_id', 'acc')).toBe(true)
  })
  it('the customer is looked up inside the same company too', async () => {
    fake = makeFakeDb(dbFor(3))
    await renderInvoicePdf({ invoice, shownStatus: 'Sent' })
    const cust = fake.calls.find(c => c.table === 'client_customers')!
    expect(hasOp(cust, 'eq', 'account_id', 'acc')).toBe(true)
  })
})
