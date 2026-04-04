export const dynamic = 'force-dynamic'

import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { redirect } from 'next/navigation'
import { getClientContactId } from '@/lib/portal-auth'
import { t, getLocale } from '@/lib/portal/i18n'
import { ReferralPage } from '@/components/portal/referral-page'

export default async function PortalReferralsPage() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/portal/login')

  const contactId = getClientContactId(user)
  if (!contactId) redirect('/portal')

  const locale = getLocale(user)

  // Get contact's referral code
  const { data: contact } = await supabaseAdmin
    .from('contacts')
    .select('referral_code, full_name')
    .eq('id', contactId)
    .single()

  const referralCode = contact?.referral_code || null
  const referralLink = referralCode ? `https://tonydurante.us/r/${referralCode}` : null

  // Get this contact's referrals
  const { data: referrals } = await supabaseAdmin
    .from('referrals')
    .select(`
      id, referred_name, status, commission_amount, commission_currency,
      credited_amount, paid_amount, created_at,
      referred_account:accounts!referrals_referred_account_id_fkey(company_name)
    `)
    .eq('referrer_contact_id', contactId)
    .eq('is_test', false)
    .order('created_at', { ascending: false })

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

  // Stats
  const totalReferrals = referralRows.length
  const convertedCount = referralRows.filter(r => r.status !== 'pending' && r.status !== 'cancelled').length
  const totalEarned = referralRows.reduce((s, r) =>
    s + (Number(r.credited_amount) || 0) + (Number(r.paid_amount) || 0), 0)

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
            €{totalEarned.toLocaleString('en-US', { minimumFractionDigits: 0 })}
          </p>
        </div>
      </div>

      <ReferralPage
        referralLink={referralLink}
        referrals={referralRows}
        locale={locale}
      />
    </div>
  )
}
