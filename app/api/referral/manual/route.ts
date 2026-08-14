/**
 * Manual referral entry (CRM referrals page → "Add referral").
 *
 *  GET  /api/referral/manual?q=<term>
 *       Unified actor search for BOTH the referrer and referred pickers. Returns
 *       accounts (any type — Client, Partner, One-Time, …) AND contacts. Each
 *       result carries the setup-fee total of the relevant account so the form can
 *       pre-fill the default reward (10% of setup fee, USD — editable).
 *
 *  POST /api/referral/manual
 *       Body: { referrerContactId?, referrerAccountId?, referrerType?,
 *               referredContactId?, referredAccountId?, referredName,
 *               amountUsd?, note? }
 *       Records the referral and issues the referrer's USD credit note. amountUsd
 *       defaults to 10% of the referred account's setup fee when omitted.
 *
 * Dashboard-only.
 */
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isDashboardUser } from '@/lib/auth'
import { NextRequest, NextResponse } from 'next/server'
import { blockedByUnsettledPlan, createManualReferralCredit, defaultReferralCreditUsd } from '@/lib/operations/referral'

export const dynamic = 'force-dynamic'

async function requireDashboard() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isDashboardUser(user)) return null
  return user
}

/** Sum of non-cancelled setup-fee payments per account id. */
async function setupFeeByAccount(accountIds: string[]): Promise<Map<string, number>> {
  const map = new Map<string, number>()
  if (accountIds.length === 0) return map
  const { data } = await supabaseAdmin
    .from('payments')
    .select('account_id, amount')
    .eq('payment_category', 'setup_fee')
    .neq('status', 'Cancelled')
    .in('account_id', accountIds)
  for (const f of data ?? []) {
    const aid = (f as { account_id: string }).account_id
    map.set(aid, (map.get(aid) ?? 0) + Number((f as { amount: number | null }).amount ?? 0))
  }
  return map
}

export async function GET(request: NextRequest) {
  if (!(await requireDashboard())) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  const q = request.nextUrl.searchParams.get('q')?.trim() ?? ''
  if (q.length < 2) return NextResponse.json({ results: [] })
  const pattern = `%${q}%`

  // Accounts of ANY type (Client, Partner, One-Time, …).
  const { data: accts } = await supabaseAdmin
    .from('accounts')
    .select('id, company_name, account_type')
    .ilike('company_name', pattern)
    .order('company_name')
    .limit(12)

  // Contacts, with their linked account (for credit + setup-fee resolution).
  const { data: contacts } = await supabaseAdmin
    .from('contacts')
    .select('id, full_name, email, account_contacts(account_id, accounts(company_name))')
    .or(`full_name.ilike.${pattern},email.ilike.${pattern}`)
    .order('full_name')
    .limit(12)

  type ContactRow = { id: string; full_name: string | null; email: string | null; account_contacts: Array<{ account_id: string; accounts: { company_name: string | null } | null }> | null }
  const contactsTyped = (contacts ?? []) as unknown as ContactRow[]

  // Gather every account id we need a setup-fee total for.
  const acctIds = new Set<string>((accts ?? []).map(a => a.id))
  for (const c of contactsTyped) for (const l of c.account_contacts ?? []) if (l.account_id) acctIds.add(l.account_id)
  const fees = await setupFeeByAccount(Array.from(acctIds))

  const accountResults = (accts ?? []).map(a => {
    const sf = fees.get(a.id) ?? 0
    return { kind: 'account' as const, id: a.id, name: a.company_name, account_type: a.account_type, setup_fee_total: sf, default_credit_usd: defaultReferralCreditUsd(sf) }
  })
  const contactResults = contactsTyped.map(c => {
    const link = (c.account_contacts ?? [])[0] ?? null
    const accountId = link?.account_id ?? null
    const sf = accountId ? (fees.get(accountId) ?? 0) : 0
    return {
      kind: 'contact' as const,
      id: c.id,
      name: c.full_name || c.email || '(unnamed)',
      email: c.email,
      account_id: accountId,
      account_name: link?.accounts?.company_name ?? null,
      // ALL linked companies — the referrer picker defaults a person to their
      // company (credits are account-scoped) and needs the full list to let
      // staff choose when the person owns several.
      accounts: (c.account_contacts ?? [])
        .filter(l => l.account_id)
        .map(l => ({ id: l.account_id, name: l.accounts?.company_name ?? null })),
      setup_fee_total: sf,
      default_credit_usd: defaultReferralCreditUsd(sf),
    }
  })

  return NextResponse.json({ results: [...accountResults, ...contactResults] })
}

export async function POST(request: NextRequest) {
  if (!(await requireDashboard())) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await request.json().catch(() => null)
  if (!body) return NextResponse.json({ error: 'Invalid request body.' }, { status: 400 })

  const referrerContactId = typeof body.referrerContactId === 'string' ? body.referrerContactId : null
  const referrerAccountId = typeof body.referrerAccountId === 'string' ? body.referrerAccountId : null
  const referredContactId = typeof body.referredContactId === 'string' ? body.referredContactId : null
  const referredAccountId = typeof body.referredAccountId === 'string' ? body.referredAccountId : null
  const referrerType = body.referrerType === 'partner' ? 'partner' : 'client'
  const referredName = typeof body.referredName === 'string' ? body.referredName.trim() : ''
  const note = typeof body.note === 'string' ? body.note : null

  if (!referrerContactId && !referrerAccountId) return NextResponse.json({ error: 'Pick a referrer.' }, { status: 400 })
  if (!referredContactId && !referredAccountId) return NextResponse.json({ error: 'Pick the referred client.' }, { status: 400 })
  if (!referredName) return NextResponse.json({ error: 'Referred name is required.' }, { status: 400 })

  const planBlock = await blockedByUnsettledPlan({ referredContactId, referredAccountId }, supabaseAdmin)
  if (planBlock.blocked) return NextResponse.json({ error: planBlock.message }, { status: 400 })

  // Resolve the credit amount: explicit override, else 10% of the referred
  // account's paid setup fee (resolving the account from a contact if needed).
  let amountUsd: number
  if (typeof body.amountUsd === 'number' && body.amountUsd > 0) {
    amountUsd = Math.round(body.amountUsd * 100) / 100
  } else {
    let acctForFee = referredAccountId
    if (!acctForFee && referredContactId) {
      const { data: link } = await supabaseAdmin.from('account_contacts').select('account_id').eq('contact_id', referredContactId).limit(1).maybeSingle()
      acctForFee = (link as { account_id: string } | null)?.account_id ?? null
    }
    const fees = acctForFee ? await setupFeeByAccount([acctForFee]) : new Map<string, number>()
    amountUsd = defaultReferralCreditUsd(acctForFee ? (fees.get(acctForFee) ?? 0) : 0)
  }
  if (!(amountUsd > 0)) {
    return NextResponse.json({ error: 'No setup fee on file to auto-compute the reward — enter an amount.' }, { status: 400 })
  }

  const result = await createManualReferralCredit(
    { referrerContactId, referrerAccountId, referredContactId, referredAccountId, referrerType, referredName, creditAmountUsd: amountUsd, note },
    supabaseAdmin,
  )

  if (!result.created) {
    const fail = result as unknown as { reason: string; detail?: string }
    const msg: Record<string, string> = {
      invalid_amount: 'Credit amount must be greater than 0.',
      missing_party: `Missing ${fail.detail ?? 'party'}.`,
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
