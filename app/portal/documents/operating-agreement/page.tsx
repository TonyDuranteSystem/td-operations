import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { getClientContactId } from '@/lib/portal-auth'
import { getPortalAccountDetail, getPortalMembers, getPortalAccounts } from '@/lib/portal/queries'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { cookies } from 'next/headers'
import { getLocale } from '@/lib/portal/i18n'
import { OperatingAgreementClient } from './operating-agreement-client'

export const dynamic = 'force-dynamic'

export default async function OperatingAgreementPage() {
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

  const [accountDetail, rawMembers, historyResult] = await Promise.all([
    getPortalAccountDetail(selectedAccountId),
    getPortalMembers(selectedAccountId),
    supabaseAdmin
      .from('generated_documents')
      .select('id, document_type, status, created_at')
      .eq('account_id', selectedAccountId)
      .eq('document_type', 'operating_agreement')
      .order('created_at', { ascending: false })
      .limit(10),
  ])

  if (!accountDetail) redirect('/portal')

  const members = (rawMembers || []).map(m => ({
    fullName: `${m.first_name ?? ''} ${m.last_name ?? ''}`.trim() || (m as { company_name?: string }).company_name || 'N/A',
    ownershipPct: m.ownership_pct ?? 0,
    isPrimary: m.is_primary ?? false,
    address: [
      m.address_line1,
      m.address_city,
      m.address_state,
      m.address_country,
    ].filter(Boolean).join(', ') || null,
  }))

  return (
    <OperatingAgreementClient
      account={{
        id: selectedAccountId,
        companyName: accountDetail.company_name,
        ein: accountDetail.ein_number,
        stateOfFormation: accountDetail.state_of_formation,
        formationDate: accountDetail.formation_date,
        physicalAddress: accountDetail.physical_address,
        entityType: accountDetail.entity_type,
        registeredAgentAddress: accountDetail.registered_agent_address,
      }}
      members={members}
      history={historyResult.data || []}
      locale={locale}
    />
  )
}
