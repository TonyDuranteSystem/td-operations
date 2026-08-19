import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { getClientContactId } from '@/lib/portal-auth'
import { getPortalAccounts, getPortalAccountDetail, getPortalMembers } from '@/lib/portal/queries'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { cookies } from 'next/headers'
import { getLocale } from '@/lib/portal/i18n'
import { GenerateDocumentsClient } from './generate-documents-client'
import { formatMemberAddress } from '@/lib/members/member-address'
import { pickDefaultSs4SignerLink } from '@/lib/operations/ss4-signer'

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
  // Same algorithm the server uses for the SMLLC/no-members default pick
  // (lib/operations/ss4-signer.ts::pickDefaultSs4SignerLink) — whole-string
  // role match plus a stable lowest-contact_id tiebreak, NOT a substring
  // regex. The old `/owner|sole member/i` substring test could wrongly match
  // an unrelated role containing that text (e.g. "Non-Owner Signatory"), and
  // being unordered-query-dependent meant this preview could pick a
  // different default than what actually got stored. Dev job 9ad76300-6181-4250-a1de-c77f37933f82,
  // second pass.
  const pickedLink = pickDefaultSs4SignerLink(contactLinks)
  // pickDefaultSs4SignerLink's return type (Ss4SignerLink) only carries
  // contact_id/role — it always returns one of contactLinks' own elements,
  // so this re-find recovers the `contacts` join data on the exact link it
  // picked, not a fresh lookup that could disagree.
  const ownerLink = pickedLink ? contactLinks.find(l => l.contact_id === pickedLink.contact_id) ?? null : null
  const ownerContact = ownerLink?.contacts ?? null

  const mappedMembers = rawMembers.length > 0
    ? rawMembers.map(m => ({
        fullName: `${m.first_name} ${m.last_name}`.trim(),
        role: m.role || 'owner',
        ownershipPct: m.ownership_pct ?? null,
        // Address fields for OA generation
        // Postal code included — this join dropped it, so the client reviewed an
        // address the stored agreement did not contain.
        address: formatMemberAddress({
          line1: m.address_line1, city: m.address_city, state: m.address_state,
          zip: m.address_zip, country: m.address_country,
        }),
        isPrimary: m.is_primary ?? false,
        // The flag the server actually resolves the document's Manager from
        // — see lib/portal/queries.ts::getPortalMembers. Dev job 9ad76300-6181-4250-a1de-c77f37933f82.
        // No cast: getPortalMembers already returns is_signer on every row,
        // so dropping the column there is a compile error here, not a
        // silent `undefined -> false` fallthrough to isPrimary.
        isSigner: m.is_signer ?? false,
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
          // A Single Member LLC has ONE OWNER and no member roster — that is by
          // design. Their address lives on the contact record, and it is shown
          // READ-ONLY here like every other address on this screen. This was
          // hard-coded null, which is why the client was asked to type it.
          address: formatMemberAddress({
            line1: ownerContact.address_line1, city: ownerContact.address_city,
            state: ownerContact.address_state, zip: ownerContact.address_zip,
            country: ownerContact.address_country,
          }),
          isPrimary: true,
          isSigner: true,
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
