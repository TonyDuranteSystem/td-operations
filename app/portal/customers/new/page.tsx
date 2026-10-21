import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { resolveInvoiceActor } from '@/lib/portal/invoice-actor'
import { getPortalAccounts } from '@/lib/portal/queries'
import { cookies } from 'next/headers'
import { NewCustomerForm } from '@/components/portal/new-customer-form'

export default async function NewCustomerPage() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/portal/login')

  // One identity decision: a team member (even with a contact id on the login) works on their own company
  // and needs the capability; a client picks among their companies.
  const actor = await resolveInvoiceActor(user, 'sales_customers')
  if (!actor) redirect('/portal')

  let selectedAccountId: string | undefined
  if (actor.kind === 'teammate') {
    selectedAccountId = actor.accountId
  } else {
    const accounts = await getPortalAccounts(actor.contactId)
    const cookieAccountId = (await cookies()).get('portal_account_id')?.value
    selectedAccountId = accounts.find(a => a.id === cookieAccountId)?.id ?? accounts[0]?.id
  }
  if (!selectedAccountId) redirect('/portal')

  return (
    <div className="p-6 lg:p-8 max-w-lg mx-auto">
      <NewCustomerForm accountId={selectedAccountId} />
    </div>
  )
}
