import Link from 'next/link'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { findAuthUserByEmail } from '@/lib/auth-admin-helpers'
import { notFound } from 'next/navigation'
import { ContactDetail } from '@/components/contacts/contact-detail'
import { ContactCallsSection } from '@/components/contacts/contact-calls-section'
import { resolveFlowsByContact } from '@/lib/flows/resolve-flows'
import { FormationWorkspaceBanner } from '@/components/flows/formation-workspace-banner'
import { ItinWorkspaceBanner } from '@/components/flows/itin-workspace-banner'
import { isDashboardUser } from '@/lib/auth'
import { ViewAsClientButton } from '@/components/accounts/view-as-client-button'
import type { LinkedAccount, ServiceDelivery, ConversationEntry } from '@/lib/types'
import type { OfferPackageOption } from '@/lib/types/offer'

export default async function ContactDetailPage({ params }: { params: { id: string } }) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  const today = new Date().toISOString().split('T')[0]

  // Fetch contact
  const { data: contact } = await supabase
    .from('contacts')
    .select('*')
    .eq('id', params.id)
    .single()

  if (!contact) notFound()

  // Fetch related data in parallel
  const [accountsResult, sdsResult, conversationsResult, leadResult, docsResult, offersResult, pendingActivationsResult, wizardProgressResult] = await Promise.all([
    // Linked accounts via junction
    supabase
      .from('account_contacts')
      .select('role, ownership_pct, account:accounts(id, company_name, entity_type, member_structure, status, state_of_formation, ein_number, account_type, autopay_card_enabled, autopay_card_last4)')
      .eq('contact_id', params.id),
    // Service deliveries (by contact_id directly OR by linked account_ids — we'll merge below)
    supabase
      .from('service_deliveries')
      .select('id, service_name, service_type, pipeline, stage, stage_order, status, assigned_to, account_id, contact_id, start_date, updated_at')
      .eq('contact_id', params.id)
      .is('account_id', null)
      .order('updated_at', { ascending: false }),
    // Conversations
    supabase
      .from('conversations')
      .select('id, topic, channel, direction, client_message, response_sent, category, handled_by, created_at')
      .eq('contact_id', params.id)
      .order('created_at', { ascending: false })
      .limit(50),
    // Lead origin
    supabase
      .from('leads')
      .select('id, full_name, status, source, channel, reason, call_date, created_at')
      .eq('email', contact.email ?? '__no_match__')
      .limit(1)
      .maybeSingle(),
    // Documents linked to this contact
    supabase
      .from('documents')
      .select('id, file_name, document_type_name, category_name, category, drive_file_id, drive_link, status, processed_at, mime_type, file_size, account_id, portal_visible')
      .eq('contact_id', params.id)
      .order('category', { ascending: true })
      .order('file_name', { ascending: true }),
    // Offers — by client_email or lead_id
    supabase
      .from('offers')
      // eslint-disable-next-line no-restricted-syntax -- packages/selected_package_key/package_locked_at postdate generated types (migration 20260826-1800)
      .select('id, token, client_email, status, contract_type, services, bundled_pipelines, selected_services, cost_summary, view_count, required_documents, created_at, viewed_at, expires_at, packages, selected_package_key, package_locked_at' as never)
      .eq('client_email', contact.email ?? '__no_match__')
      .order('created_at', { ascending: false }),
    // Pending activations — by client_email
    supabase
      .from('pending_activations')
      .select('id, offer_token, client_email, status, signed_at, payment_confirmed_at, activated_at, payment_method, amount, currency')
      .eq('client_email', contact.email ?? '__no_match__')
      .order('created_at', { ascending: false }),
    // Wizard progress — by contact_id
    supabase
      .from('wizard_progress')
      .select('id, contact_id, wizard_type, current_step, status, data, created_at, updated_at')
      .eq('contact_id', params.id)
      .order('updated_at', { ascending: false }),
  ])

  // Map linked accounts
  // A failure here previously fell through silently (accountsResult.data ??
  // []) — the contact would render as if it had zero linked companies, with
  // every downstream card (invoices, documents, Finance) disappearing along
  // with it. Logged, not surfaced to the client — this is a staff page and a
  // full error UI is a bigger change than this fix pass covers, but it must
  // not be invisible (council review, 2026-08-30).
  if (accountsResult.error) {
    console.error(`[contacts/${params.id}] linked-accounts query failed:`, accountsResult.error.message)
  }
  const accounts: LinkedAccount[] = (accountsResult.data ?? []).map(ac => {
    const a = ac.account as unknown as { id: string; company_name: string; entity_type: string | null; member_structure: 'single_member' | 'multi_member' | null; status: string | null; state_of_formation: string | null; ein_number: string | null; account_type: string | null; autopay_card_enabled: boolean | null; autopay_card_last4: string | null }
    return {
      id: a.id,
      company_name: a.company_name,
      entity_type: a.entity_type,
      member_structure: a.member_structure,
      status: a.status,
      state_of_formation: a.state_of_formation,
      ein: a.ein_number,
      role: ac.role,
      ownership_pct: ac.ownership_pct,
      account_type: a.account_type,
      autopay_card_enabled: a.autopay_card_enabled,
      autopay_card_last4: a.autopay_card_last4,
    }
  })


  // Fetch invoices and other data for linked accounts
  const accountIds = accounts.map(a => a.id)

  // Fetch invoices: contact-direct + via linked accounts
  const invoiceFields = 'id, description, amount, total, amount_currency, status, invoice_status, invoice_number, payment_method, paid_date, due_date, installment, amount_paid, amount_due, account_id, contact_id, portal_invoice_id, is_test, accounts:account_id(company_name)'
  const { data: contactInvoices } = await supabase
    .from('payments')
    .select(invoiceFields)
    .eq('contact_id', params.id)
    .order('due_date', { ascending: false })

  let accountInvoices: Record<string, unknown>[] = []
  if (accountIds.length > 0) {
    const { data: accInvData } = await supabase
      .from('payments')
      .select(invoiceFields)
      .in('account_id', accountIds)
      .order('due_date', { ascending: false })
    accountInvoices = accInvData ?? []
  }

  // Merge and deduplicate invoices by id
  const allInvoicesMap = new Map<string, Record<string, unknown>>()
  for (const inv of [...(contactInvoices ?? []), ...accountInvoices]) {
    if (!allInvoicesMap.has(inv.id as string)) allInvoicesMap.set(inv.id as string, inv)
  }
  const invoices = Array.from(allInvoicesMap.values())

  const serviceDeliveries = (sdsResult.data ?? []) as ServiceDelivery[]

  // Documents: merge contact-direct + account-linked (same pattern as SDs and invoices)
  type DocRecord = {
    id: string; file_name: string; document_type_name: string | null; category_name: string | null
    category: number | null; drive_file_id: string | null; drive_link: string | null
    status: string | null; processed_at: string | null; mime_type: string | null
    file_size: number | null; account_id: string | null; portal_visible: boolean | null
  }
  const contactDirectDocs = (docsResult.data ?? []) as DocRecord[]
  let accountDocs: DocRecord[] = []
  if (accountIds.length > 0) {
    const { data: accDocsData } = await supabase
      .from('documents')
      .select('id, file_name, document_type_name, category_name, category, drive_file_id, drive_link, status, processed_at, mime_type, file_size, account_id, portal_visible')
      .in('account_id', accountIds)
      .order('category', { ascending: true })
      .order('file_name', { ascending: true })
    accountDocs = (accDocsData ?? []) as DocRecord[]
  }
  const allDocsMap = new Map<string, DocRecord>()
  for (const doc of [...contactDirectDocs, ...accountDocs]) {
    if (!allDocsMap.has(doc.id)) allDocsMap.set(doc.id, doc)
  }
  const contactDocuments = Array.from(allDocsMap.values())

  // Journey data
  const offers = (offersResult.data ?? []) as unknown as Array<{
    id: string; token: string; client_email: string; status: string; contract_type: string | null
    services: unknown; bundled_pipelines: string[] | null; selected_services: unknown
    cost_summary: unknown; view_count: number; required_documents: unknown
    created_at: string; viewed_at: string | null; expires_at: string | null
    packages: OfferPackageOption[] | null; selected_package_key: string | null; package_locked_at: string | null
  }>
  const pendingActivations = (pendingActivationsResult.data ?? []) as Array<{
    id: string; offer_token: string | null; client_email: string; status: string; signed_at: string | null
    payment_confirmed_at: string | null; activated_at: string | null
    payment_method: string | null; amount: number | null; currency: string | null
  }>
  const wizardProgress = (wizardProgressResult.data ?? []) as Array<{
    id: string; contact_id: string; wizard_type: string; current_step: number
    status: string; data: Record<string, unknown> | null; created_at: string; updated_at: string
  }>

  const conversations = (conversationsResult.data ?? []) as ConversationEntry[]

  // SDs for the pipeline stepper (contact-only — ITIN post Phase 1).
  // The query already restricts to account_id IS NULL on this page.
  const stepperDeliveries = serviceDeliveries
    .filter(sd => sd.status !== 'cancelled')
    .map(sd => ({
      id: sd.id,
      service_type: sd.service_type ?? '',
      service_name: sd.service_name ?? sd.service_type ?? 'Service',
      stage: sd.stage ?? null,
      stage_order:
        (sd as unknown as { stage_order: number | null }).stage_order ?? null,
      status: sd.status ?? 'active',
      updated_at: sd.updated_at,
      account_id: sd.account_id ?? null,
      contact_id: sd.contact_id ?? null,
    }))

  const stepperServiceTypes = Array.from(
    new Set(stepperDeliveries.map(d => d.service_type).filter(Boolean)),
  )
  let stagesByServiceType: Record<string, Array<{ stage_name: string; stage_order: number }>> = {}
  if (stepperServiceTypes.length > 0) {
    const { data: stagesRows } = await supabaseAdmin
      .from('pipeline_stages')
      .select('service_type, stage_name, stage_order')
      .in('service_type', stepperServiceTypes)
      .order('stage_order', { ascending: true })
    const grouped: Record<string, Array<{ stage_name: string; stage_order: number }>> = {}
    for (const row of stagesRows ?? []) {
      const key = row.service_type as string
      if (!grouped[key]) grouped[key] = []
      grouped[key].push({ stage_name: row.stage_name as string, stage_order: row.stage_order as number })
    }
    stagesByServiceType = grouped
  }

  // Portal auth status
  let portalAuth: { exists: boolean; lastLogin: string | null; createdAt: string | null; suspended: boolean } = {
    exists: false, lastLogin: null, createdAt: null, suspended: false,
  }
  if (contact.email) {
    try {
      const authUser = await findAuthUserByEmail(contact.email)
      if (authUser) {
        // A login is "suspended" when its auth user is banned with a
        // still-in-the-future banned_until. listUsers returns banned_until
        // reliably (same source team-management uses for its disabled flag).
        const bannedUntil = (authUser as { banned_until?: string | null }).banned_until ?? null
        portalAuth = {
          exists: true,
          lastLogin: authUser.last_sign_in_at ?? null,
          createdAt: authUser.created_at ?? null,
          suspended: !!bannedUntil && new Date(bannedUntil) > new Date(),
        }
      }
    } catch {
      // Auth query failed — non-critical
    }
  }

  // "View as client" (admin + staff): only when this contact actually has a portal login.
  const canViewAs = isDashboardUser(user) && portalAuth.exists

  // Contact-scoped flows (ITIN, etc.) — these SDs have no account, so the
  // account page can't surface them; show their chips here instead.
  const contactFlows = await resolveFlowsByContact(params.id)
  // Contact-scoped in-progress Company Formation → prominent workspace banner.
  const formationFlow = contactFlows.find(
    (f) => f.flow_type === 'Company Formation' && f.status === 'active' && f.service_delivery_id,
  )
  // Contact-scoped active ITIN → prominent workspace banner (same visibility as
  // formation; ITIN is also contact-scoped so the account page can't show it).
  const itinFlow = contactFlows.find(
    (f) => f.flow_type === 'ITIN' && f.status === 'active' && f.service_delivery_id,
  )

  return (
    <div className="p-6 lg:p-8">
      <div className="mb-4 flex justify-end gap-2">
        <Link
          href={`/tools/esign/new?contact=${contact.id}${accounts[0]?.id ? `&account=${accounts[0].id}` : ''}`}
          className="inline-flex items-center gap-1.5 rounded-md border border-blue-200 bg-blue-50 px-3 py-1.5 text-sm font-medium text-blue-700 hover:bg-blue-100"
        >
          ✍️ Create e-sign document
        </Link>
        {canViewAs && <ViewAsClientButton contactId={contact.id} />}
      </div>
      {/* WS-D: all Circleback calls for this person — linked directly to the
          contact (post-conversion) or to their pre-conversion lead(s). A call
          with an existing client never surfaced anywhere before. */}
      <ContactCallsSection contactId={params.id} />
      {formationFlow?.service_delivery_id && (
        <FormationWorkspaceBanner
          serviceDeliveryId={formationFlow.service_delivery_id}
          stage={formationFlow.stage_name}
        />
      )}
      {itinFlow?.service_delivery_id && (
        <ItinWorkspaceBanner
          serviceDeliveryId={itinFlow.service_delivery_id}
          stage={itinFlow.stage_name}
        />
      )}
      <ContactDetail
        contact={contact}
        accounts={accounts}
        serviceDeliveries={serviceDeliveries}
        conversations={conversations}
        documents={contactDocuments}
        invoices={invoices as never[]}
        lead={leadResult.data}
        portalAuth={portalAuth}
        today={today}
        offers={offers}
        pendingActivations={pendingActivations}
        wizardProgress={wizardProgress}
        stepperDeliveries={stepperDeliveries}
        stagesByServiceType={stagesByServiceType}
        flows={contactFlows}
      />
    </div>
  )
}
