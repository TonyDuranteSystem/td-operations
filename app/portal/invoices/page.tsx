export const dynamic = 'force-dynamic'

import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { getClientContactId } from '@/lib/portal-auth'
import { getPortalAccounts, getPortalExpenses } from '@/lib/portal/queries'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { cookies } from 'next/headers'
import { InvoiceList } from '@/components/portal/invoice-list'
import { ExpenseList } from '@/components/portal/expense-list'
import { TemplateList } from '@/components/portal/template-list'
import { Receipt, Plus, ArrowDownLeft, ArrowUpRight } from 'lucide-react'
import { t, getLocale } from '@/lib/portal/i18n'
import Link from 'next/link'
import { listTemplates } from './actions'

export default async function PortalInvoicesPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string }>
}) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/portal/login')

  const contactId = getClientContactId(user)
  if (!contactId) redirect('/portal')

  const accounts = await getPortalAccounts(contactId)
  const cookieStore = cookies()
  const cookieAccountId = (await cookieStore).get('portal_account_id')?.value
  const selectedAccountId = accounts.find(a => a.id === cookieAccountId)?.id ?? accounts[0]?.id
  if (!selectedAccountId) redirect('/portal')

  const params = await searchParams
  const activeTab = params.tab === 'expenses' ? 'expenses' : 'sales'
  const locale = getLocale(user)

  // Fetch data for both tabs in parallel
  const [salesResult, expenses, templates] = await Promise.all([
    supabaseAdmin
      .from('client_invoices')
      .select('*, client_customers(name)')
      .eq('account_id', selectedAccountId)
      .eq('source', 'client')
      .order('created_at', { ascending: false })
      .limit(100),
    getPortalExpenses(selectedAccountId),
    listTemplates(selectedAccountId),
  ])

  const invoices = salesResult.data ?? []

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
          <h1 className="text-xl sm:text-2xl font-semibold tracking-tight text-zinc-900">{t('invoices.title', locale)}</h1>
          <p className="text-zinc-500 text-xs sm:text-sm mt-1">
            {activeTab === 'sales' ? t('invoices.salesSubtitle', locale) : t('invoices.expensesSubtitle', locale)}
          </p>
        </div>
        {activeTab === 'sales' && (
          <Link
            href="/portal/invoices/new"
            className="flex items-center justify-center gap-2 px-4 py-2.5 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors w-full sm:w-auto"
          >
            <Plus className="h-4 w-4" />
            {t('invoices.new', locale)}
          </Link>
        )}
      </div>

      {/* Tabs */}
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
          {t('invoices.tabSales', locale)}
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
          {t('invoices.tabExpenses', locale)}
          {expenseStats.total > 0 && (
            <span className="text-xs bg-zinc-200 text-zinc-600 px-1.5 py-0.5 rounded-full">{expenseStats.total}</span>
          )}
        </Link>
      </div>

      {/* ── Sales Tab ── */}
      {activeTab === 'sales' && (
        <>
          {/* Stats */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="bg-white rounded-xl border shadow-sm p-4">
              <p className="text-xs text-zinc-500 uppercase tracking-wide">{t('invoices.totalInvoiced', locale)}</p>
              <p className="text-lg sm:text-xl font-semibold text-zinc-900 mt-1">${salesStats.totalAmount.toLocaleString('en-US', { minimumFractionDigits: 2 })}</p>
            </div>
            <div className="bg-white rounded-xl border shadow-sm p-4">
              <p className="text-xs text-zinc-500 uppercase tracking-wide">{t('invoices.paid', locale)}</p>
              <p className="text-lg sm:text-xl font-semibold text-emerald-600 mt-1">${salesStats.paid.toLocaleString('en-US', { minimumFractionDigits: 2 })}</p>
            </div>
            <div className="bg-white rounded-xl border shadow-sm p-4">
              <p className="text-xs text-zinc-500 uppercase tracking-wide">{t('invoices.outstanding', locale)}</p>
              <p className="text-lg sm:text-xl font-semibold text-amber-600 mt-1">${salesStats.outstanding.toLocaleString('en-US', { minimumFractionDigits: 2 })}</p>
            </div>
          </div>

          {mapped.length === 0 ? (
            <div className="bg-white rounded-xl border shadow-sm p-12 text-center">
              <Receipt className="h-12 w-12 text-zinc-300 mx-auto mb-3" />
              <h3 className="text-lg font-medium text-zinc-900 mb-1">{t('invoices.noInvoices', locale)}</h3>
              <p className="text-sm text-zinc-500 mb-4">{t('invoices.createFirst', locale)}</p>
              <Link
                href="/portal/invoices/new"
                className="inline-flex items-center gap-2 px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700"
              >
                <Plus className="h-4 w-4" />
                {t('invoices.new', locale)}
              </Link>
            </div>
          ) : (
            <InvoiceList invoices={mapped} />
          )}

          <TemplateList templates={templates} accountId={selectedAccountId} />
        </>
      )}

      {/* ── Expenses Tab ── */}
      {activeTab === 'expenses' && (
        <>
          {/* Stats */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <div className="bg-white rounded-xl border shadow-sm p-4">
              <p className="text-xs text-zinc-500 uppercase tracking-wide">{t('expenses.totalExpenses', locale)}</p>
              <p className="text-lg sm:text-xl font-semibold text-zinc-900 mt-1">${expenseStats.totalAmount.toLocaleString('en-US', { minimumFractionDigits: 2 })}</p>
            </div>
            <div className="bg-white rounded-xl border shadow-sm p-4">
              <p className="text-xs text-zinc-500 uppercase tracking-wide">{t('expenses.totalPaid', locale)}</p>
              <p className="text-lg sm:text-xl font-semibold text-emerald-600 mt-1">${expenseStats.paid.toLocaleString('en-US', { minimumFractionDigits: 2 })}</p>
            </div>
            <div className="bg-white rounded-xl border shadow-sm p-4">
              <p className="text-xs text-zinc-500 uppercase tracking-wide">{t('expenses.totalPending', locale)}</p>
              <p className="text-lg sm:text-xl font-semibold text-amber-600 mt-1">${expenseStats.pending.toLocaleString('en-US', { minimumFractionDigits: 2 })}</p>
            </div>
          </div>

          {expenses.length === 0 ? (
            <div className="bg-white rounded-xl border shadow-sm p-12 text-center">
              <ArrowDownLeft className="h-12 w-12 text-zinc-300 mx-auto mb-3" />
              <h3 className="text-lg font-medium text-zinc-900 mb-1">{t('expenses.noExpenses', locale)}</h3>
              <p className="text-sm text-zinc-500">{t('expenses.noExpensesDesc', locale)}</p>
            </div>
          ) : (
            <ExpenseList expenses={expenses} locale={locale} />
          )}
        </>
      )}
    </div>
  )
}
