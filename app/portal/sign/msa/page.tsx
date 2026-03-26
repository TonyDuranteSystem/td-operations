/**
 * Portal MSA Signing Page — Embeds the offer contract page inside the portal.
 *
 * Server component that:
 * 1. Gets the logged-in user's contact ID and selected account
 * 2. Finds the renewal offer linked to that account
 * 3. Embeds the offer/contract page in an iframe with ?portal=true
 */

export const dynamic = 'force-dynamic'

import { createClient } from '@/lib/supabase/server'
import { getClientContactId } from '@/lib/portal-auth'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { getPortalAccounts } from '@/lib/portal/queries'
import { APP_BASE_URL } from '@/lib/config'
import { PortalMSAClient } from './portal-msa-client'
import { cookies } from 'next/headers'

export default async function PortalSignMSAPage() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    return (
      <div className="flex items-center justify-center h-[60vh]">
        <p className="text-zinc-500">Please log in to view your documents.</p>
      </div>
    )
  }

  const contactId = getClientContactId(user)
  if (!contactId) {
    return (
      <div className="flex items-center justify-center h-[60vh]">
        <p className="text-zinc-500">No contact associated with your account.</p>
      </div>
    )
  }

  const accounts = await getPortalAccounts(contactId)
  const cookieStore = cookies()
  const cookieAccountId = (await cookieStore).get('portal_account_id')?.value
  const selectedAccountId = accounts.length > 0
    ? (accounts.find(a => a.id === cookieAccountId)?.id ?? accounts[0].id)
    : ''

  if (!selectedAccountId) {
    return (
      <div className="flex items-center justify-center h-[60vh]">
        <div className="text-center space-y-2">
          <p className="text-zinc-500 text-lg">No company found.</p>
          <p className="text-zinc-400 text-sm">Your Annual Service Agreement will appear here once your company is set up.</p>
        </div>
      </div>
    )
  }

  // Find the renewal MSA offer for this account (most recent)
  const { data: msa } = await supabaseAdmin
    .from('offers')
    .select('token, access_code, status, client_name, language, effective_date')
    .eq('account_id', selectedAccountId)
    .eq('contract_type', 'renewal')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (!msa) {
    return (
      <div className="flex items-center justify-center h-[60vh]">
        <div className="text-center space-y-2">
          <p className="text-zinc-500 text-lg">No Annual Service Agreement found.</p>
          <p className="text-zinc-400 text-sm">Your agreement will appear here once it has been generated.</p>
        </div>
      </div>
    )
  }

  // Construct URL — the offer contract page with portal=true
  const msaUrl = `${APP_BASE_URL}/offer/${msa.token}/contract?portal=true`
  const isSigned = msa.status === 'signed' || msa.status === 'completed'
  const year = msa.effective_date ? new Date(msa.effective_date).getFullYear() : new Date().getFullYear()

  return (
    <PortalMSAClient
      msaUrl={msaUrl}
      status={isSigned ? 'signed' : 'draft'}
      companyName={msa.client_name}
      language={msa.language || 'en'}
      contractYear={year}
    />
  )
}
