import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { resolveInvoiceActor } from '@/lib/portal/invoice-actor'
import { getPortalAccounts } from '@/lib/portal/queries'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { cookies } from 'next/headers'
import { InvoiceForm } from '@/components/portal/invoice-form'
import { listTemplates } from '../actions'

export default async function NewInvoicePage() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/portal/login')

  // One identity decision: a team member (even with a contact id on the login) works on their own company
  // and needs the capability; a client picks among their companies.
  const actor = await resolveInvoiceActor(user, 'invoices_billing')
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
