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
    //
    // DELIBERATELY UNLIMITED and ordered: the create route runs the SAME query to
    // resolve the SAME owner, and the two must not see different link sets. A
    // `.limit(20)` here (and none there) meant an account with more links could
    // resolve one owner on screen and a different one in the stored document.
    supabaseAdmin
      .from('account_contacts')
      .select('contact_id, role, contacts(first_name, last_name, address_line1, address_city, address_state, address_zip, address_country)')
      .eq('account_id', selectedAccountId)
      .order('contact_id', { ascending: true }),
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
  const ownerResolution = resolveOwnerOfRecord(contactLinks)
  const ownerLink = ownerResolution.resolved
    ? (contactLinks.find(l => l.contact_id === ownerResolution.contactId) ?? null)
    : null
  const ownerContact = ownerLink?.contacts ?? null

  // A rosterless company whose owner CANNOT be established must not render a
  // placeholder member. It previously showed "N/A" on the preview while the route
  // stored the logged-in person's name — the previewed and the signed document
  // disagreeing about who owns the company, which is the exact defect this job
  // exists to remove. Both surfaces now refuse from the SAME resolution.
  const ownerUnresolved = rawMembers.length === 0 && !ownerResolution.resolved

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
          // No member roster — correct state for a Single Member LLC — so the
          // owner's contact record IS the address of record. Read-only, like every
          // other address on this screen.
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
          // accident, and an administrator or co-owner viewing this screen must not
          // shift whose name the document carries. Resolved by the SAME helper the
          // create route calls, so the previewed and the stored document can never
          // name different people (Antonio, 2026-08-12).
          contact_id: ownerLink.contact_id,
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
      ownerUnresolved={ownerUnresolved}
      // TRUE only where the self-service pointer is actually TRUE: a rosterless
      // company whose owner is the person reading the screen, who can therefore
      // edit these fields on their own profile. Everyone else is pointed at support,
      // because for them it genuinely is a support job.
      canSelfEditOnProfile={rawMembers.length === 0 && ownerResolution.resolved && ownerResolution.contactId === contactId}
      history={historyResult.data || []}
      locale={locale}
    />
  )
}
