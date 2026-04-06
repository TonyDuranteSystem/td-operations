import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { notFound } from 'next/navigation'
import { ContactDetail } from '@/components/contacts/contact-detail'
import type { LinkedAccount, ServiceDelivery, ConversationEntry } from '@/lib/types'

export default async function ContactDetailPage({ params }: { params: { id: string } }) {
  const supabase = createClient()
  await supabase.auth.getUser()
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
      .select('role, ownership_pct, account:accounts(id, company_name, entity_type, status, state_of_formation, ein_number)')
      .eq('contact_id', params.id),
    // Service deliveries (by contact_id directly OR by linked account_ids — we'll merge below)
    supabase
      .from('service_deliveries')
      .select('id, service_name, service_type, pipeline, stage, status, assigned_to, account_id, contact_id, start_date, updated_at')
      .eq('contact_id', params.id)
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
      .select('id, file_name, document_type_name, category_name, category, drive_file_id, drive_link, status, processed_at, mime_type, file_size, account_id')
      .eq('contact_id', params.id)
      .order('category', { ascending: true })
      .order('file_name', { ascending: true }),
    // Offers — by client_email or lead_id
    supabase
      .from('offers')
      .select('id, client_email, status, contract_type, services, bundled_pipelines, selected_services, created_at, viewed_at, expires_at')
      .eq('client_email', contact.email ?? '__no_match__')
      .order('created_at', { ascending: false }),
    // Pending activations — by client_email
    supabase
      .from('pending_activations')
      .select('id, client_email, status, signed_at, payment_confirmed_at, activated_at, payment_method, amount, currency')
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
  const accounts: LinkedAccount[] = (accountsResult.data ?? []).map(ac => {
    const a = ac.account as unknown as { id: string; company_name: string; entity_type: string | null; status: string | null; state_of_formation: string | null; ein_number: string | null }
    return {
      id: a.id,
      company_name: a.company_name,
      entity_type: a.entity_type,
      status: a.status,
      state_of_formation: a.state_of_formation,
      ein: a.ein_number,
      role: ac.role,
      ownership_pct: ac.ownership_pct,
    }
  })

  // Also fetch SDs from linked accounts + invoices
  const accountIds = accounts.map(a => a.id)
  let accountSds: ServiceDelivery[] = []
  if (accountIds.length > 0) {
    const { data: accSdsData } = await supabase
      .from('service_deliveries')
      .select('id, service_name, service_type, pipeline, stage, status, assigned_to, account_id, contact_id, start_date, updated_at')
      .in('account_id', accountIds)
      .order('updated_at', { ascending: false })

    accountSds = (accSdsData ?? []) as ServiceDelivery[]
  }

  // Fetch invoices: contact-direct + via linked accounts
  const invoiceFields = 'id, description, amount, total, amount_currency, status, invoice_status, invoice_number, payment_method, paid_date, due_date, installment, amount_paid, amount_due, account_id, contact_id, portal_invoice_id, accounts:account_id(company_name)'
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

  // Merge SDs (contact-direct + account-linked), deduplicate by id
  const contactSds = (sdsResult.data ?? []) as ServiceDelivery[]
  const allSdsMap = new Map<string, ServiceDelivery>()
  for (const sd of [...contactSds, ...accountSds]) {
    if (!allSdsMap.has(sd.id)) allSdsMap.set(sd.id, sd)
  }
  const serviceDeliveries = Array.from(allSdsMap.values())

  // Documents: direct contact docs are already fetched. No need to merge account docs — they show on account detail page.
  const contactDocuments = (docsResult.data ?? []) as Array<{
    id: string; file_name: string; document_type_name: string | null; category_name: string | null
    category: number | null; drive_file_id: string | null; drive_link: string | null
    status: string | null; processed_at: string | null; mime_type: string | null
    file_size: number | null; account_id: string | null
  }>

  // Journey data
  const offers = (offersResult.data ?? []) as Array<{
    id: string; client_email: string; status: string; contract_type: string | null
    services: unknown; bundled_pipelines: string[] | null; selected_services: unknown
    created_at: string; viewed_at: string | null; expires_at: string | null
  }>
  const pendingActivations = (pendingActivationsResult.data ?? []) as Array<{
    id: string; client_email: string; status: string; signed_at: string | null
    payment_confirmed_at: string | null; activated_at: string | null
    payment_method: string | null; amount: number | null; currency: string | null
  }>
  const wizardProgress = (wizardProgressResult.data ?? []) as Array<{
    id: string; contact_id: string; wizard_type: string; current_step: number
    status: string; data: Record<string, unknown> | null; created_at: string; updated_at: string
  }>

  // SS-4 applications for linked accounts
  let ss4Applications: Array<{
    id: string; token: string; account_id: string; company_name: string
    status: string; signed_at: string | null; pdf_signed_drive_id: string | null
  }> = []
  if (accountIds.length > 0) {
    const { data: ss4Data } = await supabase
      .from('ss4_applications')
      .select('id, token, account_id, company_name, status, signed_at, pdf_signed_drive_id')
      .in('account_id', accountIds)
      .order('created_at', { ascending: false })
    ss4Applications = (ss4Data ?? []) as typeof ss4Applications
  }

  const conversations = (conversationsResult.data ?? []) as ConversationEntry[]

  // Portal auth status
  let portalAuth: { exists: boolean; lastLogin: string | null; createdAt: string | null } = {
    exists: false, lastLogin: null, createdAt: null,
  }
  if (contact.email) {
    try {
      const { data: list } = await supabaseAdmin.auth.admin.listUsers({ perPage: 1000 })
      const authUser = (list?.users ?? []).find(u => u.email === contact.email)
      if (authUser) {
        portalAuth = {
          exists: true,
          lastLogin: authUser.last_sign_in_at ?? null,
          createdAt: authUser.created_at ?? null,
        }
      }
    } catch {
      // Auth query failed — non-critical
    }
  }

  return (
    <div className="p-6 lg:p-8">
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
        ss4Applications={ss4Applications}
      />
    </div>
  )
}
