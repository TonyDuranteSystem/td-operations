import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { join } from 'node:path'
import {
  APP_BILLING_TAB,
  appInvoiceAreas,
  appInvoicesScreen,
  billingRowAmount,
  billingRowState,
  checklistStepTarget,
  requiredFirst,
  tdInvoicesOf,
  type BillingExpense,
} from '@/lib/portal-app/invoices'
import { INVOICE_TABS, type InvoiceTabId } from '@/lib/portal/invoice-hub'
import { TITLE_IN_ROW_EXACT, screenTitleFor } from '@/lib/portal-app/frame'
import { AppTdBilling } from '@/components/portal/app-td-billing'
import { AppTopicButton } from '@/components/portal/chat/app-topic-button'

// Client iPhone app, Step 3c (dev job 056a70d0): Invoices list, tappable set-up steps, TD Billing, Pay.

const src = (p: string) => readFileSync(join(process.cwd(), p), 'utf8')

describe('appInvoicesScreen', () => {
  it('opens the list when no area is asked for', () => {
    expect(appInvoicesScreen({})).toBe('areas')
    expect(appInvoicesScreen({ tab: '' })).toBe('areas')
    expect(appInvoicesScreen({ view: 'something' })).toBe('areas')
  })

  it('opens TD Billing for the billing address word', () => {
    expect(APP_BILLING_TAB).toBe('billing')
    expect(appInvoicesScreen({ tab: 'billing' })).toBe('billing')
  })

  it('opens the website\'s area for every other tab, and Expenses for the payment-received link', () => {
    for (const tab of ['setup', 'customers', 'sales', 'vendors', 'expenses']) expect(appInvoicesScreen({ tab })).toBe('tab')
    expect(appInvoicesScreen({ view: 'paid' })).toBe('tab')
    expect(appInvoicesScreen({ view: 'paid', tab: 'billing' })).toBe('tab')
  })
})

describe('appInvoiceAreas', () => {
  const hub = INVOICE_TABS.map(t => ({ id: t.id, labelKey: t.labelKey }))
  const counts = { customers: 4, sales: 7, vendors: 2, expenses: 3 }

  it('lists the areas in the website\'s tab order, each with its own link', () => {
    const rows = appInvoiceAreas(hub, counts, 0)
    expect(rows.map(r => r.id)).toEqual(['setup', 'customers', 'sales', 'vendors', 'expenses'])
    expect(rows.map(r => r.href)).toEqual(['setup', 'customers', 'sales', 'vendors', 'expenses'].map(id => `/portal/invoices?tab=${id}`))
  })

  it('shows each area\'s number, and the amber badge only on Setup', () => {
    const rows = appInvoiceAreas(hub, counts, 2)
    const by = Object.fromEntries(rows.map(r => [r.id, r])) as Record<InvoiceTabId, (typeof rows)[number]>
    expect(by.customers.count).toBe(4)
    expect(by.sales.count).toBe(7)
    expect(by.vendors.count).toBe(2)
    expect(by.expenses.count).toBe(3)
    expect(by.setup.badge).toBe(2)
    for (const id of ['customers', 'sales', 'vendors', 'expenses'] as const) expect(by[id].badge).toBe(0)
  })

  it('has no badge once every required step is done, and never a negative one', () => {
    expect(appInvoiceAreas(hub, counts, 0).find(r => r.id === 'setup')?.badge).toBe(0)
    expect(appInvoiceAreas(hub, counts, -1).find(r => r.id === 'setup')?.badge).toBe(0)
  })

  it('lists only the areas it is given (a person without Setup or Customers does not see them)', () => {
    const legacy = hub.filter(t => ['sales', 'expenses', 'vendors'].includes(t.id))
    expect(appInvoiceAreas(legacy, counts, 3).map(r => r.id)).toEqual(['sales', 'vendors', 'expenses'])
    expect(appInvoiceAreas([], counts, 3)).toEqual([])
  })
})

describe('requiredFirst', () => {
  it('puts the required steps before the optional ones and keeps each group\'s own order', () => {
    const steps = [{ id: 'logo', required: false }, { id: 'payment', required: true }, { id: 'customer', required: true }, { id: 'extra', required: false }]
    expect(requiredFirst(steps).map(s => s.id)).toEqual(['payment', 'customer', 'logo', 'extra'])
  })

  it('does not change the list it is given, and copes with an empty one', () => {
    const steps = [{ id: 'a', required: false }, { id: 'b', required: true }]
    requiredFirst(steps)
    expect(steps.map(s => s.id)).toEqual(['a', 'b'])
    expect(requiredFirst([])).toEqual([])
  })
})

describe('checklistStepTarget', () => {
  const all: InvoiceTabId[] = ['setup', 'customers', 'sales', 'vendors', 'expenses']

  it('sends how-customers-pay and the logo to Setup, and the first customer to Customers', () => {
    expect(checklistStepTarget('payment', all)).toBe('/portal/invoices?tab=setup')
    expect(checklistStepTarget('logo', all)).toBe('/portal/invoices?tab=setup')
    expect(checklistStepTarget('customer', all)).toBe('/portal/invoices?tab=customers')
  })

  it('is not a link when the person cannot open that area, or the rule is unknown', () => {
    expect(checklistStepTarget('payment', ['sales', 'expenses'])).toBeNull()
    expect(checklistStepTarget('customer', ['setup', 'sales'])).toBeNull()
    expect(checklistStepTarget(undefined, all)).toBeNull()
  })
})

const inv = (over: Partial<BillingExpense> = {}): BillingExpense => ({
  id: 'e1', invoice_number: 'INV-000123', internal_ref: null, vendor_name: 'Tony Durante LLC', description: 'Annual LLC management',
  currency: 'USD', total: 100, amount_due: null, due_date: '2026-11-20', paid_date: null, status: 'Pending', source: 'td_invoice', td_payment_id: 'p1', ...over,
})

describe('tdInvoicesOf', () => {
  it('keeps only the invoices from Tony Durante LLC, in the given order', () => {
    const rows = [inv({ id: 'a' }), inv({ id: 'b', source: 'upload' }), inv({ id: 'c' }), inv({ id: 'd', source: 'manual' })]
    expect(tdInvoicesOf(rows).map(r => r.id)).toEqual(['a', 'c'])
    expect(tdInvoicesOf([])).toEqual([])
  })
})

describe('billingRowState', () => {
  it('an open invoice shows its due date and can be paid', () => {
    expect(billingRowState(inv())).toEqual({ kind: 'due', date: '2026-11-20', canPay: true })
  })

  it('an overdue invoice is flagged and can still be paid', () => {
    expect(billingRowState(inv({ status: 'Overdue' }))).toEqual({ kind: 'overdue', date: '2026-11-20', canPay: true })
  })

  it('a paid invoice shows the day it was paid and cannot be paid again', () => {
    expect(billingRowState(inv({ status: 'Paid', paid_date: '2026-10-14' }))).toEqual({ kind: 'paid', date: '2026-10-14', canPay: false })
  })

  it('a cancelled invoice and a credit note carry no date and cannot be paid', () => {
    expect(billingRowState(inv({ status: 'Cancelled' }))).toEqual({ kind: 'cancelled', date: null, canPay: false })
    expect(billingRowState(inv({ total: -25, status: 'Paid' }))).toEqual({ kind: 'credit', date: null, canPay: false })
  })

  it('a credit note is never offered Pay, even when old data left it Pending or Overdue with a payment behind it', () => {
    for (const status of ['Pending', 'Overdue']) {
      expect(billingRowState(inv({ total: -25, status, td_payment_id: 'p1' }))).toEqual({ kind: 'credit', date: null, canPay: false })
    }
  })

  it('cannot be paid without a payment behind it', () => {
    expect(billingRowState(inv({ td_payment_id: null })).canPay).toBe(false)
  })

  // The website's list offers Pay by one rule (components/portal/expense-list.tsx before Step 3c); the app's rows agree with it exactly,
  // except that a credit note (negative total) is never offered Pay in the app.
  const oldPayRule = (e: { source: string; td_payment_id: string | null; status: string }) =>
    e.source === 'td_invoice' && !!e.td_payment_id && (e.status === 'Pending' || e.status === 'Overdue')

  it('offers Pay exactly when the website\'s list does, over every combination', () => {
    let checked = 0
    for (const source of ['td_invoice', 'upload', 'manual']) {
      for (const td_payment_id of [null, 'p1']) {
        for (const status of ['Pending', 'Overdue', 'Paid', 'Cancelled', 'Delinquent', 'Waived', '']) {
          for (const total of [100, 0, -5]) {
            const e = inv({ source, td_payment_id, status, total })
            const expected = total >= 0 && oldPayRule(e)
            expect(billingRowState(e).canPay, JSON.stringify({ source, td_payment_id, status, total })).toBe(expected)
            checked++
          }
        }
      }
    }
    expect(checked).toBe(3 * 2 * 7 * 3)
  })
})

describe('billingRowAmount', () => {
  it('an open invoice shows what is still to pay: the balance left on a part-paid one, else the whole total', () => {
    expect(billingRowAmount({ status: 'Pending', total: 100, amount_due: 40 })).toBe(40)
    expect(billingRowAmount({ status: 'Overdue', total: 100, amount_due: null })).toBe(100)
    expect(billingRowAmount({ status: 'Pending', total: 100 })).toBe(100)
  })

  it('an open invoice with a zero balance on file shows its total, never $0.00 next to a Pay button', () => {
    expect(billingRowAmount({ status: 'Pending', total: 100, amount_due: 0 })).toBe(100)
    expect(billingRowAmount({ status: 'Overdue', total: 80, amount_due: 0 })).toBe(80)
  })

  it('a paid, cancelled or credit row shows the invoice total, never $0.00 left to pay', () => {
    expect(billingRowAmount({ status: 'Paid', total: 250, amount_due: 0 })).toBe(250)
    expect(billingRowAmount({ status: 'Cancelled', total: 75, amount_due: 0 })).toBe(75)
    expect(billingRowAmount({ status: 'Paid', total: -25, amount_due: 0 })).toBe(-25)
  })
})

describe('the top row names the Invoices screens', () => {
  const items = [
    { key: 'nav.invoices', path: '/portal/invoices', label: 'Invoices' },
    { key: 'nav.tdBilling', path: '/portal/billing', label: 'TD Billing' },
    { key: 'nav.chat', path: '/portal/chat', label: 'Chat' },
  ]

  it('says Invoices on the list and on its areas, and TD Billing on the billing screen', () => {
    expect(TITLE_IN_ROW_EXACT).toContain('/portal/invoices')
    expect(screenTitleFor('/portal/invoices', items)).toBe('Invoices')
    expect(screenTitleFor('/portal/invoices', items, 'sales')).toBe('Invoices')
    expect(screenTitleFor('/portal/invoices', items, 'billing')).toBe('TD Billing')
  })

  it('names the Invoices screen plainly even when the menu entry says Customers & Invoices', () => {
    const hubItems = [{ key: 'nav.invoices', path: '/portal/invoices', label: 'Customers & Invoices' }, { key: 'nav.tdBilling', path: '/portal/billing', label: 'TD Billing' }]
    expect(screenTitleFor('/portal/invoices', hubItems, null, 'Invoices')).toBe('Invoices')
    expect(screenTitleFor('/portal/invoices', hubItems, 'customers', 'Invoices')).toBe('Invoices')
    expect(screenTitleFor('/portal/invoices', hubItems, 'billing', 'Invoices')).toBe('TD Billing')
    expect(screenTitleFor('/portal/invoices/new', hubItems, null, 'Invoices')).toBeNull()
  })

  it('names nothing on the pages under Invoices, which draw their own heading', () => {
    expect(screenTitleFor('/portal/invoices/new', items)).toBeNull()
    expect(screenTitleFor('/portal/invoices/abc-123', items, 'billing')).toBeNull()
  })

  it('falls back to Invoices when the person has no TD Billing entry, and Chat is unchanged', () => {
    expect(screenTitleFor('/portal/invoices', items.filter(i => i.key !== 'nav.tdBilling'), 'billing')).toBe('Invoices')
    expect(screenTitleFor('/portal/chat', items)).toBe('Chat')
  })
})


// The screens drawn for real (server-side), so these fail if the behaviour is wrong, not only if the source text changes.
describe('TD Billing screen, rendered', () => {
  const totals = { pending: '$100.00', paid: '$250.00', total: '$350.00' }
  const html = (rows: BillingExpense[], payEnabled = true) => renderToStaticMarkup(createElement(AppTdBilling, { rows, totals, payEnabled }))
  const rowHtml = (h: string, number: string) => h.slice(h.indexOf(`data-testid="app-billing-row-${number}"`)).split('data-testid="app-billing-row-')[1] ?? ''

  it('offers Pay on an open invoice and shows the balance and the due date', () => {
    const h = html([inv({ amount_due: 40, total: 100 })])
    expect(h).toContain('aria-label="Pay invoice INV-000123"')
    expect(h).toContain('$40.00')
    expect(h).toContain('Due Nov 20')
  })

  it('offers no Pay on a paid, cancelled or credit row, and shows the invoice total on them', () => {
    const h = html([
      inv({ id: 'p', invoice_number: 'INV-P', status: 'Paid', paid_date: '2026-10-14', total: 250, amount_due: 0 }),
      inv({ id: 'c', invoice_number: 'INV-C', status: 'Cancelled', total: 75, amount_due: 0 }),
      inv({ id: 'k', invoice_number: 'INV-K', status: 'Pending', total: -25 }),
    ])
    expect(h).not.toContain('aria-label="Pay invoice')
    expect(h).toContain('$250.00')
    expect(h).toContain('Paid Oct 14')
    expect(h).toContain('Cancelled')
    expect(h).toContain('Credit')
    expect(h).not.toMatch(/\$0\.00/)
  })

  it('with the Pay switch off nothing can be tapped to pay, but every invoice is still listed with its tag', () => {
    const h = html([inv(), inv({ id: 'e2', invoice_number: 'INV-2', status: 'Overdue' })], false)
    expect(h).not.toContain('aria-label="Pay invoice')
    expect(h).not.toContain('<button')
    expect(h).toContain('INV-000123')
    expect(h).toContain('INV-2')
    expect(h).toContain('Due Nov 20')
    expect(h).toContain('Overdue Nov 20')
  })

  it('shows the three totals, one currency per line, and an empty message with no invoices', () => {
    const h = renderToStaticMarkup(createElement(AppTdBilling, { rows: [], totals: { pending: '$10.00 · €5.00', paid: '$0.00', total: '$10.00 · €5.00' }, payEnabled: true }))
    expect(h).toContain('data-testid="app-billing-empty"')
    expect(h).toContain('<div>$10.00</div><div>€5.00</div>')
  })

  it('writes an invoice with no description or number plainly, and keeps the row of one invoice to itself', () => {
    const h = html([inv({ description: null, invoice_number: null, internal_ref: null, vendor_name: 'Tony Durante LLC' })])
    expect(h).toContain('Tony Durante LLC')
    expect(h).toContain('—')
    expect(rowHtml(html([inv({ id: 'a', invoice_number: 'INV-A' }), inv({ id: 'b', invoice_number: 'INV-B', status: 'Paid' })]), 'INV-B')).not.toContain('Pay invoice')
  })
})

describe('Topic button, rendered', () => {
  it('writes a topic name that contains $ signs exactly as typed', () => {
    const h = renderToStaticMarkup(createElement(AppTopicButton, { activeTopic: 'Fees $& $1 $$', topicOrder: ['Fees $& $1 $$'], unreadByTopic: {}, onChoose: () => {} }))
    expect(h).toContain('Topic: Fees $&amp; $1 $$')
  })
})

describe('wiring (source guards)', () => {
  const page = src('app/portal/invoices/page.tsx')

  it('the page changes only behind the app marker: the website keeps the tab row, the title and every area', () => {
    expect(page).toContain('const appMode = getClientAppMode()')
    expect(page).toContain("const appScreen = appMode ? appInvoicesScreen(params) : 'tab'")
    expect(page).toContain("const showTab = appScreen === 'tab'")
    expect(page).toContain('requiredFirst(checklist)')
    expect(page).toContain('{selectedAccountId && !appMode && (')
    expect(page).toContain('{!appMode && (\n        <div>\n          <h1 data-tour="hub-title"')
    for (const tab of ['sales', 'expenses', 'customers', 'setup', 'vendors']) expect(page, tab).toContain(`{showTab && activeTab === '${tab}'`)
  })

  it('the tour and its banner are not offered in the app (the tab row they point at is not there)', () => {
    expect(page).toContain('&& !appMode && shouldOfferTour(tourPref, guides.tour) && (\n        <TourBanner')
    expect(page).toContain('{isClientHub && guides && !appMode && (\n          <GuidedTour')
  })

  it('Pay follows the app\'s Pay switch only in the app', () => {
    expect(page).toContain('const appPayHidden = appMode ? !(await isClientAppPayEnabled()) : false')
    expect(page).toContain('hidePay={appPayHidden}')
    const list = src('components/portal/expense-list.tsx')
    expect(list).toContain('hidePay = false')
    expect(list).toContain('{!hidePay && exp.source ===')
  })

  it('the app\'s Pay switch also hides the autopay card on the Expenses area, and never on the website', () => {
    expect(page).toContain('{selectedAccountId && showAutopayCard && !appPayHidden && (')
    expect(page).toContain("const appPayHidden = appMode ? !(await isClientAppPayEnabled()) : false")
  })

  it('a company name with $ signs is not mangled by the subtitle fill', () => {
    expect(page).toContain(".replace('{company}', () => companyName)")
  })

  it('the Pay Now button unlocks when the phone brings the screen back from its page cache', () => {
    const modal = src('components/portal/td-pay-modal.tsx')
    expect(modal).toContain("window.addEventListener('pageshow', onShow)")
    expect(modal).toContain('if (e.persisted) setStripeLoading(false)')
    expect(modal).not.toContain('would be refused')
  })

  it('only the fields TD Billing shows are sent to the browser (no attachment links)', () => {
    const start = page.indexOf('const billingRows')
    const block = page.slice(start, page.indexOf('const billingTotals'))
    expect(block).toContain('td_payment_id: e.td_payment_id')
    expect(block).not.toContain('attachment')
  })

  it('Pay Now stays in the app window inside the app and opens a new tab on the website', () => {
    const modal = src('components/portal/td-pay-modal.tsx')
    expect(modal).toContain('const appMode = useAppMode()')
    expect(modal).toContain('window.location.assign(data.checkoutUrl)')
    expect(modal).toContain("window.open(data.checkoutUrl, '_blank', 'noopener,noreferrer')")
    expect(modal).toContain('if (!leaving) setStripeLoading(false)')
  })

  it('the billing page goes to the app\'s TD Billing screen only in the app', () => {
    const billing = src('app/portal/billing/page.tsx')
    expect(billing).toContain('getClientAppMode() ? `/portal/invoices?tab=' + '$' + '{APP_BILLING_TAB}` : \'/portal/invoices?tab=expenses\'')
  })

  it('the frame reads the address word inside Suspense so the build never trips on it', () => {
    const layout = src('app/portal/layout.tsx')
    expect((layout.match(/<Suspense fallback=\{null\}><ClientAppFrame /g) ?? []).length).toBe(2)
    expect(src('components/portal/client-app-frame.tsx')).toContain("useSearchParams()?.get('tab')")
    expect(src('components/portal/client-app-frame.tsx')).toContain("screenTitleFor(pathname, me?.items ?? [], tab, t('nav.invoices'))")
  })
})
