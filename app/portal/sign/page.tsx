/**
 * Sign Documents Landing Page — Lists all pending documents for e-signature.
 *
 * Shows OA, Lease, and (future) SS-4 with their status.
 * Each document links to its dedicated signing page inside the portal.
 * When all documents are signed, shows a success state.
 */

export const dynamic = 'force-dynamic'

import { createClient } from '@/lib/supabase/server'
import { getClientContactId } from '@/lib/portal-auth'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { getPortalAccounts } from '@/lib/portal/queries'
import { cookies } from 'next/headers'
import { SignDocumentsClient } from './sign-documents-client'

export interface SignableDocument {
  type: 'oa' | 'lease' | 'ss4'
  status: 'pending' | 'awaiting' | 'signed'
  href: string
  companyName?: string
  suiteNumber?: string
  signedAt?: string
}

export default async function PortalSignPage() {
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
          <p className="text-zinc-400 text-sm">Your documents will appear here once your company is set up.</p>
        </div>
      </div>
    )
  }

  // Query OA, Lease, and SS-4 in parallel
  const [oaResult, leaseResult, ss4Result] = await Promise.all([
    supabaseAdmin
      .from('oa_agreements')
      .select('token, status, company_name, signed_at')
      .eq('account_id', selectedAccountId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabaseAdmin
      .from('lease_agreements')
      .select('token, status, tenant_company, suite_number, signed_at')
      .eq('account_id', selectedAccountId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    supabaseAdmin
      .from('ss4_applications')
      .select('token, status, company_name, signed_at')
      .eq('account_id', selectedAccountId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
  ])

  const documents: SignableDocument[] = []

  if (oaResult.data) {
    const oa = oaResult.data
    documents.push({
      type: 'oa',
      status: oa.status === 'signed' ? 'signed' : 'awaiting',
      href: '/portal/sign/oa',
      companyName: oa.company_name,
      signedAt: oa.signed_at,
    })
  }

  if (leaseResult.data) {
    const lease = leaseResult.data
    documents.push({
      type: 'lease',
      status: lease.status === 'signed' ? 'signed' : 'awaiting',
      href: '/portal/sign/lease',
      companyName: lease.tenant_company,
      suiteNumber: lease.suite_number,
      signedAt: lease.signed_at,
    })
  }

  if (ss4Result.data) {
    const ss4 = ss4Result.data
    documents.push({
      type: 'ss4',
      status: ss4.status === 'signed' ? 'signed' : 'awaiting',
      href: '/portal/sign/ss4',
      companyName: ss4.company_name,
      signedAt: ss4.signed_at,
    })
  }

  // Get company name from first available document or account
  const companyName = documents[0]?.companyName || accounts.find(a => a.id === selectedAccountId)?.company_name || ''

  return (
    <SignDocumentsClient
      documents={documents}
      companyName={companyName}
    />
  )
}
