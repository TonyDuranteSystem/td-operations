import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { getClientContactId } from '@/lib/portal-auth'
import { getPortalAccounts, getPortalAccountDetail } from '@/lib/portal/queries'
import { NextResponse } from 'next/server'

export async function GET() {
  const supabase = createClient()
  const { data: { user }, error: authError } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ step: 'auth', error: 'No user', authError: authError?.message })
  }

  const contactId = getClientContactId(user)
  const accounts = contactId ? await getPortalAccounts(contactId) : []
  const firstAccountId = accounts[0]?.id ?? null
  const accountDetail = firstAccountId ? await getPortalAccountDetail(firstAccountId) : null

  // Try direct detail query with error capture
  let directDetail = null
  if (firstAccountId) {
    const { data, error } = await supabaseAdmin
      .from('accounts')
      .select('id, company_name, entity_type, state_of_formation, ein_number, formation_date, status, physical_address, registered_agent, ra_renewal_date, filing_id, invoice_logo_url, bank_details, payment_gateway, payment_link')
      .eq('id', firstAccountId)
      .single()
    directDetail = { data: data ? { id: data.id, name: data.company_name } : null, error: error?.message }
  }

  // Also try direct query
  let directQuery = null
  if (contactId) {
    const { data, error } = await supabaseAdmin
      .from('account_contacts')
      .select('account_id')
      .eq('contact_id', contactId)
    directQuery = { data, error: error?.message }
  }

  return NextResponse.json({
    step: 'complete',
    user_id: user.id,
    email: user.email,
    role: user.app_metadata?.role,
    contact_id: contactId,
    accounts_count: accounts.length,
    accounts: accounts.map(a => ({ id: a.id, name: a.company_name })),
    first_account_id: firstAccountId,
    account_detail: accountDetail ? { id: accountDetail.id, name: accountDetail.company_name } : null,
    direct_detail: directDetail,
    direct_query: directQuery,
  })
}
