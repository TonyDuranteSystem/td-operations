export const dynamic = 'force-dynamic'

import { supabaseAdmin } from '@/lib/supabase-admin'
import { createClient } from '@/lib/supabase/server'
import { getClientContactId } from '@/lib/portal-auth'
import { redirect } from 'next/navigation'
import { computeReferralProgress } from '@/lib/portal/partner-referrals'
import { parsePartnerDeal } from '@/lib/partners/partner-deal'
import { PartnerReferralsClient, type PartnerReferralView } from '@/components/portal/partner-referrals-client'

const INSTALLMENT_META: Record<string, { n: number; label: string }> = {
  installment_1: { n: 1, label: 'Installment 1 (Jan)' },
  installment_2: { n: 2, label: 'Installment 2 (Jun)' },
}

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
        .select('id, offer_token, payout_type, amount, currency, status, requested_at, reference')
        .eq('partner_id', partner.id)
        .in('offer_token', tokens)
    : { data: [] as Array<Record<string, unknown>> }

  // Renewal billing is per-account: the partner deal (split share) + the actual
  // installment invoices (issued → paid). Only company referrals have these.
  const { data: dealAccounts } = acctIds.length
    ? await supabaseAdmin.from('accounts').select('id, partner_deal, formation_date').in('id', acctIds)
    : { data: [] as Array<{ id: string; partner_deal: unknown; formation_date: string | null }> }
  const dealByAccount = new Map((dealAccounts ?? []).map(a => [a.id, a]))

  const { data: installments } = acctIds.length
    ? await supabaseAdmin
        .from('payments')
        .select('account_id, payment_category, status, paid_date, idempotency_key, due_date')
        .in('account_id', acctIds)
        .in('payment_category', ['installment_1', 'installment_2'])
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
    const hasCall =
      (!!o.lead_id && callKeys.has(`lead:${o.lead_id}`)) ||
      (!!o.account_id && callKeys.has(`acct:${o.account_id}`)) ||
      (!!o.contact_id && callKeys.has(`contact:${o.contact_id}`))

    const acctId = o.account_id as string | null
    const account = acctId ? dealByAccount.get(acctId) : undefined
    const deal = account ? parsePartnerDeal(account.partner_deal) : null
    const formationYear = account?.formation_date ? new Date(account.formation_date).getFullYear() : null

    // Setup payouts only — the one-time acquisition reward. Renewals are below.
    const setupPayouts = mine
      .filter((p) => (p as { payout_type?: string }).payout_type !== 'renewal')
      .map((p) => {
        const r = p as { id: string; amount: number | null; currency: string | null; status: string | null; requested_at: string | null }
        return {
          id: r.id,
          type: 'setup' as const,
          amount: Number(r.amount) || 0,
          currency: r.currency || 'USD',
          status: (r.status || 'pending').toLowerCase(),
          requestedAt: r.requested_at,
        }
      })

    // Renewal payouts keyed by `${year}:${n}` (reference `renewal:<acct>:<year>:<n>`).
    const renewalPayoutByKey = new Map<string, { id: string; amount: number; currency: string; status: string }>()
    for (const p of mine) {
      const r = p as { id: string; payout_type: string | null; amount: number | null; currency: string | null; status: string | null; reference: string | null }
      if (r.payout_type !== 'renewal' || !r.reference) continue
      const m = r.reference.match(/:(\d{4}):(\d+)$/)
      if (!m) continue
      renewalPayoutByKey.set(`${m[1]}:${m[2]}`, { id: r.id, amount: Number(r.amount) || 0, currency: r.currency || 'USD', status: (r.status || 'pending').toLowerCase() })
    }

    // Renewals = the installment invoices for renewal YEARS (after formation),
    // each showing issued→paid + the partner's OWN share (never the client amount).
    // Only built when the deal carries a renewal share.
    const renewalYears = new Map<number, PartnerReferralView['renewals'][number]['installments']>()
    const hasRenewalShare = !!deal && !!deal.renewal_payout && deal.renewal_payout > 0
    if (acctId && hasRenewalShare) {
      for (const inv of (installments ?? [])) {
        const iv = inv as { account_id: string; payment_category: string; status: string | null; paid_date: string | null; idempotency_key: string | null; due_date: string | null }
        if (iv.account_id !== acctId) continue
        const meta = INSTALLMENT_META[iv.payment_category]
        if (!meta) continue
        const ymatch = iv.idempotency_key?.match(/:(\d{4})$/)
        const year = ymatch ? Number(ymatch[1]) : (iv.due_date ? new Date(iv.due_date).getFullYear() : null)
        if (year == null) continue
        if (formationYear != null && year <= formationYear) continue // formation year = setup, not renewal
        const key = `${year}:${meta.n}`
        const payout = renewalPayoutByKey.get(key)
        if (!renewalYears.has(year)) renewalYears.set(year, [])
        renewalYears.get(year)!.push({
          n: meta.n,
          label: meta.label,
          invoicePaid: (iv.status || '').toLowerCase() === 'paid',
          paidDate: iv.paid_date,
          amount: payout?.amount ?? (deal!.renewal_payout ?? 0),
          currency: payout?.currency ?? (deal!.currency || 'USD'),
          payoutId: payout?.id ?? null,
          payoutStatus: payout?.status ?? null,
        })
      }
    }
    const renewals = Array.from(renewalYears.entries())
      .map(([year, insts]) => ({ year, installments: insts.sort((a, b) => a.n - b.n) }))
      .sort((a, b) => b.year - a.year)

    return {
      offerToken: o.token as string,
      clientName: o.client_name || 'Client',
      createdAt: o.created_at as string | null,
      progress: computeReferralProgress({
        offerStatus: o.status,
        hasCallSummary: hasCall,
        hasSetupPayout: hasSetup,
      }),
      payouts: setupPayouts,
      renewals,
    }
  })

  return <PartnerReferralsClient partnerName={partner.partner_name} referrals={referrals} />
}
