/**
 * Portal Lease Signing Page — Embeds the existing Lease page inside the portal.
 *
 * Server component that:
 * 1. Gets the logged-in user's contact ID and selected account
 * 2. Finds the Lease linked to that account
 * 3. Embeds the existing Lease page in an iframe with auto-verification
 *
 * The iframe reuses the existing Lease signing page without duplication.
 * Access code is passed directly — no email gate needed.
 * ?portal=true tells the embedded page to hide external chrome and
 * send postMessage on sign completion.
 */

export const dynamic = 'force-dynamic'

import { createClient } from '@/lib/supabase/server'
import { getClientContactId } from '@/lib/portal-auth'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { APP_BASE_URL } from '@/lib/config'
import { PortalLeaseClient } from './portal-lease-client'
import { cookies } from 'next/headers'

export default async function PortalSignLeasePage() {
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

  // Get selected account from cookie
  const cookieStore = cookies()
  const selectedAccountId = (await cookieStore).get('portal_account_id')?.value

  if (!selectedAccountId) {
    return (
      <div className="flex items-center justify-center h-[60vh]">
        <div className="text-center space-y-2">
          <p className="text-zinc-500 text-lg">No company selected.</p>
          <p className="text-zinc-400 text-sm">Select a company from the sidebar to view its Lease Agreement.</p>
        </div>
      </div>
    )
  }

  // Find the Lease for this account (most recent)
  const { data: lease } = await supabaseAdmin
    .from('lease_agreements')
    .select('token, access_code, status, tenant_company, suite_number, language')
    .eq('account_id', selectedAccountId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle()

  if (!lease) {
    return (
      <div className="flex items-center justify-center h-[60vh]">
        <div className="text-center space-y-2">
          <p className="text-zinc-500 text-lg">No Lease Agreement found.</p>
          <p className="text-zinc-400 text-sm">Your Lease Agreement will appear here once it has been generated.</p>
        </div>
      </div>
    )
  }

  // Construct URL with portal=true to trigger portal-aware mode
  const leaseUrl = `${APP_BASE_URL}/lease/${lease.token}/${lease.access_code}?portal=true`

  return (
    <PortalLeaseClient
      leaseUrl={leaseUrl}
      status={lease.status}
      companyName={lease.tenant_company}
      suiteNumber={lease.suite_number}
      language={lease.language}
    />
  )
}
