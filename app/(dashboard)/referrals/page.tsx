import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isDashboardUser } from '@/lib/auth'
import { redirect } from 'next/navigation'
import { ReferralsDashboard } from './referrals-dashboard'

export const dynamic = 'force-dynamic'

export interface ReferralRow {
  id: string
  referrer_contact_id: string | null
  referred_name: string
  referred_contact_id: string | null
  referred_account_id: string | null
  referred_lead_id: string | null
  offer_token: string | null
  status: string
  referrer_type: string | null
  commission_type: string | null
  commission_pct: number | null
  commission_amount: number | null
  commission_currency: string | null
  credited_amount: number | null
  paid_amount: number | null
  notes: string | null
  created_at: string
  referrer_name: string | null
  referred_company: string | null
  referrer_code: string | null
}

export default async function ReferralsPage() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isDashboardUser(user)) redirect('/login')

  // Fetch all referrals with joined names
  const { data: rawReferrals } = await supabaseAdmin
    .from('referrals')
    .select(`
      id, referrer_contact_id, referred_name, referred_contact_id,
      referred_account_id, referred_lead_id, offer_token, status,
      referrer_type, commission_type, commission_pct, commission_amount,
      commission_currency, credited_amount, paid_amount, notes, created_at,
      referrer:contacts!referrals_referrer_contact_id_fkey(full_name, referral_code),
      referred_account:accounts!referrals_referred_account_id_fkey(company_name)
    `)
    .eq('is_test', false)
    .order('created_at', { ascending: false })

  const referrals: ReferralRow[] = (rawReferrals ?? []).map((r) => ({
    id: r.id,
    referrer_contact_id: r.referrer_contact_id,
    referred_name: r.referred_name,
    referred_contact_id: r.referred_contact_id,
    referred_account_id: r.referred_account_id,
    referred_lead_id: r.referred_lead_id,
    offer_token: r.offer_token,
    status: r.status,
    referrer_type: r.referrer_type,
    commission_type: r.commission_type,
    commission_pct: r.commission_pct,
    commission_amount: r.commission_amount,
    commission_currency: r.commission_currency,
    credited_amount: r.credited_amount,
    paid_amount: r.paid_amount,
    notes: r.notes,
    created_at: r.created_at,
    referrer_name: (r.referrer as unknown as { full_name: string } | null)?.full_name ?? null,
    referred_company: (r.referred_account as unknown as { company_name: string } | null)?.company_name ?? null,
    referrer_code: (r.referrer as unknown as { referral_code: string } | null)?.referral_code ?? null,
  }))

  // Compute stats
  const totalReferrals = referrals.length
  const pendingCommission = referrals
    .filter(r => ['pending', 'converted'].includes(r.status))
    .reduce((s, r) => s + (Number(r.commission_amount) || 0), 0)
  const totalPaidOut = referrals
    .reduce((s, r) => s + (Number(r.credited_amount) || 0) + (Number(r.paid_amount) || 0), 0)
  const converted = referrals.filter(r => r.status !== 'pending' && r.status !== 'cancelled').length
  const conversionRate = totalReferrals > 0 ? Math.round((converted / totalReferrals) * 100) : 0

  // Unique referrers (partners)
  const partnerMap = new Map<string, { name: string; code: string | null; count: number; commission: number }>()
  for (const r of referrals) {
    if (!r.referrer_contact_id) continue
    const existing = partnerMap.get(r.referrer_contact_id)
    if (existing) {
      existing.count++
      existing.commission += Number(r.commission_amount) || 0
    } else {
      partnerMap.set(r.referrer_contact_id, {
        name: r.referrer_name || 'Unknown',
        code: r.referrer_code,
        count: 1,
        commission: Number(r.commission_amount) || 0,
      })
    }
  }
  const referrers = Array.from(partnerMap.entries())
    .map(([id, v]) => ({ id, ...v }))
    .sort((a, b) => b.count - a.count)

  return (
    <div className="h-full">
      <ReferralsDashboard
        referrals={referrals}
        stats={{ totalReferrals, pendingCommission, totalPaidOut, conversionRate }}
        referrers={referrers}
      />
    </div>
  )
}
