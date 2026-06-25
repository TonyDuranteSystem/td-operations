export const dynamic = 'force-dynamic'

import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { redirect } from 'next/navigation'
import { getClientContactId } from '@/lib/portal-auth'
import { t, getLocale } from '@/lib/portal/i18n'
import { ReferralPage } from '@/components/portal/referral-page'
import { computePrimaryAccountIds, sumEarnedByCurrency, formatEarnedSummary } from '@/lib/portal/referral-aggregate'

export default async function PortalReferralsPage() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/portal/login')

  const contactId = getClientContactId(user)
  if (!contactId) redirect('/portal')

  const locale = getLocale(user)

  // The referral link is fetched client-side from /api/portal/referral-code,
  // which generates the code on demand in a reliable request context (a write
  // during this server render would not persist on Vercel).

  // A contact sees referrals they made personally (referrer_contact_id) PLUS
  // referrals made by a company where they are the PRIMARY contact. Primary is
  // resolved leak-safely (explicit is_primary flag → else sole member → else
  // none) so co-members of a multi-member LLC never see each other's earnings.
  const { data: myMemberships } = await supabaseAdmin
    .from('account_contacts')
    .select('account_id')
    .eq('contact_id', contactId)

  const myAccountIds = Array.from(new Set((myMemberships ?? []).map(m => m.account_id).filter(Boolean) as string[]))

  let primaryAccountIds: string[] = []
  if (myAccountIds.length > 0) {
    const { data: allMembers } = await supabaseAdmin
      .from('account_contacts')
      .select('account_id, contact_id, is_primary')
      .in('account_id', myAccountIds)
    primaryAccountIds = computePrimaryAccountIds(contactId, myAccountIds, allMembers ?? [])
  }

  // Get this contact's referrals (personal + primary-account) + payouts
  let referralQuery = supabaseAdmin
    .from('referrals')
    .select(`
      id, referred_name, status, commission_amount, commission_currency,
      credited_amount, paid_amount, created_at,
      referred_account:accounts!referrals_referred_account_id_fkey(company_name)
    `)
    .eq('is_test', false)
    .order('created_at', { ascending: false })

  referralQuery = primaryAccountIds.length > 0
    ? referralQuery.or(`referrer_contact_id.eq.${contactId},referrer_account_id.in.(${primaryAccountIds.join(',')})`)
    : referralQuery.eq('referrer_contact_id', contactId)

  const { data: referrals } = await referralQuery

  const referralIds = (referrals ?? []).map(r => r.id)

  const { data: payouts } = referralIds.length > 0
    ? await supabaseAdmin
        .from('referral_payouts')
        .select('id, referral_id, payout_type, amount, currency, reference, created_at')
        .in('referral_id', referralIds)
        .eq('is_test', false)
        .order('created_at', { ascending: false })
    : { data: [] }

  const referralRows = (referrals ?? []).map(r => ({
    id: r.id,
    referred_name: r.referred_name,
    company_name: (r.referred_account as unknown as { company_name: string } | null)?.company_name ?? null,
    status: r.status,
    commission_amount: r.commission_amount,
    commission_currency: r.commission_currency || 'EUR',
    credited_amount: r.credited_amount,
    paid_amount: r.paid_amount,
    created_at: r.created_at,
  }))

  const payoutRows = (payouts ?? []).map(p => ({
    id: p.id,
    referral_id: p.referral_id,
    payout_type: p.payout_type,
    amount: p.amount,
    currency: p.currency || 'EUR',
    reference: p.reference,
    created_at: p.created_at,
  }))

  // Stats
  const totalReferrals = referralRows.length
  const convertedCount = referralRows.filter(r => r.status !== 'pending' && r.status !== 'cancelled').length
  // Earned must stay per-currency: USD ($) and EUR (€) rewards coexist and must
  // never be summed into one number under a single symbol.
  const earnedSummary = formatEarnedSummary(sumEarnedByCurrency(referralRows))

  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-5xl mx-auto space-y-4 sm:space-y-6">
      <div>
        <h1 className="text-xl sm:text-2xl font-semibold tracking-tight text-zinc-900">
          {t('referrals.title', locale)}
        </h1>
        <p className="text-zinc-500 text-xs sm:text-sm mt-1">
          {t('referrals.subtitle', locale)}
        </p>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="bg-white rounded-xl border shadow-sm p-4">
          <p className="text-xs text-zinc-500 uppercase tracking-wide">{t('referrals.totalReferrals', locale)}</p>
          <p className="text-lg sm:text-xl font-semibold text-zinc-900 mt-1">{totalReferrals}</p>
        </div>
        <div className="bg-white rounded-xl border shadow-sm p-4">
          <p className="text-xs text-zinc-500 uppercase tracking-wide">{t('referrals.converted', locale)}</p>
          <p className="text-lg sm:text-xl font-semibold text-blue-600 mt-1">{convertedCount}</p>
        </div>
        <div className="bg-white rounded-xl border shadow-sm p-4">
          <p className="text-xs text-zinc-500 uppercase tracking-wide">{t('referrals.earned', locale)}</p>
          <p className="text-lg sm:text-xl font-semibold text-emerald-600 mt-1">
            {earnedSummary}
          </p>
        </div>
      </div>

      <ReferralPage
        referrals={referralRows}
        payouts={payoutRows}
        locale={locale}
      />
    </div>
  )
}
