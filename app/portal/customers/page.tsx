export const dynamic = 'force-dynamic'

import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { getClientContactId } from '@/lib/portal-auth'
import { getPortalAccounts } from '@/lib/portal/queries'
import { getTeammateScopeOrNull } from '@/lib/portal/team/gate'
import { isInvoiceHubOnFor } from '@/lib/portal/invoice-hub'
import { getInvoiceHubSetting } from '@/lib/settings'
import { getLocale } from '@/lib/portal/i18n'
import { cookies } from 'next/headers'
import { CustomersPanel } from '@/components/portal/customers-panel'

export default async function PortalCustomersPage() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/portal/login')

  const contactId = getClientContactId(user)
  let selectedAccountId: string | undefined
  if (contactId) {
    const accounts = await getPortalAccounts(contactId)
    const cookieStore = cookies()
    const cookieAccountId = (await cookieStore).get('portal_account_id')?.value
    selectedAccountId = accounts.find(a => a.id === cookieAccountId)?.id ?? accounts[0]?.id
  } else {
    // Teammate (Portal Team Access) — requires 'sales_customers'.
    selectedAccountId = (await getTeammateScopeOrNull(user, 'sales_customers')) ?? undefined
  }
  if (!selectedAccountId) redirect('/portal')

  const locale = getLocale(user)

  // Hub on for this company: Customers is a tab inside Invoices now. The old address keeps working
  // (bookmarks, emails, the Guide) by sending clients there. Team members keep this page.
  if (contactId && isInvoiceHubOnFor(await getInvoiceHubSetting(), selectedAccountId)) {
    redirect('/portal/invoices?tab=customers')
  }

  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-4xl mx-auto space-y-4 sm:space-y-6">
      <CustomersPanel accountId={selectedAccountId} locale={locale} />
    </div>
  )
}
