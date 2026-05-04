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
    supabaseAdmin
      .from('account_contacts')
      .select('contacts(first_name, last_name)')
      .eq('account_id', selectedAccountId)
      .eq('role', 'owner')
      .limit(1)
      .single(),
  ])

  if (!accountDetail) redirect('/portal')

  const rawMembers = members || []
  const mappedMembers = rawMembers.length > 0
    ? rawMembers.map(m => ({
        fullName: `${m.first_name} ${m.last_name}`.trim(),
        role: m.role || 'owner',
        ownershipPct: m.ownership_pct ?? null,
      }))
    : (() => {
        // Fallback for older clients without members table rows.
        // Use the account's owner contact (by role), not the logged-in user —
        // authorized representatives may log in on behalf of the actual owner.
        const ownerContact = contactResult.data?.contacts as { first_name: string | null; last_name: string | null } | null
        if (!ownerContact) return []
        return [{
          fullName: `${ownerContact.first_name ?? ''} ${ownerContact.last_name ?? ''}`.trim() || 'N/A',
          role: 'owner',
          ownershipPct: null,
        }]
      })()

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
      }}
      members={mappedMembers}
      history={historyResult.data || []}
      locale={locale}
    />
  )
}
