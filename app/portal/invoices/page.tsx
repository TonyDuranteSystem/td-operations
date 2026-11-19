export const dynamic = 'force-dynamic'

import { salesTotals, formatMoneyMap, zeroCurrencyFor, sumExpensesByCurrency } from '@/lib/portal/invoice-totals'
import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { resolveInvoiceActor } from '@/lib/portal/invoice-actor'
import { getPortalAccounts, getPortalExpenses, getPortalExpensesByContact } from '@/lib/portal/queries'
import { filterByHistoryCutoff, isSettledPaymentStatus } from '@/lib/documents/history-cutoff'
import { getHistoryView, getOpenedItemIds } from '@/lib/portal/history-cutoff'
import { hasCapability } from '@/lib/portal/team/capabilities'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { cookies } from 'next/headers'
import { InvoiceList } from '@/components/portal/invoice-list'
import { ExpenseList } from '@/components/portal/expense-list'
import { TemplateList } from '@/components/portal/template-list'
import { VendorList } from '@/components/portal/vendor-list'
import { ExpensesHeader } from '@/components/portal/expenses-header'
import { AutopayCard } from '@/components/portal/autopay-card'
import { Receipt, Plus, ArrowDownLeft, ArrowUpRight, Building2, ChevronRight, Users, Settings2 } from 'lucide-react'
import { CustomersPanel } from '@/components/portal/customers-panel'
import { LogoUpload } from '@/components/portal/logo-upload'
import { BankAccounts } from '@/components/portal/bank-accounts'
import { PaymentLinks } from '@/components/portal/payment-links'
import { hubAccess, visibleInvoiceTabs, resolveInvoiceTab, isInvoiceHubOnFor, evaluateChecklist, missingRequired, type InvoiceTabContext, type InvoiceTabId } from '@/lib/portal/invoice-hub'
import { GuidedTour } from '@/components/portal/guided-tour'
import { TourBanner } from '@/components/portal/tour-banner'
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
import { latestDeliveryProblems } from '@/lib/portal/invoice-delivery'
import { getClientAppModeActive } from '@/lib/app-mode/server'
import { isClientAppPayEnabled } from '@/lib/portal-app/enabled'
import { accountQuery, appInvoicesScreen, appInvoiceAreas, billingTotals, checklistStepTarget, invoicesHomeMode, invoicesRootHref, LATEST_INVOICES, moneyLines, requiredFirst, salesStatusTone, SETUP_BANK_ANCHOR, SETUP_LOGO_ANCHOR, setupScreenStepTarget, tdInvoicesOf } from '@/lib/portal-app/invoices'
import { AppInvoiceAreas, AppAreaHeader, type AppLatestInvoice } from '@/components/portal/app-invoices'
import { format, parseISO } from 'date-fns'
import { AppTdBilling } from '@/components/portal/app-td-billing'

export default async function PortalInvoicesPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; view?: string; accountId?: string; paid?: string }>
}) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/portal/login')

  // ONE identity decision (lib/portal/invoice-actor.ts): a team member (even a login that also carries a contact
  // id) is a team member here, scoped to ONE company, and needs 'invoices_billing' to open this page.
  // Teammates see account-scoped sales/expenses only (no personal/contact expenses).
  const actor = await resolveInvoiceActor(user, 'invoices_billing')
  if (!actor) redirect('/portal')
  const contactId = actor.kind === 'contact' ? actor.contactId : null
  const teammateAccountId = actor.kind === 'teammate' ? actor.accountId : null
  const teammateCaps = actor.kind === 'teammate' ? actor.capabilities : null

  const params = await searchParams
  // Inside the client iPhone app the page opens on a LIST of areas, TD Billing is a screen of its own, and every other address is the
  // website's area exactly as drawn there (dev job 056a70d0, Step 3c). On the website `showTab` is always true: nothing below changes.
  const appMode = await getClientAppModeActive()
  const appScreen = appMode ? appInvoicesScreen(params) : 'tab'
  const showTab = appScreen === 'tab'
  const appPayHidden = appMode ? !(await isClientAppPayEnabled()) : false

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
    teammateCapabilities: teammateCaps,
  }
  const access = hubAccess(tabCtx)
  // Setup content follows what the server lets this person do (the APIs enforce the same flags).
  const canEditBank = !teammateCaps || hasCapability(teammateCaps, 'bank_applications')
  const canEditLogo = !teammateCaps || hasCapability(teammateCaps, 'company_services')
  const canEditLinks = !teammateCaps || hasCapability(teammateCaps, 'payment_links')
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
  const showHub = access.hubLayout
  const isClientHub = showHub && tabCtx.isClient
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
  const guides = isClientHub ? await loadInvoicingGuides() : null
  const checklist = setupFacts && guides ? evaluateChecklist(guides.checklist.items, setupFacts.facts) : []
  const setupMissing = missingRequired(checklist)
  const tourPref = isClientHub && guides ? await getTourPref(user.id, `tour.${guides.tour.id}`) : null
  // Staff looking at a client's portal (view-as is read-only) must not be nagged with the welcome prompt every visit.
  const viewingAsClient = !!(await verifyViewAs((await cookies()).get(VIEW_AS_COOKIE)?.value))
  const autopay = autopayResult.data as unknown as { autopay_card_enabled: boolean; autopay_card_last4: string | null } | null
  // Hide the whole card while the pilot kill switch is off, UNLESS this
  // account is already enrolled (so an existing enrollee can still see/turn
  // off their own autopay even after the switch is later flipped off for
  // new signups).
  const showAutopayCard = Boolean(autopay?.autopay_card_enabled) || (await isCardAutopayEnabled())

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  // A person who joined the company later sees its invoices and expenses only from their start date (dev job d14e823f).
  // Nothing to look up for everyone else: no start date = sees everything. TD invoices still owed stay visible.
  // A team member follows their own start date (the day they were added) unless the owner ticked "see earlier invoices
  // and expenses" for them; a client follows the date on their company link.
  const historyFor = async (kind: 'invoice' | 'expense'): Promise<{ cutoff: string | null; opened: Set<string> }> => {
    if (!selectedAccountId) return { cutoff: null, opened: new Set<string>() }
    if (actor.kind === 'teammate') {
      return actor.historyStart
        ? { cutoff: actor.historyStart, opened: await getOpenedItemIds(selectedAccountId, kind) }
        : { cutoff: null, opened: new Set<string>() }
    }
    return getHistoryView(selectedAccountId, contactId, kind)
  }
  const [invHistory, expHistory] = await Promise.all([historyFor('invoice'), historyFor('expense')])
  const invoices: any[] = filterByHistoryCutoff((salesResult.data ?? []) as any[], invHistory.cutoff, contactId, inv => ({ created_at: inv.created_at, opened: invHistory.opened.has(inv.id) }))
  const visibleAccountExpenses = filterByHistoryCutoff(accountExpenses, expHistory.cutoff, contactId, e => ({
    created_at: e.created_at,
    opened: expHistory.opened.has(e.id) || (e.source === 'td_invoice' && !isSettledPaymentStatus(e.status)),
  }))
  // Merge company-scoped + personal expenses into one mixed list. Each row
  // gets a scope_label so the ExpenseList can render a small badge ("Personal"
  // or company name). Per Antonio's design decision 2026-05-05.
  const personalLabel = t('dashboard.personal', locale, translations)
  const expenses = [
    ...visibleAccountExpenses.map(e => ({ ...e, scope_label: companyName ?? personalLabel })),
    ...personalExpenses.map(e => ({ ...e, scope_label: personalLabel })),
  ].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())

  // Which tab opens: lib/portal/invoice-hub.ts (a new client with required Setup items missing lands on
  // Setup; everyone else on Sales; a tab asked for in the link always wins).
  const activeTab: InvoiceTabId = resolveInvoiceTab(params, tabCtx, {
    hasSalesInvoices: invoices.length > 0,
    setupMissing,
  })

  // Sales stats: per currency (euros and dollars are never added together), Drafts / voided / split parents are not
  // receivables, a part-paid invoice counts its paid part as paid. Worked out from ALL the company's invoices, not
  // just the 100 shown in the list.
  const statsRows = selectedAccountId
    ? ((await supabaseAdmin
        .from('client_invoices')
        .select('id, created_at, status, currency, total, amount_paid, amount_due')
        .eq('account_id', selectedAccountId)
        .eq('source', 'client')
        .limit(5000)).data ?? [])
    : []
  // The totals must follow the same start date as the list, or the numbers would reveal what the list hides.
  const statsRowsVisible = filterByHistoryCutoff(statsRows, invHistory.cutoff, contactId, r => ({ created_at: r.created_at, opened: invHistory.opened.has(r.id) }))
  const sales = salesTotals(statsRowsVisible)
  const salesStats = {
    total: invoices.length,
    totalAmount: formatMoneyMap(sales.invoiced, zeroCurrencyFor(sales.invoiced, sales.paid, sales.outstanding)),
    paid: formatMoneyMap(sales.paid, zeroCurrencyFor(sales.invoiced, sales.paid, sales.outstanding)),
    outstanding: formatMoneyMap(sales.outstanding, zeroCurrencyFor(sales.invoiced, sales.paid, sales.outstanding)),
  }

  // Expense stats (also per currency)
  const expenseStats = {
    total: expenses.length,
    totalAmount: formatMoneyMap(sumExpensesByCurrency(expenses, st => st !== 'Cancelled')),
    paid: formatMoneyMap(sumExpensesByCurrency(expenses, st => st === 'Paid')),
    pending: formatMoneyMap(sumExpensesByCurrency(expenses, st => st !== 'Paid' && st !== 'Cancelled')),
  }

  // Map customer names for sales invoices
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const deliveryProblems = selectedAccountId
    ? await latestDeliveryProblems(selectedAccountId, invoices.map((inv: any) => inv.id as string))
    : new Map()
  const mapped = invoices.map((inv: any) => ({
    ...inv,
    customer_name: inv.client_customers?.name ?? 'Unknown',
    delivery_problem: deliveryProblems.has(inv.id),
  }))

  // The app's own screens (dev job 056a70d0, Step 3c): the same numbers the page already worked out, shown as a list.
  const tr = (key: string) => t(key, locale, translations)
  const visibleTabs = visibleInvoiceTabs(tabCtx)
  const appAreas = appMode
    ? appInvoiceAreas(visibleTabs, { customers: setupFacts?.customerCount ?? 0, sales: salesStats.total, vendors: vendors.length, expenses: expenseStats.total }, setupMissing, partnerAccountId)
    : []
  const appSteps = appMode && isClientHub && guides
    ? requiredFirst(checklist).map(item => ({
        id: item.id,
        label: tr(item.labelKey),
        required: item.required,
        done: item.done,
        href: checklistStepTarget(guides.checklist.items.find(i => i.id === item.id)?.rule, visibleTabs.map(x => x.id), partnerAccountId),
      }))
    : null
  // The Invoices home (dev job 056a70d0): the graphite "owed to you" card, the latest invoices, the gear. Same numbers the Sales tab used
  // to print in three tall cards (per currency, never added together); "overdue" is what is still owed on invoices marked Overdue.
  const homeMode = appMode ? invoicesHomeMode({ isClientHub, setupMissing, canSeeSales: visibleTabs.some(x => x.id === 'sales') }) : 'links'
  const zeroCurrency = zeroCurrencyFor(sales.invoiced, sales.paid, sales.outstanding)
  const appSummary = appMode && homeMode === 'summary'
    ? {
        owed: moneyLines(sales.outstanding, zeroCurrency),
        paid: formatMoneyMap(sales.paid, zeroCurrency),
        overdue: formatMoneyMap(salesTotals(statsRowsVisible.filter(r => r.status === 'Overdue')).outstanding, zeroCurrency),
      }
    : null
  const dayLabel = (iso: string | null) => { try { return iso ? format(parseISO(iso), 'MMM d') : '' } catch { return '' } }
  const appLatest: AppLatestInvoice[] = appMode && homeMode !== 'links'
    ? mapped.slice(0, LATEST_INVOICES).map(inv => ({
        id: inv.id,
        customer: inv.customer_name,
        number: inv.invoice_number,
        dateLabel: dayLabel(inv.issue_date),
        amountLabel: moneyLines({ [inv.currency === 'EUR' ? 'EUR' : 'USD']: Number(inv.total) })[0],
        status: inv.status,
        tone: salesStatusTone(inv.status),
        href: `/portal/invoices/${inv.id}`,
      }))
    : []
  const appSetupHref = visibleTabs.some(x => x.id === 'setup') ? `/portal/invoices?tab=setup${accountQuery(partnerAccountId)}` : null
  // TD Billing = the invoices from Tony Durante LLC among the expenses this person may see (same history start date as the list).
  // Only the fields the screen shows go to the browser (no attachment links).
  const billingRows = appMode && appScreen === 'billing'
    ? tdInvoicesOf(expenses).map(e => ({
        id: e.id,
        invoice_number: e.invoice_number,
        internal_ref: e.internal_ref,
        vendor_name: e.vendor_name,
        description: e.description,
        currency: e.currency,
        total: Number(e.total),
        amount_due: e.amount_due == null ? null : Number(e.amount_due),
        amount_paid: e.amount_paid == null ? null : Number(e.amount_paid),
        scope_label: e.scope_label ?? null,
        due_date: e.due_date,
        paid_date: e.paid_date,
        status: e.status,
        source: e.source,
        td_payment_id: e.td_payment_id,
      }))
    : []
  // The three boxes follow the same rule as the rows (lib/portal-app/invoices.ts): a part-paid invoice counts its balance as pending.
  const billingMoney = billingTotals(billingRows)
  const billingBoxes = {
    total: formatMoneyMap(billingMoney.total),
    paid: formatMoneyMap(billingMoney.paid),
    pending: formatMoneyMap(billingMoney.pending),
  }

  // One block of the Setup screen: the website's white card with its own small title, or inside the app a gray heading over a calm card.
  const SetupCard = ({ id, title, tour, children }: { id?: string; title: string; tour?: string; children: React.ReactNode }) => appMode ? (
    <section id={id} data-tour={tour} className="scroll-mt-4 space-y-2">
      <h2 className="px-1 text-[11px] font-bold uppercase tracking-[0.09em] text-zinc-500">{title}</h2>
      <div className="rounded-[18px] border border-zinc-200 bg-white p-4">{children}</div>
    </section>
  ) : (
    <div id={id} data-tour={tour} className="scroll-mt-4 bg-white rounded-xl border shadow-sm p-6 space-y-4">
      <h2 className="text-sm font-semibold text-zinc-900 uppercase tracking-wide">{title}</h2>
      {children}
    </div>
  )

  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-5xl mx-auto space-y-4 sm:space-y-6" data-app-gray={appMode ? '' : undefined}>
      {appMode && appScreen === 'areas' && (
        <AppInvoiceAreas
          subtitle={companyName ? (showHub ? tr('app.invoicesSubtitle').replace('{company}', () => companyName) : companyName) : selectedAccountId ? tr('app.invoicesSubtitleNoCompany') : tr('invoices.yourPersonalExpenses')}
          mode={homeMode}
          steps={appSteps}
          stepsLeft={setupMissing}
          areas={appAreas}
          summary={appSummary}
          latest={appLatest}
          salesCount={salesStats.total}
          newInvoiceHref={selectedAccountId ? '/portal/invoices/new' : null}
          setupHref={appSetupHref}
          seeAllHref={`/portal/invoices?tab=sales${accountQuery(partnerAccountId)}`}
          tr={tr}
        />
      )}
      {appMode && appScreen === 'billing' && (
        <AppTdBilling rows={billingRows} totals={billingBoxes} payEnabled={!appPayHidden} year={new Date().getFullYear()} justPaid={params.paid === '1'} />
      )}
      {appMode && appScreen === 'tab' && (
        <AppAreaHeader
          backLabel={tr('app.backToInvoices')}
          backHref={invoicesRootHref(partnerAccountId)}
          title={activeTab === 'setup' ? tr('app.inv.setupTitle') : tr(visibleTabs.find(x => x.id === activeTab)?.labelKey ?? 'nav.invoices')}
          action={
            showTab && activeTab === 'sales' && selectedAccountId ? (
              <Link href="/portal/invoices/new" data-testid="app-area-new" aria-label={tr('app.inv.newInvoice')} className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-zinc-800 text-white">
                <Plus className="h-5 w-5" aria-hidden="true" />
              </Link>
            ) : showTab && activeTab === 'expenses' && selectedAccountId ? (
              <ExpensesHeader accountId={selectedAccountId} vendors={vendors} round />
            ) : undefined
          }
        />
      )}
      {/* Slim "New: take the tour" strip: only while the tour is still being offered to this login (never in view-as) */}
      {isClientHub && guides && !viewingAsClient && !appMode && shouldOfferTour(tourPref, guides.tour) && (
        <TourBanner
          tourId={guides.tour.id}
          version={guides.tour.version}
          text={t('tour.invoicing.bannerText', locale, translations)}
          cta={t('tour.takeTour', locale, translations)}
          closeLabel={t('tour.invoicing.bannerClose', locale, translations)}
        />
      )}
      {/* Header */}
      <div className={`flex flex-col sm:flex-row sm:items-center justify-between gap-3${appMode ? ' empty:hidden' : ''}`}>
        {!appMode && (
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
        )}
        {isClientHub && guides && !appMode && (
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
        {showTab && !appMode && activeTab === 'sales' && selectedAccountId && (
          <Link
            data-tour="sales-new"
            href="/portal/invoices/new"
            className="flex items-center justify-center gap-2 px-4 py-2.5 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors w-full sm:w-auto"
          >
            <Plus className="h-4 w-4" />
            {t('invoices.new', locale, translations)}
          </Link>
        )}
        {showTab && !appMode && activeTab === 'expenses' && selectedAccountId && (
          <ExpensesHeader accountId={selectedAccountId} vendors={vendors} />
        )}
      </div>

      {/* Tabs — Sales + Vendors hidden for clients without a company (Sales/Vendors are
          genuinely company-scoped per R027 — client_invoices is the client's outgoing
          sales invoices, vendors are the client's vendors. Formation-gap clients only
          have personal expenses to view.) */}
      {selectedAccountId && !appMode && (
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
      {showTab && activeTab === 'sales' && (
        <>
          {/* Stats (the app shows these numbers on its Invoices home instead) */}
          {!appMode && (
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="bg-white rounded-xl border shadow-sm p-4">
              <p className="text-xs text-zinc-500 uppercase tracking-wide">{t('invoices.totalInvoiced', locale, translations)}</p>
              <p className="text-lg sm:text-xl font-semibold text-zinc-900 mt-1">{salesStats.totalAmount}</p>
            </div>
            <div className="bg-white rounded-xl border shadow-sm p-4">
              <p className="text-xs text-zinc-500 uppercase tracking-wide">{t('invoices.paid', locale, translations)}</p>
              <p className="text-lg sm:text-xl font-semibold text-emerald-600 mt-1">{salesStats.paid}</p>
            </div>
            <div className="bg-white rounded-xl border shadow-sm p-4">
              <p className="text-xs text-zinc-500 uppercase tracking-wide">{t('invoices.outstanding', locale, translations)}</p>
              <p className="text-lg sm:text-xl font-semibold text-amber-600 mt-1">{salesStats.outstanding}</p>
            </div>
          </div>
          )}

          <div data-tour="sales-list">
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
            <InvoiceList invoices={mapped} compact={appMode} />
          )}
          </div>

          <TemplateList templates={templates} accountId={selectedAccountId!} />
        </>
      )}

      {/* ── Expenses Tab ── */}
      {showTab && activeTab === 'expenses' && (
        <>
          {/* The app's Pay switch also hides the autopay card (it opens a card page too), except for a company already enrolled: they must still see and be able to turn off their autopay. The website never sets appPayHidden. */}
          {selectedAccountId && showAutopayCard && (!appPayHidden || Boolean(autopay?.autopay_card_enabled)) && (
            <AutopayCard
              accountId={selectedAccountId}
              enabled={autopay?.autopay_card_enabled ?? false}
              last4={autopay?.autopay_card_last4 ?? null}
            />
          )}

          {/* Stats: the website's three cards; the app's one slim strip */}
          {appMode ? (
            <div data-testid="app-expense-strip" className="grid grid-cols-3 overflow-hidden rounded-[18px] border border-zinc-200 bg-white">
              {[
                { label: tr('app.inv.total'), value: expenseStats.totalAmount, tone: 'text-zinc-900' },
                { label: t('expenses.totalPaid', locale, translations), value: expenseStats.paid, tone: 'text-emerald-700' },
                { label: t('expenses.totalPending', locale, translations), value: expenseStats.pending, tone: 'text-amber-700' },
              ].map((box, i) => (
                <div key={box.label} className={`min-w-0 px-3 py-3 ${i > 0 ? 'border-l border-zinc-200' : ''}`}>
                  <p className="truncate text-[11px] font-semibold uppercase tracking-wide text-zinc-500">{box.label}</p>
                  <p className={`mt-0.5 break-words text-[15px] font-bold leading-tight tabular-nums ${box.tone}`}>{box.value}</p>
                </div>
              ))}
            </div>
          ) : (
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="bg-white rounded-xl border shadow-sm p-4">
              <p className="text-xs text-zinc-500 uppercase tracking-wide">{t('expenses.totalExpenses', locale, translations)}</p>
              <p className="text-lg sm:text-xl font-semibold text-zinc-900 mt-1">{expenseStats.totalAmount}</p>
            </div>
            <div className="bg-white rounded-xl border shadow-sm p-4">
              <p className="text-xs text-zinc-500 uppercase tracking-wide">{t('expenses.totalPaid', locale, translations)}</p>
              <p className="text-lg sm:text-xl font-semibold text-emerald-600 mt-1">{expenseStats.paid}</p>
            </div>
            <div className="bg-white rounded-xl border shadow-sm p-4">
              <p className="text-xs text-zinc-500 uppercase tracking-wide">{t('expenses.totalPending', locale, translations)}</p>
              <p className="text-lg sm:text-xl font-semibold text-amber-600 mt-1">{expenseStats.pending}</p>
            </div>
          </div>
          )}

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
              hidePay={appPayHidden}
              compact={appMode}
            />
          )}
        </>
      )}

      {/* ── Customers Tab (hub) ── */}
      {showTab && activeTab === 'customers' && selectedAccountId && (
        <CustomersPanel accountId={selectedAccountId} locale={locale} translations={translations} showHeading={false} invoicesFrom={actor.kind === 'teammate' ? actor.historyStart : null} />
      )}

      {/* ── Setup Tab (hub): logo, bank accounts, payment link — the same cards that used to live on Profile ── */}
      {showTab && activeTab === 'setup' && selectedAccountId && setupFacts && (
        <div className="space-y-4" data-testid="invoice-setup">
          {isClientHub && (!appMode || setupMissing > 0) && (
          <div className={appMode ? 'rounded-[18px] border border-zinc-200 bg-white p-4 space-y-3' : 'bg-white rounded-xl border shadow-sm p-5 space-y-3'} data-tour="setup-checklist">
            <h2 className="text-sm font-semibold text-zinc-900 uppercase tracking-wide">{t('invoices.setupChecklist', locale, translations)}</h2>
            <ul className="divide-y">
              {checklist.map(item => {
                // Inside the app each step is a tap: the first customer opens Customers, the logo and the bank details jump down to their card
                // on this same screen. The website keeps the plain list.
                const href = appMode && guides
                  ? setupScreenStepTarget(guides.checklist.items.find(i => i.id === item.id)?.rule, visibleTabs.map(x => x.id), { canEditLogo, managedAccountId: partnerAccountId })
                  : null
                const row = (
                  <>
                    <span className={`h-5 w-5 rounded-full border-2 flex items-center justify-center text-[11px] text-white ${item.done ? 'bg-emerald-600 border-emerald-600' : 'border-zinc-300'}`}>{item.done ? '✓' : ''}</span>
                    <span className="flex-1 text-zinc-800">{t(item.labelKey, locale, translations)}</span>
                    <span className={`text-xs ${item.required ? 'text-amber-700 font-medium' : 'text-zinc-400'}`}>
                      {item.required ? t('invoices.setupRequired', locale, translations) : t('invoices.setupOptional', locale, translations)}
                    </span>
                    {href && <ChevronRight className="h-4 w-4 shrink-0 text-zinc-500" aria-hidden="true" />}
                  </>
                )
                if (!href) return <li key={item.id} className="flex items-center gap-3 py-2 text-sm">{row}</li>
                const linkClass = 'flex min-h-11 items-center gap-3 py-2 text-sm'
                return (
                  <li key={item.id} data-testid={`app-setup-screen-step-${item.id}`}>
                    {href.startsWith('#')
                      ? <a href={href} className={linkClass}>{row}</a>
                      : <Link href={href} className={linkClass}>{row}</Link>}
                  </li>
                )
              })}
            </ul>
          </div>
          )}
          {canEditLogo && (
            <SetupCard id={SETUP_LOGO_ANCHOR} title={t('profile.invoiceLogo', locale, translations)}>
              <LogoUpload accountId={selectedAccountId} currentUrl={setupFacts.logoUrl} />
            </SetupCard>
          )}
          <SetupCard id={SETUP_BANK_ANCHOR} title={t('profile.bankDetails', locale, translations)} tour="setup-payment">
            <BankAccounts accountId={selectedAccountId} readOnly={!canEditBank} />
          </SetupCard>
          <SetupCard title={t('profile.paymentGateway', locale, translations)}>
            <PaymentLinks accountId={selectedAccountId} readOnly={!canEditLinks} />
          </SetupCard>
        </div>
      )}

      {/* ── Vendors Tab ── */}
      {showTab && activeTab === 'vendors' && (
        <VendorList vendors={vendors} accountId={selectedAccountId!} expenses={expenses} />
      )}

      {/* Feature ideas (hub clients, every tab) — also the last stop of the guided tour */}
      {showTab && isClientHub && selectedAccountId && (
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
