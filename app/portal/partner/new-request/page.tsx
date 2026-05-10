export const dynamic = 'force-dynamic'

import { supabaseAdmin } from '@/lib/supabase-admin'
import { createClient } from '@/lib/supabase/server'
import { getClientContactId } from '@/lib/portal-auth'
import { redirect } from 'next/navigation'
import { PartnerNewRequestClient } from './new-request-client'

export default async function PartnerNewRequestPage({
  searchParams,
}: {
  searchParams: Promise<{ accountId?: string; accountName?: string }>
}) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/portal/login')

  const contactId = getClientContactId(user)
  if (!contactId) redirect('/portal/login')

  const { data: partner } = await supabaseAdmin
    .from('client_partners')
    .select('id, partner_name, default_invoice_target, default_payout_model, default_payout_rate, label')
    .eq('contact_id', contactId)
    .single()

  if (!partner) redirect('/portal')

  const { data: accounts } = await supabaseAdmin
    .from('accounts')
    .select('id, company_name, status')
    .eq('partner_id', partner.id)
    .order('company_name')

  const params = await searchParams
  const preselectedAccountId = params.accountId ?? null
  const preselectedAccountName = params.accountName ? decodeURIComponent(params.accountName) : null

  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-2xl mx-auto">
      <PartnerNewRequestClient
        contactId={contactId}
        partnerId={partner.id}
        partnerName={partner.partner_name ?? 'Partner'}
        partnerDefaults={{
          invoice_target: (partner.default_invoice_target as 'partner' | 'end_client') ?? 'partner',
          payout_model: (partner.default_payout_model as 'none' | 'price_difference' | 'percentage' | 'flat_fee' | 'credit_note') ?? 'none',
          payout_rate: partner.default_payout_rate != null ? Number(partner.default_payout_rate) : null,
          label: (partner.label as 'reseller' | 'variant' | null) ?? null,
        }}
        accounts={(accounts ?? []).map(a => ({ id: a.id, company_name: a.company_name ?? '' }))}
        preselectedAccountId={preselectedAccountId}
        preselectedAccountName={preselectedAccountName}
      />
    </div>
  )
}
