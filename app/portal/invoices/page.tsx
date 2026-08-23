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
import { Receipt, Plus, ArrowDownLeft, ArrowUpRight, Building2 } from 'lucide-react'
import { t, getLocale } from '@/lib/portal/i18n'
import { loadTranslationsForLocale } from '@/lib/portal/translations-store'
import Link from 'next/link'
import { listTemplates } from './actions'
import { listVendors } from './vendor-actions'

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

  // No-account clients only see Expenses (Sales + Vendors are company-scoped
  // by design — client_invoices is the client's outgoing sales, vendors are
  // the client's vendors). Force expenses when no account regardless of params.
  const activeTab = !selectedAccountId
    ? 'expenses'
    : params.tab === 'expenses' || params.view === 'paid'
    ? 'expenses'
    : params.tab === 'vendors'
    ? 'vendors'
    : 'sales'
  // Pre-filter to paid when arriving from a receipt email link
  const defaultExpenseFilter: 'all' | 'paid' = params.view === 'paid' ? 'paid' : 'all'
  const locale = getLocale(user)
  const translations = await loadTranslationsForLocale(locale)

  // Fetch data for all tabs in parallel. When no account, only personal
  // expenses are queried; sales/templates/vendors are empty.
  const [salesResult, accountExpenses, personalExpenses, templates, vendors] = await Promise.all([
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
  ])

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
          <h1 className="text-xl sm:text-2xl font-semibold tracking-tight text-zinc-900">{t('invoices.title', locale, translations)}</h1>
          <p className="text-zinc-500 text-xs sm:text-sm mt-1">
            {!selectedAccountId
              ? t('invoices.yourPersonalExpenses', locale, translations)
              : activeTab === 'sales' ? t('invoices.salesSubtitle', locale, translations) : t('invoices.expensesSubtitle', locale, translations)}
          </p>
        </div>
        {activeTab === 'sales' && selectedAccountId && (
          <Link
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
      <div className="flex gap-1 bg-zinc-100 p-1 rounded-lg w-fit">
        <Link
          href="/portal/invoices?tab=sales"
          className={`flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-md transition-colors ${
            activeTab === 'sales'
              ? 'bg-white text-zinc-900 shadow-sm'
              : 'text-zinc-600 hover:text-zinc-900'
          }`}
        >
          <ArrowUpRight className="h-4 w-4" />
          {t('invoices.tabSales', locale, translations)}
          {salesStats.total > 0 && (
            <span className="text-xs bg-zinc-200 text-zinc-600 px-1.5 py-0.5 rounded-full">{salesStats.total}</span>
          )}
        </Link>
        <Link
          href="/portal/invoices?tab=expenses"
          className={`flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-md transition-colors ${
            activeTab === 'expenses'
              ? 'bg-white text-zinc-900 shadow-sm'
              : 'text-zinc-600 hover:text-zinc-900'
          }`}
        >
          <ArrowDownLeft className="h-4 w-4" />
          {t('invoices.tabExpenses', locale, translations)}
          {expenseStats.total > 0 && (
            <span className="text-xs bg-zinc-200 text-zinc-600 px-1.5 py-0.5 rounded-full">{expenseStats.total}</span>
          )}
        </Link>
        <Link
          href="/portal/invoices?tab=vendors"
          className={`flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-md transition-colors ${
            activeTab === 'vendors'
              ? 'bg-white text-zinc-900 shadow-sm'
              : 'text-zinc-600 hover:text-zinc-900'
          }`}
        >
          <Building2 className="h-4 w-4" />
          {t('invoices.vendors', locale, translations)}
          {vendors.length > 0 && (
            <span className="text-xs bg-zinc-200 text-zinc-600 px-1.5 py-0.5 rounded-full">{vendors.length}</span>
          )}
        </Link>
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

      {/* ── Vendors Tab ── */}
      {activeTab === 'vendors' && (
        <VendorList vendors={vendors} accountId={selectedAccountId!} />
      )}
    </div>
  )
}
