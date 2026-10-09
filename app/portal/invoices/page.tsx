export const dynamic = 'force-dynamic'

import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { getClientContactId } from '@/lib/portal-auth'
import { getPortalAccounts, getPortalExpenses, getPortalExpensesByContact } from '@/lib/portal/queries'
import { getTeammateScopeOrNull } from '@/lib/portal/team/gate'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { cookies } from 'next/headers'
import { InvoiceList } from '@/components/portal/invoice-list'
import { ExpenseList } from '@/components/portal/expense-list'
import { TemplateList } from '@/components/portal/template-list'
import { VendorList } from '@/components/portal/vendor-list'
import { ExpensesHeader } from '@/components/portal/expenses-header'
import { AutopayCard } from '@/components/portal/autopay-card'
import { Receipt, Plus, ArrowDownLeft, ArrowUpRight, Building2, Users, Settings2 } from 'lucide-react'
import { CustomersPanel } from '@/components/portal/customers-panel'
import { LogoUpload } from '@/components/portal/logo-upload'
import { BankAccounts } from '@/components/portal/bank-accounts'
import { PaymentLinks } from '@/components/portal/payment-links'
import { visibleInvoiceTabs, resolveInvoiceTab, isInvoiceHubOnFor, evaluateChecklist, missingRequired, type InvoiceTabContext, type InvoiceTabId } from '@/lib/portal/invoice-hub'
import { GuidedTour } from '@/components/portal/guided-tour'
import { FeatureRequestCard } from '@/components/portal/feature-request-card'
import { loadInvoicingGuides, getTourPref } from '@/lib/portal/guides/guides-server'
import { shouldOfferTour } from '@/lib/portal/guides/guides'
import { isPlausibleEmail } from '@/lib/portal/invoice-send-notices'
import { getInvoiceHubSetting } from '@/lib/settings'
import { VIEW_AS_COOKIE, verifyViewAs } from '@/lib/portal/view-as'
import { t, getLocale } from '@/lib/portal/i18n'
import { loadTranslationsForLocale } from '@/lib/portal/translations-store'
import Link from 'next/link'
import { listTemplates } from './actions'
import { listVendors } from './vendor-actions'
import { isCardAutopayEnabled } from '@/lib/payments/card-autopay-config'

export default async function PortalInvoicesPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; view?: string; accountId?: string }>
}) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/portal/login')

  const contactId = getClientContactId(user)
  // Teammate (Portal Team Access) — scoped to ONE company; requires 'invoices_billing'.
  // Teammates see account-scoped sales/expenses only (no personal/contact expenses).
  const teammateAccountId = contactId ? null : await getTeammateScopeOrNull(user, 'invoices_billing')
  if (!contactId && !teammateAccountId) redirect('/portal')

  const params = await searchParams

  // Partner access: if ?accountId is provided and the user is a partner,
  // verify they manage that account via client_partners → accounts.partner_id.
  let partnerAccountId: string | undefined
  if (params.accountId && contactId) {
    const { data: contact } = await supabaseAdmin
      .from('contacts')
      .select('portal_role')
      .eq('id', contactId)
      .single()
    if (contact?.portal_role === 'partner') {
      const { data: partnerRecord } = await supabaseAdmin
        .from('client_partners')
        .select('id')
        .eq('contact_id', contactId)
        .single()
      if (partnerRecord) {
        const { data: acct } = await supabaseAdmin
          .from('accounts')
          .select('id')
          .eq('id', params.accountId)
          .eq('partner_id', partnerRecord.id)
          .single()
        if (acct) partnerAccountId = acct.id
      }
    }
  }

  const accounts = contactId ? await getPortalAccounts(contactId) : []
  const cookieStore = cookies()
  const cookieAccountId = (await cookieStore).get('portal_account_id')?.value
  const selectedAccountId = partnerAccountId
    ?? accounts.find(a => a.id === cookieAccountId)?.id
    ?? accounts[0]?.id
    ?? teammateAccountId
    ?? undefined
  // No redirect when there's no account — formation-gap clients (paid as
  // individual, no company yet, e.g. Lorenzo) need to see their personal
  // invoices via the Expenses tab.
  const selectedAccount = accounts.find(a => a.id === selectedAccountId) ?? null
  const companyName = selectedAccount?.company_name ?? null

  // Which tabs exist and which one is open: lib/portal/invoice-hub.ts (one tab list, one picking function).
  // Customers + Setup appear only for the company's own client, once the roll-out switch is on for them.
  const hubOn = isInvoiceHubOnFor(await getInvoiceHubSetting(), selectedAccountId)
  const tabCtx: InvoiceTabContext = {
    hasAccount: !!selectedAccountId,
    hubOn,
    isClient: !!contactId && !partnerAccountId,
  }
  // Pre-filter to paid when arriving from a receipt email link
  const defaultExpenseFilter: 'all' | 'paid' = params.view === 'paid' ? 'paid' : 'all'
  const locale = getLocale(user)
  const translations = await loadTranslationsForLocale(locale)

  // Fetch data for all tabs in parallel. When no account, only personal
  // expenses are queried; sales/templates/vendors are empty.
  const [salesResult, accountExpenses, personalExpenses, templates, vendors, autopayResult] = await Promise.all([
    selectedAccountId
      ? supabaseAdmin
          .from('client_invoices')
          .select('*, client_customers(name)')
          .eq('account_id', selectedAccountId)
          .eq('source', 'client')
          .order('created_at', { ascending: false })
          .limit(100)
      : Promise.resolve({ data: [] as Array<Record<string, unknown>> }),
    selectedAccountId ? getPortalExpenses(selectedAccountId) : Promise.resolve([]),
    contactId ? getPortalExpensesByContact(contactId) : Promise.resolve([]),
    selectedAccountId ? listTemplates(selectedAccountId) : Promise.resolve([]),
    selectedAccountId ? listVendors(selectedAccountId) : Promise.resolve([]),
    selectedAccountId
      ? supabaseAdmin
          .from('accounts')
          .select('autopay_card_enabled, autopay_card_last4' as never)
          .eq('id', selectedAccountId)
          .single()
      : Promise.resolve({ data: null }),
  ])
  // Setup facts (logo, bank account / payment link, a customer with an email). Worked out live every
  // time from the data; never stored. Only for the hub (Customers + Setup tabs).
  const showHub = tabCtx.hasAccount && tabCtx.hubOn && tabCtx.isClient
  const setupFacts = showHub && selectedAccountId
    ? await (async () => {
        const [logoRes, bankRes, linkRes, custRes] = await Promise.all([
          supabaseAdmin.from('accounts').select('invoice_logo_url').eq('id', selectedAccountId).single(),
          supabaseAdmin.from('client_bank_accounts').select('id', { count: 'exact', head: true }).eq('account_id', selectedAccountId),
          supabaseAdmin.from('payment_links').select('id', { count: 'exact', head: true }).eq('account_id', selectedAccountId),
          supabaseAdmin.from('client_customers').select('email').eq('account_id', selectedAccountId),
        ])
        const customerRows = custRes.data ?? []
        return {
          facts: {
            hasLogo: !!(logoRes.data as { invoice_logo_url?: string | null } | null)?.invoice_logo_url,
            hasBankAccount: (bankRes.count ?? 0) > 0,
            hasPaymentLink: (linkRes.count ?? 0) > 0,
            hasCustomerWithEmail: customerRows.some(c => isPlausibleEmail(c.email)),
          },
          customerCount: customerRows.length,
          logoUrl: (logoRes.data as { invoice_logo_url?: string | null } | null)?.invoice_logo_url ?? null,
        }
      })()
    : null
  // The tour and the checklist are DATA (optional catalog rows, built-in defaults): lib/portal/guides/guides.ts.
  const guides = showHub ? await loadInvoicingGuides() : null
  const checklist = setupFacts && guides ? evaluateChecklist(guides.checklist.items, setupFacts.facts) : []
  const setupMissing = missingRequired(checklist)
  const tourPref = showHub && guides ? await getTourPref(user.id, `tour.${guides.tour.id}`) : null
  // Staff looking at a client's portal (view-as is read-only) must not be nagged with the welcome prompt every visit.
  const viewingAsClient = !!(await verifyViewAs((await cookies()).get(VIEW_AS_COOKIE)?.value))
  const autopay = autopayResult.data as unknown as { autopay_card_enabled: boolean; autopay_card_last4: string | null } | null
  // Hide the whole card while the pilot kill switch is off, UNLESS this
  // account is already enrolled (so an existing enrollee can still see/turn
  // off their own autopay even after the switch is later flipped off for
  // new signups).
  const showAutopayCard = Boolean(autopay?.autopay_card_enabled) || (await isCardAutopayEnabled())

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const invoices: any[] = salesResult.data ?? []
  // Merge company-scoped + personal expenses into one mixed list. Each row
  // gets a scope_label so the ExpenseList can render a small badge ("Personal"
  // or company name). Per Antonio's design decision 2026-05-05.
  const personalLabel = t('dashboard.personal', locale, translations)
  const expenses = [
    ...accountExpenses.map(e => ({ ...e, scope_label: companyName ?? personalLabel })),
    ...personalExpenses.map(e => ({ ...e, scope_label: personalLabel })),
  ].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())

  // Which tab opens: lib/portal/invoice-hub.ts (a new client with required Setup items missing lands on
  // Setup; everyone else on Sales; a tab asked for in the link always wins).
  const activeTab: InvoiceTabId = resolveInvoiceTab(params, tabCtx, {
    hasSalesInvoices: invoices.length > 0,
    setupMissing,
  })

  // Sales stats
  const salesStats = {
    total: invoices.length,
    totalAmount: invoices.reduce((s, i) => s + Number(i.total), 0),
    paid: invoices.filter(i => i.status === 'Paid').reduce((s, i) => s + Number(i.total), 0),
    outstanding: invoices.filter(i => i.status !== 'Paid' && i.status !== 'Cancelled').reduce((s, i) => s + Number(i.total), 0),
  }

  // Expense stats
  const expenseStats = {
    total: expenses.length,
    totalAmount: expenses.reduce((s, i) => s + Number(i.total), 0),
    paid: expenses.filter(i => i.status === 'Paid').reduce((s, i) => s + Number(i.total), 0),
    pending: expenses.filter(i => i.status !== 'Paid' && i.status !== 'Cancelled').reduce((s, i) => s + Number(i.total), 0),
  }

  // Map customer names for sales invoices
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mapped = invoices.map((inv: any) => ({
    ...inv,
    customer_name: inv.client_customers?.name ?? 'Unknown',
  }))

  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-5xl mx-auto space-y-4 sm:space-y-6">
      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 data-tour="hub-title" className="text-xl sm:text-2xl font-semibold tracking-tight text-zinc-900">{t(showHub ? 'nav.invoicesHub' : 'invoices.title', locale, translations)}</h1>
          <p className="text-zinc-500 text-xs sm:text-sm mt-1">
            {!selectedAccountId
              ? t('invoices.yourPersonalExpenses', locale, translations)
              : showHub ? t('invoices.hubSubtitle', locale, translations)
              : activeTab === 'sales' ? t('invoices.salesSubtitle', locale, translations)
              : activeTab === 'customers' ? t('customers.subtitle', locale, translations)
              : activeTab === 'setup' ? t('invoices.setupSubtitle', locale, translations)
              : t('invoices.expensesSubtitle', locale, translations)}
          </p>
        </div>
        {showHub && guides && (
          <GuidedTour
            tourId={guides.tour.id}
            version={guides.tour.version}
            steps={guides.tour.steps.map(s => ({ id: s.id, target: s.target, tab: s.tab, title: t(s.titleKey, locale, translations), body: t(s.bodyKey, locale, translations), placement: s.placement }))}
            labels={{
              introTitle: t('tour.invoicing.introTitle', locale, translations),
              introBody: t('tour.invoicing.introBody', locale, translations),
              start: t('tour.start', locale, translations),
              notNow: t('tour.notNow', locale, translations),
              dontShow: t('tour.dontShow', locale, translations),
              takeTour: t('tour.takeTour', locale, translations),
              next: t('tour.next', locale, translations),
              back: t('tour.back', locale, translations),
              skip: t('tour.skip', locale, translations),
              done: t('tour.done', locale, translations),
            }}
            offer={!viewingAsClient && shouldOfferTour(tourPref, guides.tour)}
            basePath="/portal/invoices"
            activeTab={activeTab}
          />
        )}
        {activeTab === 'sales' && selectedAccountId && (
          <Link
            data-tour="sales-new"
            href="/portal/invoices/new"
            className="flex items-center justify-center gap-2 px-4 py-2.5 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors w-full sm:w-auto"
          >
            <Plus className="h-4 w-4" />
            {t('invoices.new', locale, translations)}
          </Link>
        )}
        {activeTab === 'expenses' && selectedAccountId && (
          <ExpensesHeader accountId={selectedAccountId} vendors={vendors} />
        )}
      </div>

      {/* Tabs — Sales + Vendors hidden for clients without a company (Sales/Vendors are
          genuinely company-scoped per R027 — client_invoices is the client's outgoing
          sales invoices, vendors are the client's vendors. Formation-gap clients only
          have personal expenses to view.) */}
      {selectedAccountId && (
      <div className="flex gap-1 bg-zinc-100 p-1 rounded-lg w-fit max-w-full overflow-x-auto" data-testid="invoice-tabs">
        {visibleInvoiceTabs(tabCtx).map(tab => {
          const Icon = { sales: ArrowUpRight, customers: Users, expenses: ArrowDownLeft, vendors: Building2, setup: Settings2 }[tab.id]
          const count = tab.id === 'sales' ? salesStats.total
            : tab.id === 'expenses' ? expenseStats.total
            : tab.id === 'vendors' ? vendors.length
            : tab.id === 'customers' ? (setupFacts?.customerCount ?? 0)
            : 0
          return (
            <Link
              key={tab.id}
              href={`/portal/invoices?tab=${tab.id}`}
              data-tab={tab.id}
              data-tour={`tab-${tab.id}`}
              className={`flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-md transition-colors whitespace-nowrap ${
                activeTab === tab.id
                  ? 'bg-white text-zinc-900 shadow-sm'
                  : 'text-zinc-600 hover:text-zinc-900'
              }`}
            >
              <Icon className="h-4 w-4" />
              {t(tab.labelKey, locale, translations)}
              {count > 0 && (
                <span className="text-xs bg-zinc-200 text-zinc-600 px-1.5 py-0.5 rounded-full">{count}</span>
              )}
              {tab.id === 'setup' && setupMissing > 0 && (
                <span
                  className="text-xs bg-amber-500 text-white min-w-[1.25rem] h-5 px-1.5 rounded-full inline-flex items-center justify-center font-semibold"
                  data-testid="setup-missing-badge"
                  title={t('invoices.setupMissingHint', locale, translations)}
                >
                  {setupMissing}
                </span>
              )}
            </Link>
          )
        })}
      </div>
      )}

      {/* ── Sales Tab ── */}
      {activeTab === 'sales' && (
        <>
          {/* Stats */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="bg-white rounded-xl border shadow-sm p-4">
              <p className="text-xs text-zinc-500 uppercase tracking-wide">{t('invoices.totalInvoiced', locale, translations)}</p>
              <p className="text-lg sm:text-xl font-semibold text-zinc-900 mt-1">${salesStats.totalAmount.toLocaleString('en-US', { minimumFractionDigits: 2 })}</p>
            </div>
            <div className="bg-white rounded-xl border shadow-sm p-4">
              <p className="text-xs text-zinc-500 uppercase tracking-wide">{t('invoices.paid', locale, translations)}</p>
              <p className="text-lg sm:text-xl font-semibold text-emerald-600 mt-1">${salesStats.paid.toLocaleString('en-US', { minimumFractionDigits: 2 })}</p>
            </div>
            <div className="bg-white rounded-xl border shadow-sm p-4">
              <p className="text-xs text-zinc-500 uppercase tracking-wide">{t('invoices.outstanding', locale, translations)}</p>
              <p className="text-lg sm:text-xl font-semibold text-amber-600 mt-1">${salesStats.outstanding.toLocaleString('en-US', { minimumFractionDigits: 2 })}</p>
            </div>
          </div>

          {mapped.length === 0 ? (
            <div className="bg-white rounded-xl border shadow-sm p-12 text-center">
              <Receipt className="h-12 w-12 text-zinc-300 mx-auto mb-3" />
              <h3 className="text-lg font-medium text-zinc-900 mb-1">{t('invoices.noInvoices', locale, translations)}</h3>
              <p className="text-sm text-zinc-500 mb-4">{t('invoices.createFirst', locale, translations)}</p>
              <Link
                href="/portal/invoices/new"
                className="inline-flex items-center gap-2 px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700"
              >
                <Plus className="h-4 w-4" />
                {t('invoices.new', locale, translations)}
              </Link>
            </div>
          ) : (
            <InvoiceList invoices={mapped} />
          )}

          <TemplateList templates={templates} accountId={selectedAccountId!} />
        </>
      )}

      {/* ── Expenses Tab ── */}
      {activeTab === 'expenses' && (
        <>
          {selectedAccountId && showAutopayCard && (
            <AutopayCard
              accountId={selectedAccountId}
              enabled={autopay?.autopay_card_enabled ?? false}
              last4={autopay?.autopay_card_last4 ?? null}
            />
          )}

          {/* Stats */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="bg-white rounded-xl border shadow-sm p-4">
              <p className="text-xs text-zinc-500 uppercase tracking-wide">{t('expenses.totalExpenses', locale, translations)}</p>
              <p className="text-lg sm:text-xl font-semibold text-zinc-900 mt-1">${expenseStats.totalAmount.toLocaleString('en-US', { minimumFractionDigits: 2 })}</p>
            </div>
            <div className="bg-white rounded-xl border shadow-sm p-4">
              <p className="text-xs text-zinc-500 uppercase tracking-wide">{t('expenses.totalPaid', locale, translations)}</p>
              <p className="text-lg sm:text-xl font-semibold text-emerald-600 mt-1">${expenseStats.paid.toLocaleString('en-US', { minimumFractionDigits: 2 })}</p>
            </div>
            <div className="bg-white rounded-xl border shadow-sm p-4">
              <p className="text-xs text-zinc-500 uppercase tracking-wide">{t('expenses.totalPending', locale, translations)}</p>
              <p className="text-lg sm:text-xl font-semibold text-amber-600 mt-1">${expenseStats.pending.toLocaleString('en-US', { minimumFractionDigits: 2 })}</p>
            </div>
          </div>

          {expenses.length === 0 ? (
            <div className="bg-white rounded-xl border shadow-sm p-12 text-center">
              <ArrowDownLeft className="h-12 w-12 text-zinc-300 mx-auto mb-3" />
              <h3 className="text-lg font-medium text-zinc-900 mb-1">{t('expenses.noExpenses', locale, translations)}</h3>
              <p className="text-sm text-zinc-500">{t('expenses.noExpensesDesc', locale, translations)}</p>
            </div>
          ) : (
            <ExpenseList
              expenses={expenses}
              initialFilter={defaultExpenseFilter === 'paid' ? 'Paid' : 'All'}
            />
          )}
        </>
      )}

      {/* ── Customers Tab (hub) ── */}
      {activeTab === 'customers' && selectedAccountId && (
        <CustomersPanel accountId={selectedAccountId} locale={locale} translations={translations} showHeading={false} />
      )}

      {/* ── Setup Tab (hub): logo, bank accounts, payment link — the same cards that used to live on Profile ── */}
      {activeTab === 'setup' && selectedAccountId && setupFacts && (
        <div className="space-y-4" data-testid="invoice-setup">
          <div className="bg-white rounded-xl border shadow-sm p-5 space-y-3" data-tour="setup-checklist">
            <h2 className="text-sm font-semibold text-zinc-900 uppercase tracking-wide">{t('invoices.setupChecklist', locale, translations)}</h2>
            <ul className="divide-y">
              {checklist.map(item => (
                <li key={item.id} className="flex items-center gap-3 py-2 text-sm">
                  <span className={`h-5 w-5 rounded-full border-2 flex items-center justify-center text-[11px] text-white ${item.done ? 'bg-emerald-600 border-emerald-600' : 'border-zinc-300'}`}>{item.done ? '✓' : ''}</span>
                  <span className="flex-1 text-zinc-800">{t(item.labelKey, locale, translations)}</span>
                  <span className={`text-xs ${item.required ? 'text-amber-700 font-medium' : 'text-zinc-400'}`}>
                    {item.required ? t('invoices.setupRequired', locale, translations) : t('invoices.setupOptional', locale, translations)}
                  </span>
                </li>
              ))}
            </ul>
          </div>
          <div className="bg-white rounded-xl border shadow-sm p-6 space-y-4">
            <h2 className="text-sm font-semibold text-zinc-900 uppercase tracking-wide">{t('profile.invoiceLogo', locale, translations)}</h2>
            <LogoUpload accountId={selectedAccountId} currentUrl={setupFacts.logoUrl} />
          </div>
          <div className="bg-white rounded-xl border shadow-sm p-6 space-y-4" data-tour="setup-payment">
            <h2 className="text-sm font-semibold text-zinc-900 uppercase tracking-wide">{t('profile.bankDetails', locale, translations)}</h2>
            <BankAccounts accountId={selectedAccountId} />
          </div>
          <div className="bg-white rounded-xl border shadow-sm p-6 space-y-4">
            <h2 className="text-sm font-semibold text-zinc-900 uppercase tracking-wide">{t('profile.paymentGateway', locale, translations)}</h2>
            <PaymentLinks accountId={selectedAccountId} />
          </div>
        </div>
      )}

      {/* ── Vendors Tab ── */}
      {activeTab === 'vendors' && (
        <VendorList vendors={vendors} accountId={selectedAccountId!} expenses={expenses} />
      )}

      {/* Feature ideas (hub clients, every tab) — also the last stop of the guided tour */}
      {showHub && selectedAccountId && (
        <FeatureRequestCard
          accountId={selectedAccountId}
          labels={{
            title: t('invoices.feature.title', locale, translations),
            body: t('invoices.feature.body', locale, translations),
            placeholder: t('invoices.feature.placeholder', locale, translations),
            send: t('invoices.feature.send', locale, translations),
            sent: t('invoices.feature.sent', locale, translations),
            tooShort: t('invoices.feature.tooShort', locale, translations),
          }}
        />
      )}
    </div>
  )
}
