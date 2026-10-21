export const dynamic = 'force-dynamic'

import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { resolveInvoiceActor } from '@/lib/portal/invoice-actor'
import { getPortalAccounts } from '@/lib/portal/queries'
import { isInvoiceHubOnFor } from '@/lib/portal/invoice-hub'
import { getInvoiceHubSetting } from '@/lib/settings'
import { getLocale } from '@/lib/portal/i18n'
import { cookies } from 'next/headers'
import { CustomersPanel } from '@/components/portal/customers-panel'

export default async function PortalCustomersPage() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/portal/login')

  // ONE identity decision (same as the Invoices pages): a team member needs 'sales_customers' and is scoped to their company.
  const actor = await resolveInvoiceActor(user, 'sales_customers')
  if (!actor) redirect('/portal')
  const contactId = actor.kind === 'contact' ? actor.contactId : null
  let selectedAccountId: string | undefined
  if (actor.kind === 'contact') {
    const accounts = await getPortalAccounts(actor.contactId)
    const cookieStore = cookies()
    const cookieAccountId = (await cookieStore).get('portal_account_id')?.value
    selectedAccountId = accounts.find(a => a.id === cookieAccountId)?.id ?? accounts[0]?.id
  } else {
    selectedAccountId = actor.accountId
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
      <CustomersPanel accountId={selectedAccountId} locale={locale} invoicesFrom={actor.kind === 'teammate' ? actor.historyStart : null} />
    </div>
  )
}
