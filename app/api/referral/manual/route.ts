/**
 * Manual referral entry (CRM referrals page → "Add referral").
 *
 *  GET  /api/referral/manual?q=<term>
 *       Search active Client accounts for the "referred client" picker. Returns
 *       each account's paid setup-fee total so the form can pre-fill the default
 *       reward (10% of setup fee, taken as USD — editable).
 *
 *  POST /api/referral/manual
 *       Body: { referrerContactId, referredAccountId, referredName, amountUsd?, note? }
 *       Records the referral and issues the referrer's USD credit note. If
 *       amountUsd is omitted, it defaults to 10% of the referred account's setup fee.
 *
 * Dashboard-only.
 */
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isDashboardUser } from '@/lib/auth'
import { NextRequest, NextResponse } from 'next/server'
import { createManualReferralCredit, defaultReferralCreditUsd } from '@/lib/operations/referral'

export const dynamic = 'force-dynamic'

async function requireDashboard() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isDashboardUser(user)) return null
  return user
}

export async function GET(request: NextRequest) {
  if (!(await requireDashboard())) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const q = request.nextUrl.searchParams.get('q')?.trim() ?? ''
  if (q.length < 2) return NextResponse.json({ accounts: [] })

  const { data: accts, error } = await supabaseAdmin
    .from('accounts')
    .select('id, company_name')
    .eq('account_type', 'Client')
    .ilike('company_name', `%${q}%`)
    .order('company_name')
    .limit(15)
  if (error) return NextResponse.json({ accounts: [], error: error.message }, { status: 500 })

  const ids = (accts ?? []).map(a => a.id)
  const feeByAcct = new Map<string, number>()
  if (ids.length > 0) {
    const { data: fees } = await supabaseAdmin
      .from('payments')
      .select('account_id, amount')
      .eq('payment_category', 'setup_fee')
      .neq('status', 'Cancelled')
      .in('account_id', ids)
    for (const f of fees ?? []) {
      const aid = (f as { account_id: string }).account_id
      const amt = Number((f as { amount: number | null }).amount ?? 0)
      feeByAcct.set(aid, (feeByAcct.get(aid) ?? 0) + amt)
    }
  }

  const accounts = (accts ?? []).map(a => {
    const setupFee = feeByAcct.get(a.id) ?? 0
    return {
      id: a.id,
      company_name: a.company_name,
      setup_fee_total: setupFee,
      default_credit_usd: defaultReferralCreditUsd(setupFee),
    }
  })
  return NextResponse.json({ accounts })
}

export async function POST(request: NextRequest) {
  if (!(await requireDashboard())) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await request.json().catch(() => null)
  if (!body) return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 })

  const referrerContactId = typeof body.referrerContactId === 'string' ? body.referrerContactId : ''
  const referredAccountId = typeof body.referredAccountId === 'string' ? body.referredAccountId : ''
  const referredName = typeof body.referredName === 'string' ? body.referredName.trim() : ''
  const note = typeof body.note === 'string' ? body.note : null
  if (!referrerContactId || !referredAccountId || !referredName) {
    return NextResponse.json({ error: 'Referrer, referred client, and name are required.' }, { status: 400 })
  }

  // Resolve the credit amount: explicit override, else 10% of the referred
  // account's paid setup fee.
  let amountUsd: number
  if (typeof body.amountUsd === 'number' && body.amountUsd > 0) {
    amountUsd = Math.round(body.amountUsd * 100) / 100
  } else {
    const { data: fees } = await supabaseAdmin
      .from('payments')
      .select('amount')
      .eq('payment_category', 'setup_fee')
      .neq('status', 'Cancelled')
      .eq('account_id', referredAccountId)
    const setupTotal = (fees ?? []).reduce((s, f) => s + Number((f as { amount: number | null }).amount ?? 0), 0)
    amountUsd = defaultReferralCreditUsd(setupTotal)
  }
  if (!(amountUsd > 0)) {
    return NextResponse.json({ error: 'Credit amount must be greater than 0 (no setup fee on file — enter an amount).' }, { status: 400 })
  }

  const result = await createManualReferralCredit(
    { referrerContactId, referredAccountId, referredName, creditAmountUsd: amountUsd, note },
    supabaseAdmin,
  )

  if (!result.created) {
    const fail = result as unknown as { reason: string; detail?: string }
    const msg: Record<string, string> = {
      invalid_amount: 'Credit amount must be greater than 0.',
      no_referrer_account: 'The referrer has no linked account to credit.',
      self_referral: 'A client cannot refer their own account.',
      duplicate: 'A referral from this referrer for this client already exists.',
      error: fail.detail || 'Could not create the referral.',
    }
    return NextResponse.json({ error: msg[fail.reason] ?? 'Could not create the referral.' }, { status: 400 })
  }
  const ok = result as unknown as { referralId: string; amount: number }
  return NextResponse.json({ ok: true, referralId: ok.referralId, amount: ok.amount })
}
