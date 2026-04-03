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
  type: 'oa' | 'lease' | 'ss4' | 'msa' | '8832' | 'document'
  status: 'pending' | 'awaiting' | 'signed'
  href: string
  companyName?: string
  suiteNumber?: string
  signedAt?: string
  contractYear?: number
  driveLink?: string  // set for legacy docs pulled from documents table
  documentName?: string  // for generic signature_requests
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

  // Query OA, Lease, SS-4, Form 8832, renewal MSA, and generic signature requests in parallel
  const [oaResult, leaseResult, ss4Result, msaResult, form8832Result, sigReqResult] = await Promise.all([
    supabaseAdmin
      .from('oa_agreements')
      .select('id, token, status, company_name, signed_at, entity_type, total_signers, signed_count')
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
    // Annual renewal MSA — offers with contract_type='renewal' linked to this account
    supabaseAdmin
      .from('offers')
      .select('token, status, client_name, effective_date')
      .eq('account_id', selectedAccountId)
      .eq('contract_type', 'renewal')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    // Form 8832 — C-Corp election
    supabaseAdmin
      .from('form_8832_applications')
      .select('token, status, company_name, signed_at')
      .eq('account_id', selectedAccountId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle(),
    // Generic signature requests (Form 8879, engagement letters, etc.)
    supabaseAdmin
      .from('signature_requests')
      .select('token, access_code, status, document_name, signed_at')
      .eq('account_id', selectedAccountId)
      .order('created_at', { ascending: false }),
  ])

  const documents: SignableDocument[] = []

  // MSA first — most important annual document
  if (msaResult.data) {
    const msa = msaResult.data
    const isSigned = msa.status === 'signed' || msa.status === 'completed'
    const year = msa.effective_date ? new Date(msa.effective_date).getFullYear() : new Date().getFullYear()
    documents.push({
      type: 'msa',
      status: isSigned ? 'signed' : 'awaiting',
      href: '/portal/sign/msa',
      companyName: msa.client_name,
      contractYear: year,
      signedAt: isSigned ? msa.effective_date : undefined,
    })
  }

  if (oaResult.data) {
    const oa = oaResult.data as typeof oaResult.data & { total_signers?: number; signed_count?: number; entity_type?: string; id?: string }
    const isMultiSigner = oa.entity_type === 'MMLLC' && (oa.total_signers || 1) > 1
    let oaStatus: SignableDocument['status'] = oa.status === 'signed' ? 'signed' : 'awaiting'

    // For MMLLC: check if the current user has already signed
    if (isMultiSigner && oa.status !== 'signed' && oa.id) {
      const { data: memberSig } = await supabaseAdmin
        .from('oa_signatures')
        .select('status')
        .eq('oa_id', oa.id)
        .eq('contact_id', contactId)
        .maybeSingle()

      if (memberSig?.status === 'signed') {
        oaStatus = 'signed' // This member signed, show as signed for them
      }
    }

    documents.push({
      type: 'oa',
      status: oaStatus,
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

  if (form8832Result.data) {
    const f8832 = form8832Result.data
    documents.push({
      type: '8832',
      status: f8832.status === 'signed' ? 'signed' : 'awaiting',
      href: '/portal/sign/8832',
      companyName: f8832.company_name,
      signedAt: f8832.signed_at,
    })
  }

  // Generic signature requests (Form 8879, etc.)
  if (sigReqResult.data) {
    for (const sr of sigReqResult.data) {
      documents.push({
        type: 'document',
        status: sr.status === 'signed' ? 'signed' : 'awaiting',
        href: `/portal/sign/document?token=${sr.token}`,
        documentName: sr.document_name,
        signedAt: sr.signed_at,
      })
    }
  }

  // Fallback: legacy clients may have signed docs in Drive but no formal signature records.
  // Check the documents table for any missing types and surface them as already-signed.
  const DOC_DRIVE_MAP: Record<string, SignableDocument['type']> = {
    'Operating Agreement': 'oa',
    'Office Lease': 'lease',
    'Form SS-4': 'ss4',
  }
  const coveredTypes = new Set(documents.map(d => d.type))
  const missingDocNames = Object.entries(DOC_DRIVE_MAP)
    .filter(([, type]) => !coveredTypes.has(type))
    .map(([name]) => name)

  if (missingDocNames.length > 0) {
    const { data: legacyDocs } = await supabaseAdmin
      .from('documents')
      .select('document_type_name, drive_link, processed_at')
      .eq('account_id', selectedAccountId)
      .in('document_type_name', missingDocNames)
      .not('drive_link', 'is', null)
      .order('processed_at', { ascending: false })

    if (legacyDocs) {
      const seen = new Set<string>()
      for (const doc of legacyDocs) {
        const docType = DOC_DRIVE_MAP[doc.document_type_name ?? '']
        if (!docType || seen.has(docType)) continue
        seen.add(docType)
        documents.push({
          type: docType,
          status: 'signed',
          href: doc.drive_link!,
          driveLink: doc.drive_link!,
        })
      }
    }
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
