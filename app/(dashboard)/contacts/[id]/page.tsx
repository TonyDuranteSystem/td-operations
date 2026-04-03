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
  const [accountsResult, sdsResult, conversationsResult, leadResult, docsResult] = await Promise.all([
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

  // Also fetch SDs from linked accounts
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
        lead={leadResult.data}
        portalAuth={portalAuth}
        today={today}
      />
    </div>
  )
}
