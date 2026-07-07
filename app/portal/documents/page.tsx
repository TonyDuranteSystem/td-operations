import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { getClientContactId } from '@/lib/portal-auth'
import { getPortalAccounts, getInvoiceArchive } from '@/lib/portal/queries'
import { getTeammateScopeOrNull } from '@/lib/portal/team/gate'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { cookies } from 'next/headers'
import { DocumentList } from '@/components/portal/document-list'
import { getNewDocumentIds } from '@/lib/portal/document-alerts'
import { DocumentUploadButton } from '@/components/portal/document-upload-button'
import { CorrespondenceList } from '@/components/portal/correspondence-list'
import { t, getLocale } from '@/lib/portal/i18n'
import { FileText, Mail, Building2, User, Layers } from 'lucide-react'
import { InvoiceArchive } from '@/components/portal/invoice-archive'

export const dynamic = 'force-dynamic'

// Company categories: shared with all account members
const COMPANY_CATEGORIES = [1, 3, 4, 5] // Company, Tax, Banking, Correspondence

const CATEGORY_LABELS: Record<number, string> = {
  1: 'Company',
  2: 'Contacts',
  3: 'Tax',
  4: 'Banking',
  5: 'Correspondence',
}

export default async function PortalDocumentsPage() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/portal/login')

  const contactId = getClientContactId(user)

  let selectedAccountId: string | undefined
  let accountIds: string[]
  if (contactId) {
    const accounts = await getPortalAccounts(contactId)
    const cookieStore = cookies()
    const cookieAccountId = (await cookieStore).get('portal_account_id')?.value
    selectedAccountId = accounts.find(a => a.id === cookieAccountId)?.id ?? accounts[0]?.id
    accountIds = accounts.map(a => a.id)
  } else {
    // Teammate (Portal Team Access) — scoped to ONE company; requires the
    // 'documents' capability. Teammates see COMPANY documents only, never any
    // member's personal docs (no contact id → the personal-doc query is skipped).
    const tmAccountId = await getTeammateScopeOrNull(user, 'documents')
    if (!tmAccountId) redirect('/portal')
    selectedAccountId = tmAccountId
    accountIds = [tmAccountId]
  }

  const locale = getLocale(user)

  type DocRow = {
    id: string; file_name: string; document_type_name: string | null
    category: number | null; drive_file_id: string | null
    processed_at: string | null; created_at: string
    service_delivery_id: string | null
  }

  let companyDocs: DocRow[] = []
  let myDocs: DocRow[] = []
  // Flow-linked documents (stamped with service_delivery_id by the flow upload
  // route), grouped into per-flow sections ("Tax Return 2025", etc.). These are
  // pulled OUT of the Company/My lists below so they never appear twice.
  let flowGroups: { id: string; title: string; docs: DocRow[] }[] = []

  if (selectedAccountId) {
    // Company docs: shared categories (1,3,4,5) OR no contact assigned
    const { data: cdData } = await supabaseAdmin
      .from('documents')
      .select('id, file_name, document_type_name, category, drive_file_id, processed_at, created_at, service_delivery_id')
      .eq('account_id', selectedAccountId)
      .eq('portal_visible', true)
      .or(`category.in.(${COMPANY_CATEGORIES.join(',')}),contact_id.is.null`)
      .order('created_at', { ascending: false })
      .limit(100)
    // Personal documents (category 2 = Contacts) must NEVER surface as company-
    // wide docs — not even when their owner is unresolved (contact_id null),
    // which the `contact_id.is.null` branch above would otherwise let through.
    // They appear ONLY in "My Documents" for their owner; an ownerless personal
    // doc stays hidden from all clients until an admin assigns it. This closes a
    // multi-member leak where an unassigned passport could be shown to everyone.
    companyDocs = ((cdData ?? []) as unknown as DocRow[]).filter(d => d.category !== 2)

    // My docs: personal category (Contacts = 2) belonging to this contact only.
    // Teammates have no contact id → they NEVER see anyone's personal docs.
    if (contactId) {
      const { data: mdData } = await supabaseAdmin
        .from('documents')
        .select('id, file_name, document_type_name, category, drive_file_id, processed_at, created_at, service_delivery_id')
        .eq('account_id', selectedAccountId)
        .eq('contact_id', contactId)
        .eq('category', 2)
        .eq('portal_visible', true)
        .order('created_at', { ascending: false })
        .limit(50)
      // PLUS the contact's person-level documents (account_id NULL — e.g. an
      // ITIN letter; the ITIN flow is contact-scoped by design). Before this
      // query, an LLC-owning client could never see them: every query in this
      // branch filtered by the selected account (Martin Csordas, 2026-07-07).
      // Non-flow rows only — flow-stamped ones join the flow groups below.
      const { data: pdData } = await supabaseAdmin
        .from('documents')
        .select('id, file_name, document_type_name, category, drive_file_id, processed_at, created_at, service_delivery_id')
        .is('account_id', null)
        .eq('contact_id', contactId)
        .is('service_delivery_id', null)
        .eq('portal_visible', true)
        .order('created_at', { ascending: false })
        .limit(50)
      myDocs = [...((mdData ?? []) as unknown as DocRow[]), ...((pdData ?? []) as unknown as DocRow[])]
    }

    // Flow-linked docs — queried independently of category so any SD-stamped
    // document can be grouped, then removed from Company/My to avoid duplicates.
    // We do NOT filter portal_visible in SQL: flow docs are written
    // portal_visible=false by default and the client sees a CURATED allowlist of
    // client-safe stages (isClientSafeFlowDoc) — the unsigned "Tax Return
    // Prepared" draft is excluded. `service_delivery_id` / `flow_stage` aren't in
    // the generated Supabase types yet (flow migration), so the client is cast.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: flowData } = await (supabaseAdmin as any)
      .from('documents')
      .select('id, file_name, document_type_name, category, drive_file_id, processed_at, created_at, service_delivery_id, flow_stage, portal_visible')
      .eq('account_id', selectedAccountId)
      .not('service_delivery_id', 'is', null)
      .order('created_at', { ascending: false })
      .limit(200)
    // PLUS the contact's person-level flow docs (contact-scoped SDs: ITIN,
    // in-flight formation). Same curated visibility below applies.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: contactFlowData } = contactId
      ? await (supabaseAdmin as any)
          .from('documents')
          .select('id, file_name, document_type_name, category, drive_file_id, processed_at, created_at, service_delivery_id, flow_stage, portal_visible')
          .is('account_id', null)
          .eq('contact_id', contactId)
          .not('service_delivery_id', 'is', null)
          .order('created_at', { ascending: false })
          .limit(100)
      : { data: [] }
    const flowDocsRaw = ([...(flowData ?? []), ...(contactFlowData ?? [])]) as (DocRow & { flow_stage: string | null; portal_visible: boolean | null })[]

    if (flowDocsRaw.length > 0) {
      // Resolve each SD's type + a client-facing title ("Tax Return 2025").
      const sdIds = Array.from(new Set(flowDocsRaw.map(d => d.service_delivery_id).filter((v): v is string => !!v)))
      const { deriveFlowYear, buildFlowTopic } = await import('@/lib/flows/resolve-flows')
      const { isClientSafeFlowDoc } = await import('@/lib/flows/flow-doc-visibility')
      const { data: sdRows } = await supabaseAdmin
        .from('service_deliveries')
        .select('id, service_type, service_name, due_date, stage_entered_at, created_at')
        .in('id', sdIds)
      const sdMeta = new Map((sdRows ?? []).map(sd => {
        const year = deriveFlowYear(sd)
        const title = buildFlowTopic(sd.service_type, year) || sd.service_name || sd.service_type || 'Service'
        return [sd.id as string, { title: title as string, serviceType: sd.service_type as string | null }]
      }))

      // CURATED visibility: keep only flow docs from client-safe stages (or any
      // an admin explicitly published). The unsigned prepared return is dropped.
      const flowDocs = flowDocsRaw.filter(d => {
        const meta = d.service_delivery_id ? sdMeta.get(d.service_delivery_id) : undefined
        return isClientSafeFlowDoc(meta?.serviceType, d.flow_stage, d.portal_visible)
      })

      const flowIds = new Set(flowDocs.map(d => d.id))
      companyDocs = companyDocs.filter(d => !flowIds.has(d.id))
      myDocs = myDocs.filter(d => !flowIds.has(d.id))

      // Group, preserving the newest-first order SDs first appear in.
      const order: string[] = []
      const byId = new Map<string, DocRow[]>()
      for (const d of flowDocs) {
        const key = d.service_delivery_id as string
        if (!byId.has(key)) { byId.set(key, []); order.push(key) }
        byId.get(key)!.push(d)
      }
      flowGroups = order.map(id => ({
        id,
        title: sdMeta.get(id)?.title ?? 'Service',
        docs: byId.get(id)!,
      }))
    }
  } else {
    // Contact-only clients (ITIN, no LLC) — all docs are personal
    const { data } = await supabaseAdmin
      .from('documents')
      .select('id, file_name, document_type_name, category, drive_file_id, processed_at, created_at, service_delivery_id')
      .eq('contact_id', contactId)
      .eq('portal_visible', true)
      .order('created_at', { ascending: false })
      .limit(100)
    myDocs = (data ?? []) as unknown as DocRow[]
  }

  // Fetch correspondence (contact-centric for clients: direct + linked accounts;
  // teammates: account-scoped only — they have no contact id).
  const orFilter = [
    contactId ? `contact_id.eq.${contactId}` : null,
    accountIds.length > 0 ? `account_id.in.(${accountIds.join(',')})` : null,
  ].filter(Boolean).join(',')

  const { data: correspondence } = orFilter
    ? await supabaseAdmin
        .from('client_correspondence')
        .select('id, file_name, description, drive_file_url, read_at, created_at, account_id')
        .or(orFilter)
        .order('created_at', { ascending: false })
    : { data: [] as { id: string; file_name: string; description: string | null; drive_file_url: string | null; read_at: string | null; created_at: string; account_id: string | null }[] }

  const unreadCount = (correspondence ?? []).filter(c => !c.read_at).length

  // Fetch invoice archive documents
  const invoiceArchive = selectedAccountId ? await getInvoiceArchive(selectedAccountId) : []

  // Which documents are "new" (alert-eligible + unopened) for THIS contact —
  // drives the "New" pill + tinted row. Teammates have no per-person state.
  const allDocIds = [...companyDocs, ...myDocs, ...flowGroups.flatMap(g => g.docs)].map(d => d.id)
  const newDocIds = contactId
    ? Array.from(await getNewDocumentIds(allDocIds, contactId))
    : []

  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-5xl mx-auto space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h1 className="text-xl sm:text-2xl font-semibold tracking-tight text-zinc-900">{t('documents.title', locale)}</h1>
          <p className="text-zinc-500 text-xs sm:text-sm mt-1">{t('documents.subtitle', locale)}</p>
        </div>
        {selectedAccountId && <DocumentUploadButton accountId={selectedAccountId} />}
      </div>

      {/* Correspondence section — shown only if there is any */}
      {(correspondence && correspondence.length > 0) && (
        <div className="bg-white rounded-xl border shadow-sm overflow-hidden">
          <div className="flex items-center gap-2 px-5 py-4 border-b bg-zinc-50">
            <Mail className="h-4 w-4 text-zinc-500" />
            <span className="text-sm font-semibold text-zinc-800">Correspondence</span>
            {unreadCount > 0 && (
              <span className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-medium bg-red-100 text-red-700">
                {unreadCount} new
              </span>
            )}
          </div>
          <CorrespondenceList items={correspondence} />
        </div>
      )}

      {/* Invoice Archive — organized by year/month */}
      {invoiceArchive.length > 0 && (
        <InvoiceArchive items={invoiceArchive} />
      )}

      {/* Service Documents — grouped per flow (Tax Return 2025, Annual Report
          2026, …) from documents stamped with a service_delivery_id. */}
      {flowGroups.map(group => (
        <div key={group.id}>
          <div className="flex items-center gap-2 mb-3">
            <Layers className="h-4 w-4 text-zinc-500" />
            <h2 className="text-sm font-semibold text-zinc-700">{group.title}</h2>
          </div>
          <DocumentList documents={group.docs} categoryLabels={CATEGORY_LABELS} newDocIds={newDocIds} locale={locale} />
        </div>
      ))}

      {/* Documents — split into Company and My */}
      {companyDocs.length === 0 && myDocs.length === 0 && flowGroups.length === 0 ? (
        <div className="bg-white rounded-xl border shadow-sm p-12 text-center">
          <FileText className="h-12 w-12 text-zinc-300 mx-auto mb-3" />
          <h3 className="text-lg font-medium text-zinc-900 mb-1">{t('documents.noDocuments', locale)}</h3>
          <p className="text-sm text-zinc-500">{t('documents.noDocumentsDesc', locale)}</p>
        </div>
      ) : (
        <>
          {companyDocs.length > 0 && (
            <div>
              <div className="flex items-center gap-2 mb-3">
                <Building2 className="h-4 w-4 text-zinc-500" />
                <h2 className="text-sm font-semibold text-zinc-700">Company Documents</h2>
              </div>
              <DocumentList documents={companyDocs} categoryLabels={CATEGORY_LABELS} newDocIds={newDocIds} locale={locale} />
            </div>
          )}

          {myDocs.length > 0 && (
            <div>
              <div className="flex items-center gap-2 mb-3">
                <User className="h-4 w-4 text-zinc-500" />
                <h2 className="text-sm font-semibold text-zinc-700">My Documents</h2>
              </div>
              <DocumentList documents={myDocs} categoryLabels={CATEGORY_LABELS} newDocIds={newDocIds} locale={locale} />
            </div>
          )}
        </>
      )}
    </div>
  )
}
