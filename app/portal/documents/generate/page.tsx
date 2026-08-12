import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { getClientContactId } from '@/lib/portal-auth'
import { getPortalAccounts, getPortalAccountDetail, getPortalMembers } from '@/lib/portal/queries'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { cookies } from 'next/headers'
import { getLocale } from '@/lib/portal/i18n'
import { GenerateDocumentsClient } from './generate-documents-client'
import { formatMemberAddress } from '@/lib/members/member-address'
import { resolveOwnerOfRecord } from '@/lib/members/sole-owner-address'
import { decideScreenAddressMode } from '@/lib/members/oa-address-decisions'

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
      .select('contact_id, role, contacts(first_name, last_name, address_line1, address_city, address_state, address_zip, address_country)')
      .eq('account_id', selectedAccountId)
      .limit(20),
  ])

  if (!accountDetail) redirect('/portal')

  // A Single Member LLC has NO member roster by design — that is correct state,
  // not a gap and not a backfill candidate. 216 of the active accounts are exactly
  // this. So "no member rows" routes to the sole-owner branch below, which is the
  // NORMAL path for most clients, not a legacy fallback.
  const rawMembers = members || []
  const contactLinks = (contactResult.data ?? []) as Array<{
    contact_id: string
    role: string | null
    contacts: {
      first_name: string | null; last_name: string | null
      address_line1: string | null; address_city: string | null
      address_state: string | null; address_zip: string | null; address_country: string | null
    } | null
  }>
  // Owner of record — resolved by the SHARED helper, which the create route also
  // calls server-side. When these two disagreed, the screen offered an editable
  // field for one person while the server wrote it to another's record.
  const ownerOfRecordId = resolveOwnerOfRecord(contactLinks)
  const ownerLink = contactLinks.find(l => l.contact_id === ownerOfRecordId) ?? null
  const ownerContact = ownerLink?.contacts ?? null

  const mappedMembers = rawMembers.length > 0
    ? rawMembers.map(m => ({
        fullName: `${m.first_name} ${m.last_name}`.trim(),
        role: m.role || 'owner',
        ownershipPct: m.ownership_pct ?? null,
        // The address of record, rendered read-only on screen and stored verbatim
        // by the create route via the same resolver. Formatted here by the shared
        // helper — including the POSTAL CODE, which this join used to drop, so the
        // client reviewed an address the agreement did not contain.
        address: formatMemberAddress({
          line1: m.address_line1,
          city: m.address_city,
          state: m.address_state,
          zip: m.address_zip,
          country: m.address_country,
        }),
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
          // Pre-members-table account: there is no member row, so the contact record
          // IS the record here. Previously hard-coded to null, which left the client
          // retyping their address on every agreement with nothing kept afterwards.
          address: formatMemberAddress({
            line1: ownerContact.address_line1,
            city: ownerContact.address_city,
            state: ownerContact.address_state,
            zip: ownerContact.address_zip,
            country: ownerContact.address_country,
          }),
          isPrimary: true,
          // The OWNER OF RECORD — never `contactId`, the person who happens to be
          // logged in. The agreement names an owner; who opened the browser is an
          // accident. This id is what the create route writes the address back to,
          // and what decides whether the field is editable at all, so an
          // administrator or co-owner opening this screen must not be able to type
          // an address into another person's contact record (Antonio, 2026-08-12).
          contact_id: ownerLink?.contact_id ?? contactId,
          email: null,
          member_id: undefined,
        }]
      : []

  // Only the owner of record may supply the address on a no-roster account. Anyone
  // else linked to the company sees it read-only — they can still generate the
  // agreement, they just cannot author someone else's address. Computed here and
  // re-derived server-side by the create route; this only decides what is RENDERED.
  // Both flags from ONE tested decision, so the screen has no logic of its own to
  // drift from the server's copy — and so "always read-only" or "always editable"
  // cannot be introduced here without a test going red.
  const screenMode = decideScreenAddressMode({
    memberRowCount: rawMembers.length,
    ownerOfRecordContactId: ownerOfRecordId,
    viewerContactId: contactId,
  })

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
      membersFromRecord={screenMode.membersFromRecord}
      canEditSoleOwnerAddress={screenMode.canEditSoleOwnerAddress}
      history={historyResult.data || []}
      locale={locale}
    />
  )
}
