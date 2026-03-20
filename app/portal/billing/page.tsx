export const dynamic = 'force-dynamic'

import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { getClientContactId } from '@/lib/portal-auth'
import { getPortalAccounts, getPortalBilling } from '@/lib/portal/queries'
import { cookies } from 'next/headers'
import { t, getLocale } from '@/lib/portal/i18n'
import { BillingList } from '@/components/portal/billing-list'

export default async function PortalBillingPage() {
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

  const billing = await getPortalBilling(selectedAccountId)
  const locale = getLocale(user)

  // Stats
  const all = billing ?? []
  const totalBilled = all.reduce((s, i) => s + Math.abs(Number(i.total ?? i.amount ?? 0)), 0)
  const totalPaid = all.filter(i => i.invoice_status === 'Paid').reduce((s, i) => s + Math.abs(Number(i.total ?? i.amount ?? 0)), 0)
  const totalOutstanding = all
    .filter(i => ['Sent', 'Overdue'].includes(i.invoice_status ?? ''))
    .reduce((s, i) => s + Math.abs(Number(i.total ?? i.amount ?? 0)), 0)

  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-5xl mx-auto space-y-4 sm:space-y-6">
      <div>
        <h1 className="text-xl sm:text-2xl font-semibold tracking-tight text-zinc-900">
          {t('billing.title', locale)}
        </h1>
        <p className="text-zinc-500 text-xs sm:text-sm mt-1">
          {t('billing.subtitle', locale)}
        </p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="bg-white rounded-xl border shadow-sm p-4">
          <p className="text-xs text-zinc-500 uppercase tracking-wide">{t('billing.totalBilled', locale)}</p>
          <p className="text-lg sm:text-xl font-semibold text-zinc-900 mt-1">
            ${totalBilled.toLocaleString('en-US', { minimumFractionDigits: 2 })}
          </p>
        </div>
        <div className="bg-white rounded-xl border shadow-sm p-4">
          <p className="text-xs text-zinc-500 uppercase tracking-wide">{t('billing.paid', locale)}</p>
          <p className="text-lg sm:text-xl font-semibold text-emerald-600 mt-1">
            ${totalPaid.toLocaleString('en-US', { minimumFractionDigits: 2 })}
          </p>
        </div>
        <div className="bg-white rounded-xl border shadow-sm p-4">
          <p className="text-xs text-zinc-500 uppercase tracking-wide">{t('billing.outstanding', locale)}</p>
          <p className="text-lg sm:text-xl font-semibold text-amber-600 mt-1">
            ${totalOutstanding.toLocaleString('en-US', { minimumFractionDigits: 2 })}
          </p>
        </div>
      </div>

      <BillingList invoices={all} locale={locale} />
    </div>
  )
}
