import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { getClientContactId } from '@/lib/portal-auth'
import { getPortalAccounts } from '@/lib/portal/queries'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { cookies } from 'next/headers'
import { InvoiceForm } from '@/components/portal/invoice-form'
import { listTemplates } from '../actions'

export default async function NewInvoicePage() {
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

  // Fetch customers and templates for this account
  const { data: customers } = await supabaseAdmin
    .from('client_customers')
    .select('id, name, email')
    .eq('account_id', selectedAccountId)
    .order('name')

  const templates = await listTemplates(selectedAccountId)

  return (
    <div className="p-6 lg:p-8 max-w-4xl mx-auto">
      <InvoiceForm
        accountId={selectedAccountId}
        customers={customers ?? []}
        templates={templates}
        mode="create"
      />
    </div>
  )
}
