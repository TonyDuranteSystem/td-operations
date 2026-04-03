/**
 * Portal OA Signing Page — Embeds the existing OA page inside the portal.
 *
 * Server component that:
 * 1. Gets the logged-in user's contact ID and selected account
 * 2. Finds the OA linked to that account
 * 3. For MMLLC: resolves the current user's oa_signatures record
 * 4. Embeds the existing OA page in an iframe with auto-verification
 *
 * The iframe reuses the existing OA signing page without duplication.
 * Access code is passed directly — no email gate needed.
 * ?portal=true tells the embedded page to hide external chrome and
 * send postMessage on sign completion.
 * ?signer={access_code} identifies which MMLLC member is signing.
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

  // Find the OA for this account (most recent)
  const { data: oa } = await supabaseAdmin
    .from('oa_agreements')
    .select('token, access_code, status, company_name, language, entity_type, total_signers, signed_count, id')
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

  const isMultiSigner = oa.entity_type === 'MMLLC' && (oa.total_signers || 1) > 1

  // For MMLLC: find this user's signature record
  let signerParam = ''
  let memberStatus: string | null = null
  let signedCount = oa.signed_count || 0
  const totalSigners = oa.total_signers || 1

  if (isMultiSigner) {
    const { data: memberSig } = await supabaseAdmin
      .from('oa_signatures')
      .select('access_code, status, member_name')
      .eq('oa_id', oa.id)
      .eq('contact_id', contactId)
      .maybeSingle()

    if (memberSig) {
      signerParam = `&signer=${memberSig.access_code}`
      memberStatus = memberSig.status
    }

    // Get up-to-date signed count
    const { data: sigs } = await supabaseAdmin
      .from('oa_signatures')
      .select('status')
      .eq('oa_id', oa.id)
    signedCount = sigs?.filter(s => s.status === 'signed').length ?? 0
  }

  // If member already signed and OA not fully signed, show progress
  if (isMultiSigner && memberStatus === 'signed' && oa.status !== 'signed') {
    return (
      <div className="flex items-center justify-center h-[60vh]">
        <div className="text-center space-y-3 max-w-md">
          <div className="w-12 h-12 bg-emerald-100 rounded-full flex items-center justify-center mx-auto">
            <svg className="w-6 h-6 text-emerald-600" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
            </svg>
          </div>
          <p className="text-zinc-700 text-lg font-medium">You Have Already Signed</p>
          <p className="text-zinc-500 text-sm">
            {signedCount} of {totalSigners} members have signed the Operating Agreement for {oa.company_name}.
            It will be finalized once all members sign.
          </p>
          <div className="w-full bg-zinc-200 rounded-full h-2 mt-4">
            <div
              className="bg-emerald-500 h-2 rounded-full transition-all"
              style={{ width: `${(signedCount / totalSigners) * 100}%` }}
            />
          </div>
          <p className="text-zinc-400 text-xs">{signedCount}/{totalSigners} signed</p>
        </div>
      </div>
    )
  }

  // Construct URL with portal=true (and signer param for MMLLC)
  const oaUrl = `${APP_BASE_URL}/operating-agreement/${oa.token}/${oa.access_code}?portal=true${signerParam}`

  return (
    <div>
      {/* Progress banner for MMLLC */}
      {isMultiSigner && oa.status !== 'signed' && (
        <div className="bg-blue-50 border-b border-blue-200 px-4 py-2 text-center text-sm text-blue-700">
          <strong>{signedCount} of {totalSigners}</strong> members have signed
          {memberStatus !== 'signed' && ' — your signature is needed'}
        </div>
      )}
      <PortalOAClient
        oaUrl={oaUrl}
        status={oa.status}
        companyName={oa.company_name}
        language={oa.language}
      />
    </div>
  )
}
