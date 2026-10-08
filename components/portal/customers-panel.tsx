import { supabaseAdmin } from '@/lib/supabase-admin'
import { t, type Locale } from '@/lib/portal/i18n'
import { Users, Plus } from 'lucide-react'
import Link from 'next/link'
import { CustomerList } from '@/components/portal/customer-list'

/**
 * The client's customer list (name, email, invoice counts). One component used by BOTH the Customers
 * tab inside Invoices and the old /portal/customers page, so they can never drift apart. The caller
 * has already decided which company and checked that the user may see it.
 */
export async function CustomersPanel({
  accountId,
  locale,
  translations,
  showHeading = true,
}: {
  accountId: string
  locale: Locale
  translations?: Record<string, string>
  showHeading?: boolean
}) {
  const { data: customers } = await supabaseAdmin
    .from('client_customers')
    .select('*')
    .eq('account_id', accountId)
    .order('name')

  const { data: invoiceCounts } = await supabaseAdmin
    .from('client_invoices')
    .select('customer_id, id')
    .eq('account_id', accountId)

  const countMap: Record<string, number> = {}
  for (const inv of invoiceCounts ?? []) {
    countMap[inv.customer_id] = (countMap[inv.customer_id] || 0) + 1
  }

  return (
    <div className="space-y-4 sm:space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        {showHeading ? (
          <div>
            <h1 className="text-xl sm:text-2xl font-semibold tracking-tight text-zinc-900">{t('customers.title', locale, translations)}</h1>
            <p className="text-zinc-500 text-xs sm:text-sm mt-1">{t('customers.subtitle', locale, translations)}</p>
          </div>
        ) : (
          <p className="text-zinc-500 text-sm">{t('customers.subtitle', locale, translations)}</p>
        )}
        <Link
          href="/portal/customers/new"
          className="flex items-center justify-center gap-2 px-4 py-2.5 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors w-full sm:w-auto"
        >
          <Plus className="h-4 w-4" />
          {t('customers.new', locale, translations)}
        </Link>
      </div>

      {(!customers || customers.length === 0) ? (
        <div className="bg-white rounded-xl border shadow-sm p-8 sm:p-12 text-center">
          <Users className="h-12 w-12 text-zinc-300 mx-auto mb-3" />
          <h3 className="text-lg font-medium text-zinc-900 mb-1">{t('customers.noCustomers', locale, translations)}</h3>
          <p className="text-sm text-zinc-500 mb-4">{t('customers.noCustomersDesc', locale, translations)}</p>
          <Link
            href="/portal/customers/new"
            className="inline-flex items-center gap-2 px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700"
          >
            <Plus className="h-4 w-4" />
            {t('customers.add', locale, translations)}
          </Link>
        </div>
      ) : (
        <CustomerList customers={customers} invoiceCounts={countMap} />
      )}
    </div>
  )
}
