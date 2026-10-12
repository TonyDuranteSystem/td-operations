/**
 * "Custom" repeat schedule for a client's sales invoice: the client says how many months between invoices
 * (Antonio 2026-10-12, dev job 1a23f5f1, after Lead Lift LLC asked for 6 and 8 month options).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { makeFakeDb, opArgs } from './helpers/fake-supabase'
import { nextRecurringDate, monthsBetweenCycles, isValidCustomMonths, CUSTOM_MONTHS_MIN, CUSTOM_MONTHS_MAX } from '@/lib/portal/recurring-date'
import { createInvoiceSchema } from '@/lib/schemas/portal-invoice'
import { t } from '@/lib/portal/i18n'

let fake = makeFakeDb(() => undefined)
vi.mock('@/lib/supabase-admin', () => ({ supabaseAdmin: { from: (t: string) => fake.db.from(t) } }))
vi.mock('@/lib/cron-log', () => ({ logCron: vi.fn() }))
vi.mock('@/lib/portal/notifications', () => ({ createPortalNotification: vi.fn(async () => undefined) }))
vi.mock('@/lib/portal/office-hours', () => ({ getOfficeDateString: () => '2026-10-31' }))
const createUnifiedInvoice = vi.hoisted(() => vi.fn(async () => ({ invoiceId: 'copy-1', invoiceNumber: 'INV-2' })))
vi.mock('@/lib/portal/unified-invoice', () => ({ createUnifiedInvoice }))

import { GET } from '@/app/api/cron/portal-recurring-invoices/route'

describe('the date math', () => {
  it('every 6 and every 8 months (what Lead Lift asked for)', () => {
    expect(nextRecurringDate('2026-10-12', 'custom', undefined, 6)).toBe('2027-04-12')
    expect(nextRecurringDate('2026-10-12', 'custom', undefined, 8)).toBe('2027-06-12')
  })
  it('crosses a year and clamps to a short month without drifting', () => {
    expect(nextRecurringDate('2026-12-15', 'custom', undefined, 2)).toBe('2027-02-15')
    expect(nextRecurringDate('2026-08-31', 'custom', 31, 6)).toBe('2027-02-28')
    expect(nextRecurringDate('2027-02-28', 'custom', 31, 6)).toBe('2027-08-31')
  })
  it('refuses a custom schedule without a valid number of months (no silent default)', () => {
    for (const bad of [0, -1, 37, 1.5, NaN, null, undefined]) {
      expect(nextRecurringDate('2026-10-12', 'custom', undefined, bad as number | null | undefined)).toBeNull()
    }
    expect(CUSTOM_MONTHS_MIN).toBe(1)
    expect(CUSTOM_MONTHS_MAX).toBe(36)
    expect(isValidCustomMonths(36)).toBe(true)
    expect(isValidCustomMonths(37)).toBe(false)
  })
  it('the old three choices are unchanged and ignore any stray number', () => {
    expect(nextRecurringDate('2026-10-12', 'monthly', undefined, 6)).toBe('2026-11-12')
    expect(nextRecurringDate('2026-10-12', 'quarterly')).toBe('2027-01-12')
    expect(nextRecurringDate('2026-10-12', 'yearly')).toBe('2027-10-12')
    expect(monthsBetweenCycles('quarterly')).toBe(3)
  })
})

describe('the form data check', () => {
  const base = {
    account_id: '30c2cd96-03e4-43cf-9536-81d961b18b1d', customer_id: '3dbabf87-783c-4211-a679-25116cbb94bc', currency: 'EUR' as const,
    issue_date: '2026-10-12', items: [{ description: 'x', quantity: 1, unit_price: 10, amount: 10, sort_order: 0 }],
  }
  it('accepts custom with 1 to 36 whole months', () => {
    expect(createInvoiceSchema.safeParse({ ...base, recurring_frequency: 'custom', recurring_interval_months: 6 }).success).toBe(true)
    expect(createInvoiceSchema.safeParse({ ...base, recurring_frequency: 'custom', recurring_interval_months: 36 }).success).toBe(true)
  })
  it('refuses custom without months, or with 0, 37 or a fraction', () => {
    expect(createInvoiceSchema.safeParse({ ...base, recurring_frequency: 'custom' }).success).toBe(false)
    for (const n of [0, 37, 2.5]) {
      expect(createInvoiceSchema.safeParse({ ...base, recurring_frequency: 'custom', recurring_interval_months: n }).success).toBe(false)
    }
  })
  it('refuses a number of months on a schedule that is not custom', () => {
    expect(createInvoiceSchema.safeParse({ ...base, recurring_frequency: 'monthly', recurring_interval_months: 6 }).success).toBe(false)
    expect(createInvoiceSchema.safeParse({ ...base, recurring_interval_months: 6 }).success).toBe(false)
    expect(createInvoiceSchema.safeParse({ ...base, recurring_frequency: 'monthly' }).success).toBe(true)
    expect(createInvoiceSchema.safeParse(base).success).toBe(true)
  })
})

describe('the daily job', () => {
  beforeEach(() => { process.env.CRON_SECRET = 'sekret'; createUnifiedInvoice.mockClear() })
  const req = () => new Request('http://x/api/cron/portal-recurring-invoices', { headers: { authorization: 'Bearer sekret' } })
  const template = {
    id: 'tpl-9', account_id: 'acc', contact_id: null, customer_id: 'cust', invoice_number: 'INV-9', currency: 'EUR',
    issue_date: '2026-01-31', due_date: '2026-02-15', recurring_frequency: 'custom', recurring_interval_months: 6,
    recurring_next_date: '2026-10-31', recurring_end_date: null, discount: 0, bank_account_id: null, notes: null, message: null,
    client_invoice_items: [{ description: 'Retainer', quantity: 1, unit_price: 500, tax_rate: null }],
  }
  const dbFor = (tpl: Record<string, unknown>) => makeFakeDb(c => {
    if (c.ops.some(o => o.m === 'select' && String(o.args[0]).includes('client_invoice_items'))) return { data: [tpl] }
    if (c.ops.some(o => o.m === 'update')) return { data: [{ id: tpl.id }] }
    return { data: [] }
  })

  it('a custom 6-month invoice makes its copy and moves the date 6 months on (anchored on the 31st)', async () => {
    fake = dbFor(template)
    expect(await (await GET(req())).json()).toEqual({ generated: 1, checked: 1, failed: 0 })
    const upd = fake.calls.find(c => c.ops.some(o => o.m === 'update'))!
    expect(opArgs(upd, 'update')![0]).toEqual({ recurring_next_date: '2027-04-30' })
  })
  it('a custom schedule that lost its number of months is reported as a failure and not advanced', async () => {
    fake = dbFor({ ...template, recurring_interval_months: null })
    expect(await (await GET(req())).json()).toEqual({ generated: 0, checked: 1, failed: 1 })
    expect(fake.calls.some(c => c.ops.some(o => o.m === 'update'))).toBe(false)
  })
})

describe('the screen and the save path', () => {
  const form = readFileSync('components/portal/invoice-form.tsx', 'utf8')
  const create = readFileSync('lib/portal/unified-invoice.ts', 'utf8')
  const action = readFileSync('app/portal/invoices/actions.ts', 'utf8')
  const cron = readFileSync('app/api/cron/portal-recurring-invoices/route.ts', 'utf8')
  it('the menu has a Custom choice with a months box and a preview of the next date, not shown on edit', () => {
    expect(form).toContain('<option value="custom">{t(\'invoices.custom\')}</option>')
    expect(form).toContain('data-testid="invoice-recurring-custom"')
    expect(form).toContain('data-testid="invoice-recurring-custom-next"')
    expect(form).toMatch(/mode === 'create' && <div[^>]*data-testid="invoice-recurring"/)
  })
  it('the number of months is sent, saved and used by the daily job', () => {
    expect(form).toContain("recurring_interval_months: recurringFrequency === 'custom' ? customMonthsNumber : null")
    expect(action).toContain("recurring_interval_months: recurring_frequency === 'custom'")
    expect(create).toContain("recurring_interval_months: recurring_frequency === 'custom'")
    expect(cron).toContain('nextRecurringDate(cycleDate, frequency, anchor, interval)')
  })
  it('English and Italian wording exist', () => {
    expect(t('invoices.custom', 'en')).toBe('Custom')
    expect(t('invoices.custom', 'it')).toBe('Personalizzato')
    expect(t('invoices.customEvery', 'it')).toBe('Ripeti ogni')
    expect(t('invoices.customNext', 'en')).toContain('{date}')
    expect(t('invoices.customInvalid', 'it')).toMatch(/1 e 36/)
  })
})
