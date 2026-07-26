/**
 * Shared assembly of a client's signable documents.
 *
 * Single source of truth for BOTH the Sign Documents page (which renders the
 * list) and the Sign-tab "new" badge in the sidebar (which counts the ones
 * still awaiting signature). Keeping one assembly means the tab count can never
 * drift from what the page actually shows.
 *
 * Extracted verbatim from app/portal/sign/page.tsx (2026-07-26).
 */

import { supabaseAdmin } from '@/lib/supabase-admin'
import { normalizeEntityType } from '@/lib/portal/entity-type'

export interface SignableDocument {
  type: 'oa' | 'lease' | 'ss4' | 'msa' | '8832' | 'document'
  status: 'pending' | 'awaiting' | 'signed'
  href: string
  companyName?: string
  suiteNumber?: string
  signedAt?: string
  contractYear?: number
  driveLink?: string // set for legacy docs pulled from documents table
  documentName?: string // for generic signature_requests
}

export interface GetSignableDocumentsParams {
  selectedAccountId: string
  contactId: string
  /** Login email — matches e-sign envelopes where the signer predates contact linking. */
  userEmail?: string | null
  /**
   * Skip the legacy-Drive already-signed fallback. That block only surfaces
   * documents that are already SIGNED (status 'signed'), so it never affects a
   * "still awaiting" count — the badge path skips it to save a query.
   */
  skipLegacyDrive?: boolean
}

/**
 * Build the list of a client's signable documents for one account, exactly as
 * the Sign Documents page shows them. Order and status rules are preserved.
 */
export async function getSignableDocuments(params: GetSignableDocumentsParams): Promise<SignableDocument[]> {
  const { selectedAccountId, contactId, userEmail, skipLegacyDrive } = params
  if (!selectedAccountId) return []

  // Query OA, Lease, SS-4, Form 8832, renewal MSA, generic signature requests, and e-sign envelopes in parallel
  const [oaResult, leaseResult, ss4Result, msaResult, form8832Result, sigReqResult, esignResult] = await Promise.all([
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
    // Annual renewal MSA — annual_agreements linked to this account
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (supabaseAdmin as any)
      .from('annual_agreements')
      .select('token, status, client_name, agreement_year')
      .eq('account_id', selectedAccountId)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle() as Promise<{ data: { token: string; status: string; client_name: string | null; agreement_year: number | null } | null }>,
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
    // E-sign envelopes where the logged-in client is an invited signer — matched
    // by their linked CRM contact (robust — survives login/contact email drift),
    // OR by the exact login email (covers signers added before contact linking).
    // Two SEPARATE queries, NOT a single `.or(email.ilike.<email>)`: an email
    // with a `_`/`%` would act as a LIKE wildcard and surface ANOTHER client's
    // signer (cross-client leak). The email is matched case-insensitively but
    // wildcard-escaped so it matches literally only.
    (async () => {
      const sel = 'token, status, signed_at, esign_envelopes!inner(document_name, status)'
      const email = (userEmail || '').toLowerCase().trim()
      const escaped = email.replace(/([%_\\])/g, '\\$1')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const adminAny = supabaseAdmin as any
      const [byContact, byEmail] = await Promise.all([
        adminAny.from('esign_signers').select(sel).eq('contact_id', contactId).in('status', ['sent', 'viewed']),
        email
          ? adminAny.from('esign_signers').select(sel).ilike('email', escaped).in('status', ['sent', 'viewed'])
          : Promise.resolve({ data: [] }),
      ])
      const seen = new Set<string>()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const merged = ([...(byContact.data ?? []), ...(byEmail.data ?? [])] as any[]).filter(r => {
        if (seen.has(r.token)) return false
        seen.add(r.token)
        return true
      })
      return { data: merged as Array<{ token: string; status: string; signed_at: string | null; esign_envelopes: { document_name: string | null; status: string } }> }
    })(),
  ])

  const documents: SignableDocument[] = []

  // MSA first — most important annual document
  if (msaResult.data) {
    const msa = msaResult.data
    const isSigned = msa.status === 'signed' || msa.status === 'completed'
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const year = (msa as any).agreement_year ?? new Date().getUTCFullYear()
    documents.push({
      type: 'msa',
      status: isSigned ? 'signed' : 'awaiting',
      href: '/portal/sign/msa',
      companyName: msa.client_name,
      contractYear: year,
      signedAt: undefined,
    })
  }

  // Only surface an OA the client can actually act on. An OA is created 'draft'
  // and becomes 'sent' when sent for signature (lib/mcp/tools/oa.ts), so a draft
  // (or voided) OA was never sent — it must not appear on the client's sign page.
  if (oaResult.data && oaResult.data.status !== 'draft' && oaResult.data.status !== 'voided') {
    const oa = oaResult.data as typeof oaResult.data & { total_signers?: number; signed_count?: number; entity_type?: string; id?: string }
    const isMultiSigner = normalizeEntityType(oa.entity_type) === 'MMLLC' && (oa.total_signers || 1) > 1
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

  // Same as OA: a 'draft' lease was never sent to the client.
  if (leaseResult.data && leaseResult.data.status !== 'draft' && leaseResult.data.status !== 'voided') {
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
    // Only 'awaiting_signature' is actionable. 'draft' means staff are still
    // reviewing — it must NOT render as signable (the old `!== 'signed' →
    // awaiting` mapping showed Michele Cotti a "Sign your SS-4" card for a
    // draft that was never sent, 2026-07-02). 'signed'/'submitted'/'done' are
    // all past signing → treated as signed (hidden from the To-sign list).
    if (ss4.status !== 'draft') {
      documents.push({
        type: 'ss4',
        status: ss4.status === 'awaiting_signature' ? 'awaiting' : 'signed',
        href: '/portal/sign/ss4',
        companyName: ss4.company_name,
        signedAt: ss4.signed_at,
      })
    }
  }

  if (form8832Result.data) {
    const f8832 = form8832Result.data
    // Draft = staff still preparing, never sent to the client — must not render
    // as signable (mirrors the SS-4/OA/lease draft guards above; same
    // Michele-Cotti class, and the new Sign-tab badge would otherwise pulse
    // portal-wide for an unsent draft). 8832 flips to 'awaiting_signature' when
    // the client first opens it.
    if (f8832.status !== 'draft') {
      documents.push({
        type: '8832',
        status: f8832.status === 'signed' ? 'signed' : 'awaiting',
        href: '/portal/sign/8832',
        companyName: f8832.company_name,
        signedAt: f8832.signed_at,
      })
    }
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

  // E-sign envelopes addressed to this client (matched by login email above).
  // Surface only those whose envelope is still active and where it's this
  // signer's turn (status sent/viewed). The embed page re-checks ownership.
  if (esignResult.data) {
    for (const s of esignResult.data) {
      const env = s.esign_envelopes
      if (!env || !['sent', 'in_progress'].includes(env.status)) continue
      documents.push({
        type: 'document',
        status: 'awaiting',
        href: `/portal/sign/esign?token=${s.token}`,
        documentName: env.document_name || 'Document',
        signedAt: s.signed_at || undefined,
      })
    }
  }

  // Fallback: legacy clients may have signed docs in Drive but no formal signature records.
  // Check the documents table for any missing types and surface them as already-signed.
  // Skipped for the count path — these are always 'signed' and never affect the badge.
  if (!skipLegacyDrive) {
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
  }

  return documents
}

/**
 * Count documents still awaiting this client's signature for the selected
 * account — drives the Sign-tab "new" badge. Reuses the exact page assembly so
 * the badge can never disagree with the list, and skips the already-signed
 * legacy-Drive lookup.
 */
export async function getToSignCount(params: GetSignableDocumentsParams): Promise<number> {
  if (!params.selectedAccountId || !params.contactId) return 0
  const docs = await getSignableDocuments({ ...params, skipLegacyDrive: true })
  return docs.filter(d => d.status !== 'signed').length
}
