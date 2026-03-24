/**
 * Portal OA Signing Page — Embeds the existing OA page inside the portal.
 *
 * Server component that:
 * 1. Gets the logged-in user's contact ID and selected account
 * 2. Finds the OA linked to that account
 * 3. Embeds the existing OA page in an iframe with auto-verification
 *
 * The iframe reuses the existing OA signing page without duplication.
 * Access code is passed directly — no email gate needed.
 * ?portal=true tells the embedded page to hide external chrome and
 * send postMessage on sign completion.
 */

export const dynamic = 'force-dynamic'

import { createClient } from '@/lib/supabase/server'
import { getClientContactId } from '@/lib/portal-auth'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { getPortalAccounts } from '@/lib/portal/queries'
import { APP_BASE_URL } from '@/lib/config'
import { PortalOAClient } from './portal-oa-client'
import { cookies } from 'next/headers'

export default async function PortalSignOAPage() {
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

  // Get selected account — from cookie or fallback to first account
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
          <p className="text-zinc-400 text-sm">Your Operating Agreement will appear here once your company is set up.</p>
        </div>
      </div>
    )
  }

  // Find the OA for this account (most recent, not expired)
  const { data: oa } = await supabaseAdmin
    .from('oa_agreements')
    .select('token, access_code, status, company_name, language')
    .eq('account_id', selectedAccountId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (!oa) {
    return (
      <div className="flex items-center justify-center h-[60vh]">
        <div className="text-center space-y-2">
          <p className="text-zinc-500 text-lg">No Operating Agreement found.</p>
          <p className="text-zinc-400 text-sm">Your Operating Agreement will appear here once it has been generated.</p>
        </div>
      </div>
    )
  }

  // Construct URL with portal=true to trigger portal-aware mode
  const oaUrl = `${APP_BASE_URL}/operating-agreement/${oa.token}/${oa.access_code}?portal=true`

  return (
    <PortalOAClient
      oaUrl={oaUrl}
      status={oa.status}
      companyName={oa.company_name}
      language={oa.language}
    />
  )
}
