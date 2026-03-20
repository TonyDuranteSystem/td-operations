export const dynamic = 'force-dynamic'

import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { getClientContactId } from '@/lib/portal-auth'
import { getPortalAccounts } from '@/lib/portal/queries'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { t, getLocale } from '@/lib/portal/i18n'
import { cookies } from 'next/headers'
import { Users, Plus } from 'lucide-react'
import Link from 'next/link'
import { CustomerList } from '@/components/portal/customer-list'

export default async function PortalCustomersPage() {
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

  const locale = getLocale(user)

  const { data: customers } = await supabaseAdmin
    .from('client_customers')
    .select('*')
    .eq('account_id', selectedAccountId)
    .order('name')

  // Get invoice counts per customer
  const { data: invoiceCounts } = await supabaseAdmin
    .from('client_invoices')
    .select('customer_id, id')
    .eq('account_id', selectedAccountId)

  const countMap: Record<string, number> = {}
  for (const inv of invoiceCounts ?? []) {
    countMap[inv.customer_id] = (countMap[inv.customer_id] || 0) + 1
  }

  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-4xl mx-auto space-y-4 sm:space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-xl sm:text-2xl font-semibold tracking-tight text-zinc-900">{t('customers.title', locale)}</h1>
          <p className="text-zinc-500 text-xs sm:text-sm mt-1">{t('customers.subtitle', locale)}</p>
        </div>
        <Link
          href="/portal/customers/new"
          className="flex items-center justify-center gap-2 px-4 py-2.5 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors w-full sm:w-auto"
        >
          <Plus className="h-4 w-4" />
          {t('customers.new', locale)}
        </Link>
      </div>

      {(!customers || customers.length === 0) ? (
        <div className="bg-white rounded-xl border shadow-sm p-8 sm:p-12 text-center">
          <Users className="h-12 w-12 text-zinc-300 mx-auto mb-3" />
          <h3 className="text-lg font-medium text-zinc-900 mb-1">{t('customers.noCustomers', locale)}</h3>
          <p className="text-sm text-zinc-500 mb-4">{t('customers.noCustomersDesc', locale)}</p>
          <Link
            href="/portal/customers/new"
            className="inline-flex items-center gap-2 px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700"
          >
            <Plus className="h-4 w-4" />
            {t('customers.add', locale)}
          </Link>
        </div>
      ) : (
        <CustomerList customers={customers} invoiceCounts={countMap} />
      )}
    </div>
  )
}
