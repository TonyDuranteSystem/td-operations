export const dynamic = 'force-dynamic'

import { supabaseAdmin } from '@/lib/supabase-admin'
import { createClient } from '@/lib/supabase/server'
import { getClientContactId } from '@/lib/portal-auth'
import { redirect } from 'next/navigation'
import { computeReferralProgress } from '@/lib/portal/partner-referrals'
import { PartnerReferralsClient, type PartnerReferralView } from '@/components/portal/partner-referrals-client'

export default async function PartnerReferralsPage() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/portal/login')
  const contactId = getClientContactId(user)
  if (!contactId) redirect('/portal/login')

  const { data: partner } = await supabaseAdmin
    .from('client_partners')
    .select('id, partner_name')
    .eq('contact_id', contactId)
    .single()
  if (!partner) redirect('/portal')

  // A partner's referrals = their offers (works for an INDIVIDUAL or a COMPANY).
  const { data: offers } = await supabaseAdmin
    .from('offers')
    .select('token, client_name, status, lead_id, contact_id, account_id, created_at')
    .eq('partner_id', partner.id)
    .order('created_at', { ascending: false })

  const offerList = (offers ?? []).filter(o => !!o.token)
  const tokens = offerList.map(o => o.token as string)
  const leadIds = offerList.map(o => o.lead_id).filter(Boolean) as string[]
  const acctIds = offerList.map(o => o.account_id).filter(Boolean) as string[]
  const ctIds = offerList.map(o => o.contact_id).filter(Boolean) as string[]

  // Payouts for these referrals, scoped to this partner (offer is the anchor).
  const { data: payouts } = tokens.length
    ? await supabaseAdmin
        .from('referral_payouts')
        .select('id, offer_token, payout_type, amount, currency, status, requested_at')
        .eq('partner_id', partner.id)
        .in('offer_token', tokens)
    : { data: [] as Array<Record<string, unknown>> }

  // "Call done" ← a CRM call_summaries row for the referral's lead/account/contact.
  const callKeys = new Set<string>()
  const orParts = [
    leadIds.length ? `lead_id.in.(${leadIds.join(',')})` : '',
    acctIds.length ? `account_id.in.(${acctIds.join(',')})` : '',
    ctIds.length ? `contact_id.in.(${ctIds.join(',')})` : '',
  ].filter(Boolean)
  if (orParts.length) {
    const { data: calls } = await supabaseAdmin
      .from('call_summaries')
      .select('lead_id, account_id, contact_id')
      .or(orParts.join(','))
    for (const c of calls ?? []) {
      if (c.lead_id) callKeys.add(`lead:${c.lead_id}`)
      if (c.account_id) callKeys.add(`acct:${c.account_id}`)
      if (c.contact_id) callKeys.add(`contact:${c.contact_id}`)
    }
  }

  const referrals: PartnerReferralView[] = offerList.map(o => {
    const mine = (payouts ?? []).filter((p) => (p as { offer_token?: string }).offer_token === o.token)
    const hasSetup = mine.some((p) => (p as { payout_type?: string }).payout_type !== 'renewal')
    const hasRenewal = mine.some((p) => (p as { payout_type?: string }).payout_type === 'renewal')
    const hasCall =
      (!!o.lead_id && callKeys.has(`lead:${o.lead_id}`)) ||
      (!!o.account_id && callKeys.has(`acct:${o.account_id}`)) ||
      (!!o.contact_id && callKeys.has(`contact:${o.contact_id}`))

    return {
      offerToken: o.token as string,
      clientName: o.client_name || 'Client',
      createdAt: o.created_at as string | null,
      progress: computeReferralProgress({
        offerStatus: o.status,
        hasCallSummary: hasCall,
        hasSetupPayout: hasSetup,
        hasRenewalPayout: hasRenewal,
      }),
      payouts: mine.map((p) => {
        const r = p as { id: string; payout_type: string | null; amount: number | null; currency: string | null; status: string | null; requested_at: string | null }
        return {
          id: r.id,
          type: r.payout_type === 'renewal' ? 'renewal' as const : 'setup' as const,
          amount: Number(r.amount) || 0,
          currency: r.currency || 'USD',
          status: (r.status || 'pending').toLowerCase(),
          requestedAt: r.requested_at,
        }
      }),
    }
  })

  return <PartnerReferralsClient partnerName={partner.partner_name} referrals={referrals} />
}
