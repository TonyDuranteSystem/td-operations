import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { getClientContactId } from '@/lib/portal-auth'
import { getPortalAccounts, getPortalAccountDetail, getPortalMembers } from '@/lib/portal/queries'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { cookies } from 'next/headers'
import { getLocale } from '@/lib/portal/i18n'
import { GenerateDocumentsClient } from './generate-documents-client'

export const dynamic = 'force-dynamic'

export default async function GenerateDocumentsPage() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/portal/login')

  const contactId = getClientContactId(user)
  if (!contactId) redirect('/portal')

  const accounts = await getPortalAccounts(contactId)
  const cookieStore = cookies()
  const cookieAccountId = (await cookieStore).get('portal_account_id')?.value
  const selectedAccountId = accounts.find(a => a.id === cookieAccountId)?.id ?? accounts[0]?.id

  if (!selectedAccountId) redirect('/portal')

  const locale = getLocale(user)

  // Load account details, members, and history in parallel.
  // Also fetch the contact as fallback for accounts without members table rows
  // (older clients formed before April 2026).
  const [accountDetail, members, historyResult, contactResult] = await Promise.all([
    getPortalAccountDetail(selectedAccountId),
    getPortalMembers(selectedAccountId),
    supabaseAdmin
      .from('generated_documents')
      .select('id, document_type, fiscal_year, amount, currency, distribution_date, status, created_at')
      .eq('account_id', selectedAccountId)
      .order('created_at', { ascending: false })
      .limit(20),
    // No role filter here: CRM role values vary in casing/wording ('owner',
    // 'Owner', 'Sole Member', ...) — a case-sensitive eq('role','owner')
    // silently returned nothing for 20+ accounts, which emptied the members
    // list and made the Distribution Resolution / Tax Statement templates
    // skip their entire body (the "two-line document" bug, 2026-07-07).
    supabaseAdmin
      .from('account_contacts')
      .select('contact_id, role, contacts(first_name, last_name)')
      .eq('account_id', selectedAccountId)
      .limit(20),
  ])

  if (!accountDetail) redirect('/portal')

  const rawMembers = members || []
  const contactLinks = (contactResult.data ?? []) as Array<{
    contact_id: string
    role: string | null
    contacts: { first_name: string | null; last_name: string | null } | null
  }>
  // Prefer an owner-ish role (any casing), then any member-ish role, then the
  // first linked contact — never leave the members list silently empty.
  const ownerLink =
    contactLinks.find(l => /owner|sole member/i.test(l.role ?? '')) ??
    contactLinks.find(l => /member/i.test(l.role ?? '')) ??
    contactLinks[0] ??
    null
  const ownerContact = ownerLink?.contacts ?? null

  const mappedMembers = rawMembers.length > 0
    ? rawMembers.map(m => ({
        fullName: `${m.first_name} ${m.last_name}`.trim(),
        role: m.role || 'owner',
        ownershipPct: m.ownership_pct ?? null,
        // Address fields for OA generation
        address: [m.address_line1, m.address_city, m.address_state, m.address_country].filter(Boolean).join(', ') || null,
        isPrimary: m.is_primary ?? false,
        // Extended fields for OA signing flow
        contact_id: m.contact_id ?? null,
        email: m.email ?? null,
        member_id: m.member_id,
      }))
    : ownerContact
      ? [{
          fullName: `${ownerContact.first_name ?? ''} ${ownerContact.last_name ?? ''}`.trim() || 'N/A',
          role: 'owner',
          ownershipPct: null,
          address: null,
          isPrimary: true,
          contact_id: ownerLink?.contact_id ?? contactId,
          email: null,
          member_id: undefined,
        }]
      : []

  return (
    <GenerateDocumentsClient
      account={{
        id: selectedAccountId,
        companyName: accountDetail.company_name,
        ein: accountDetail.ein_number,
        stateOfFormation: accountDetail.state_of_formation,
        formationDate: accountDetail.formation_date,
        physicalAddress: accountDetail.physical_address,
        logoUrl: accountDetail.invoice_logo_url,
        entityType: accountDetail.entity_type,
        registeredAgentAddress: accountDetail.registered_agent_address,
        memberCount: (accountDetail as Record<string, unknown>).member_count as number | null ?? null,
      }}
      members={mappedMembers}
      history={historyResult.data || []}
      locale={locale}
    />
  )
}
