import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { getClientContactId } from '@/lib/portal-auth'
import { getPortalAccounts } from '@/lib/portal/queries'
import { cookies } from 'next/headers'
import { NewCustomerForm } from '@/components/portal/new-customer-form'

export default async function NewCustomerPage() {
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

  return (
    <div className="p-6 lg:p-8 max-w-lg mx-auto">
      <NewCustomerForm accountId={selectedAccountId} />
    </div>
  )
}
