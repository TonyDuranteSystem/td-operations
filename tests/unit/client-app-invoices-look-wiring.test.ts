import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const src = (p: string) => readFileSync(join(__dirname, '..', '..', p), 'utf8')

describe('Invoices in the app: the gray look is app-only, the website keeps its pages', () => {
  const page = src('app/portal/invoices/page.tsx')

  it('the website\'s three number cards on Sales are drawn only outside the app', () => {
    const at = page.indexOf("{/* Stats (the app shows these numbers on its Invoices home instead) */}")
    expect(at).toBeGreaterThan(0)
    expect(page.slice(at, at + 160)).toContain('{!appMode && (')
  })

  it('the compact lists are switched on by the app flag only', () => {
    expect(page).toContain('<InvoiceList invoices={mapped} compact={appMode} />')
    expect(page).toContain('compact={appMode}')
    expect(src('components/portal/invoice-list.tsx')).toContain('compact = false')
    expect(src('components/portal/expense-list.tsx')).toContain('compact = false')
  })

  it('the old wide header buttons stay on the website; the app gets one round button in the area header', () => {
    expect(page).toContain("showTab && !appMode && activeTab === 'sales' && selectedAccountId")
    expect(page).toContain("showTab && !appMode && activeTab === 'expenses' && selectedAccountId")
    expect(page).toContain('data-testid="app-area-new"')
    expect(page).toContain('<ExpensesHeader accountId={selectedAccountId} vendors={vendors} round />')
  })

  it('the gear opens the Setup area and only for a person who may open it', () => {
    expect(page).toContain("visibleTabs.some(x => x.id === 'setup')")
    expect(page).toContain('setupHref={appSetupHref}')
    expect(src('components/portal/app-invoices.tsx')).toContain('data-testid="app-invoices-gear"')
  })

  it('the Setup area keeps the anchors and the ?tab=setup address the Profile page links to', () => {
    expect(page).toContain('SetupCard id={SETUP_LOGO_ANCHOR}')
    expect(page).toContain('SetupCard id={SETUP_BANK_ANCHOR}')
    expect(src('app/portal/profile/page.tsx')).toContain('tab=setup')
  })

  it('the list rows keep the money logic: Pay, mark paid and download still go through the same handlers', () => {
    const list = src('components/portal/expense-list.tsx')
    expect(list).toContain('setPayingExpense(exp)')
    expect(list).toContain('setConfirmingPaidExpense(exp)')
    expect(list).toContain('handleDownloadPdf(exp)')
    // the credit-note rule (a negative total is money owed TO the client, never a bill with a Pay button) is kept in the compact rows
    expect(list).toContain("const credit = Number(exp.total) < 0")
    expect(list).toContain('!hidePay && exp.source === \'td_invoice\'')
  })
})

describe('New invoice form: every box says what it is', () => {
  const form = src('components/portal/invoice-form.tsx')

  it('each line-item field carries its own label below the tablet width (the column titles are hidden there)', () => {
    expect(form).toContain("const labelClass = 'sm:hidden")
    expect((form.match(/<label className=\{labelClass\}>/g) ?? []).length).toBe(3)
    expect(form).toContain("t('app.invoiceForm.whatFor')")
    expect(form).toContain("t('app.invoiceForm.priceEach')")
  })

  it('the website keeps its own column layout; the item cards, hints and bottom bar are app-only', () => {
    expect(form).toContain("grid-cols-1 sm:grid-cols-[1fr,80px,100px,100px,40px] gap-2 items-start")
    expect(form).toContain('const appMode = useAppMode()')
    expect(form).toContain("data-testid={appMode ? 'invoice-form-bar' : undefined}")
  })

  it('there is still ONE way to submit (creating makes the draft): no extra save-draft path was added', () => {
    expect((form.match(/type="submit"/g) ?? []).length).toBe(1)
    expect(form).not.toMatch(/save draft/i)
  })
})
