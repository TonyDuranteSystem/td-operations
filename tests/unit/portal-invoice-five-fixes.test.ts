/**
 * The five fixes from the 10 Oct 2026 production QA of client invoicing (dev job 1a23f5f1):
 * 1 euro invoice picked the dollar bank account, 2 totals row mixed € and $, 3 customer edit could blank both names,
 * 4 Duplicate dropped the due date, 5 English text on Italian screens.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { NextRequest } from 'next/server'
import { makeFakeDb, type Call } from './helpers/fake-supabase'
import { pickBankAccountId, bankCurrencyNote } from '@/lib/portal/bank-account-choice'
import { formatMoneyMap, zeroCurrencyFor } from '@/lib/portal/invoice-totals'
import { t } from '@/lib/portal/i18n'

let fake = makeFakeDb(() => undefined)
const createUnifiedInvoice = vi.hoisted(() => vi.fn(async () => ({ invoiceId: 'dup-1', invoiceNumber: 'INV-9' })))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/lib/supabase-admin', () => ({ supabaseAdmin: { from: (t: string) => fake.db.from(t) } }))
vi.mock('@/lib/supabase/server', () => ({ createClient: () => ({ auth: { getUser: async () => ({ data: { user: { id: 'u', app_metadata: { role: 'client' } } } }) } }) }))
vi.mock('@/lib/portal/team/gate', () => ({ canAccessAccount: vi.fn(async () => true) }))
vi.mock('@/lib/portal/invoice-access', () => ({
  authorizeInvoice: vi.fn(async () => ({ accountId: 'acc' })),
  authorizeAccount: vi.fn(async () => ({ accountId: 'acc' })),
  belongsToAccount: vi.fn(async () => true),
  actorLabel: () => 'test',
}))
vi.mock('@/lib/portal/unified-invoice', () => ({ createUnifiedInvoice }))
vi.mock('@/lib/portal/office-hours', () => ({ getOfficeDateString: () => '2026-10-16' }))
vi.mock('@/lib/server-action', () => ({
  safeAction: async (fn: () => Promise<unknown>) => { try { return { success: true, data: await fn() } } catch (e) { return { success: false, error: (e as Error).message } } },
}))

import { PATCH as patchCustomer } from '@/app/api/portal/customers/[id]/route'
import { duplicateInvoice } from '@/app/portal/invoices/actions'

const json = (method: string, url: string, body: unknown) => new NextRequest(url, { method, body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })
const ctx = { params: Promise.resolve({ id: 'c1' }) }

describe('1. the default bank account follows the invoice currency', () => {
  const usd = { id: 'usd', currency: 'USD', show_on_invoice: true }
  const eur = { id: 'eur', currency: 'EUR', show_on_invoice: false }
  const eur2 = { id: 'eur2', currency: 'EUR', show_on_invoice: true }
  it('a euro invoice takes the euro account even though the dollar one is flagged', () => {
    expect(pickBankAccountId([usd, eur], 'EUR')).toBe('eur')
    expect(pickBankAccountId([usd, eur], 'USD')).toBe('usd')
  })
  it('among several in the right currency the flagged one wins', () => {
    expect(pickBankAccountId([usd, eur, eur2], 'EUR')).toBe('eur2')
  })
  it('with none in that currency it falls back to the flagged one, then the first, and to null with no accounts', () => {
    expect(pickBankAccountId([usd, { id: 'usd2', currency: 'USD' }], 'EUR')).toBe('usd')
    expect(pickBankAccountId([{ id: 'a', currency: 'USD' }, { id: 'b', currency: 'USD' }], 'EUR')).toBe('a')
    expect(pickBankAccountId([], 'EUR')).toBeNull()
  })
  it('warns when the chosen account is in another currency, and says whether a matching one exists', () => {
    expect(bankCurrencyNote([usd, eur], 'usd', 'EUR')).toBe('mismatch')
    expect(bankCurrencyNote([usd], 'usd', 'EUR')).toBe('no_match')
    expect(bankCurrencyNote([usd, eur], 'eur', 'EUR')).toBe('none')
    expect(bankCurrencyNote([usd], '', 'EUR')).toBe('none')
    expect(bankCurrencyNote([usd], 'ghost', 'EUR')).toBe('none')
  })
  it('the form uses the rule on load and on every currency change, but never overrides the client own choice', () => {
    const form = readFileSync('components/portal/invoice-form.tsx', 'utf8')
    expect(form).toContain('pickBankAccountId(list, currency)')
    expect(form).toMatch(/if \(mode !== 'create' \|\| bankChosenByClient \|\| bankAccounts\.length === 0\) return/)
    expect(form).toContain('setBankChosenByClient(true)')
    expect(form).toContain('data-testid="invoice-bank-currency-note"')
  })
})

describe('2. an empty total shows a zero in the currency of the others', () => {
  it('euro-only company sees €0.00, not $0.00', () => {
    const z = zeroCurrencyFor({ EUR: 190 }, { EUR: 190 }, {})
    expect(z).toBe('EUR')
    expect(formatMoneyMap({}, z)).toBe('€0.00')
    expect(formatMoneyMap({ EUR: 190 }, z)).toBe('€190.00')
  })
  it('dollars, mixed currencies or nothing at all keep the dollar zero', () => {
    expect(zeroCurrencyFor({ USD: 5 }, {}, {})).toBe('USD')
    expect(zeroCurrencyFor({ USD: 5, EUR: 7 }, {}, {})).toBe('USD')
    expect(zeroCurrencyFor({}, {}, {})).toBe('USD')
    expect(formatMoneyMap({})).toBe('$0.00')
  })
})

describe('3. editing a customer cannot leave it with no first name and no company', () => {
  const answer = (row: Record<string, unknown>) => makeFakeDb((c: Call) => (c.ops.some(o => o.m === 'single') ? { data: row } : { data: null }))
  beforeEach(() => { fake = answer({ account_id: 'acc', first_name: 'Marco', last_name: 'Rossi', company_name: null }) })
  it('blanking both is refused and nothing is written', async () => {
    const res = await patchCustomer(json('PATCH', 'http://x/api/portal/customers/c1', { first_name: '', company_name: '' }), ctx)
    expect(res.status).toBe(400)
    expect((await res.json()).error).toMatch(/first name or a company name/i)
    expect(fake.writes().length).toBe(0)
  })
  it('changing one of them, or only the phone, still works', async () => {
    expect((await patchCustomer(json('PATCH', 'http://x/api/portal/customers/c1', { first_name: 'Mario' }), ctx)).status).toBe(200)
    expect((await patchCustomer(json('PATCH', 'http://x/api/portal/customers/c1', { phone: '+39 02 1' }), ctx)).status).toBe(200)
    expect((await patchCustomer(json('PATCH', 'http://x/api/portal/customers/c1', { first_name: '', company_name: 'Rossi SRL' }), ctx)).status).toBe(200)
  })
  it('an older customer that only ever had a last name can still be edited', async () => {
    fake = answer({ account_id: 'acc', first_name: null, last_name: 'Final', company_name: null })
    expect((await patchCustomer(json('PATCH', 'http://x/api/portal/customers/c1', { first_name: '', company_name: '', phone: '1' }), ctx)).status).toBe(200)
  })
})

describe('4. Duplicate keeps the number of days to pay', () => {
  const src = (issue: string | null, due: string | null) => makeFakeDb(() => ({
    data: { id: 'src', customer_id: 'cust', currency: 'EUR', discount: 0, bank_account_id: 'b', notes: null, message: null, issue_date: issue, due_date: due, client_invoice_items: [{ description: 'x', unit_price: 1, quantity: 1, tax_rate: null }] },
  }))
  beforeEach(() => { createUnifiedInvoice.mockClear() })
  it('Net 14 stays Net 14, counted from today', async () => {
    fake = src('2026-09-01', '2026-09-15')
    const res = await duplicateInvoice('src')
    expect(res.success).toBe(true)
    expect(createUnifiedInvoice).toHaveBeenCalledWith(expect.objectContaining({ issue_date: '2026-10-16', due_date: '2026-10-30' }))
  })
  it('no due date, or a nonsense one before the issue date, gives no due date', async () => {
    fake = src('2026-09-01', null)
    await duplicateInvoice('src')
    expect(createUnifiedInvoice).toHaveBeenLastCalledWith(expect.objectContaining({ due_date: undefined }))
    fake = src('2026-09-10', '2026-09-01')
    await duplicateInvoice('src')
    expect(createUnifiedInvoice).toHaveBeenLastCalledWith(expect.objectContaining({ due_date: undefined }))
  })
  it('due on the issue day (0 days) is kept as today', async () => {
    fake = src('2026-09-01', '2026-09-01')
    await duplicateInvoice('src')
    expect(createUnifiedInvoice).toHaveBeenLastCalledWith(expect.objectContaining({ due_date: '2026-10-16' }))
  })
})

describe('5. the visible English text is translated', () => {
  const files = ['app/portal/invoices/[id]/page.tsx', 'components/portal/invoice-form.tsx', 'components/portal/new-customer-form.tsx', 'components/portal/logo-upload.tsx']
  const keys = new Set<string>()
  for (const f of files) for (const m of readFileSync(f, 'utf8').matchAll(/t\('((?:invDetail|invForm|custForm)\.[A-Za-z]+)'\)/g)) keys.add(m[1])
  it('every new key used on those screens exists in English and in Italian', () => {
    expect(keys.size).toBeGreaterThan(40)
    for (const k of keys) {
      expect(t(k, 'en'), k).not.toBe(k)
      expect(t(k, 'it'), k).not.toBe(k)
    }
  })
  it('Italian differs from English for the buttons and messages a client reads most', () => {
    for (const k of ['invDetail.duplicate', 'invDetail.partialPayment', 'invDetail.recordPayment', 'invDetail.voidTitle', 'invDetail.sent', 'invForm.created', 'custForm.title', 'custForm.create']) {
      expect(t(k, 'it'), k).not.toBe(t(k, 'en'))
    }
    expect(t('invDetail.sent', 'it')).toContain('{email}')
    expect(t('invDetail.voidButton', 'it')).not.toBe(t('invDetail.goBack', 'it'))
    expect(t('logo.formats', 'it')).toBe('JPEG o PNG — max 2MB')
  })
  it('the invoice page no longer hard-codes the English words the QA found', () => {
    const page = readFileSync('app/portal/invoices/[id]/page.tsx', 'utf8')
    for (const w of ["'PDF downloaded'", '>Partial Payment<', "'Failed to void'", '>Record Payment<', '>Amount received<', "'Enter a valid amount'"]) expect(page).not.toContain(w)
    expect(page).not.toMatch(/^\s+Duplicate\s*$/m)
    expect(page).not.toMatch(/^\s+Void\s*$/m)
    const form = readFileSync('components/portal/new-customer-form.tsx', 'utf8')
    expect(form).not.toContain('label="First Name"')
  })
})
