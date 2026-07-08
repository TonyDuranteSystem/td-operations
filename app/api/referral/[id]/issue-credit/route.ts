/**
 * Issue the credit note for ONE referral — the per-row "Issue credit" action on
 * the Referrals page. A referral that is 'converted' (the referred client paid)
 * must get its credit note; this issues it on demand for the rows that didn't
 * auto-issue (historical, or a referrer the auto-path couldn't resolve).
 *
 *  POST /api/referral/<id>/issue-credit
 *    body: { accountId?, amountUsd?, confirmDuplicate? }
 *
 *  Resolution (returned so the row can prompt inline, never a dead end):
 *   - already credited            → { ok:true, alreadyCredited:true }
 *   - referrer owns >1 company    → { needs:'account', candidates:[{id,name}] }
 *   - no amount on record         → { needs:'amount' }
 *   - a credited sibling exists   → { needs:'confirmDuplicate', duplicateOf }
 *   - resolvable                  → issues the credit, { ok:true, status:'credited', amount, invoiceNumber }
 *
 * Dashboard-only. Idempotent per referral (issueReferralCreditNote).
 */
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isDashboardUser } from '@/lib/auth'
import { NextRequest, NextResponse } from 'next/server'
import { issueReferralCreditNote, REFERRAL_COMMISSION_PCT, sameReferredIdentity } from '@/lib/operations/referral'

export const dynamic = 'force-dynamic'

interface ReferralRow {
  id: string
  status: string
  credited_amount: number | null
  commission_amount: number | null
  referrer_contact_id: string | null
  referrer_account_id: string | null
  referred_contact_id: string | null
  referred_account_id: string | null
  referred_lead_id: string | null
  referred_name: string | null
}

export async function POST(request: NextRequest, { params }: { params: { id: string } }) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isDashboardUser(user)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await request.json().catch(() => ({}))
  const overrideAccountId: string | null = typeof body?.accountId === 'string' ? body.accountId : null
  const overrideAmount: number | null = typeof body?.amountUsd === 'number' && body.amountUsd > 0 ? Math.round(body.amountUsd * 100) / 100 : null
  const confirmDuplicate: boolean = body?.confirmDuplicate === true

  const { data: refData } = await supabaseAdmin
    .from('referrals')
    .select('id, status, credited_amount, commission_amount, referrer_contact_id, referrer_account_id, referred_contact_id, referred_account_id, referred_lead_id, referred_name')
    .eq('id', params.id)
    .maybeSingle()
  const ref = refData as ReferralRow | null
  if (!ref) return NextResponse.json({ error: 'Referral not found.' }, { status: 404 })
  if (Number(ref.credited_amount) > 0 || ref.status === 'credited' || ref.status === 'paid') {
    return NextResponse.json({ ok: true, alreadyCredited: true })
  }
  if (ref.status === 'cancelled') return NextResponse.json({ error: 'This referral is cancelled.' }, { status: 400 })

  // Duplicate guard: a credited/paid sibling for the SAME referrer → same referred
  // person means the reward was already issued elsewhere (issuing again = double-pay).
  const { data: siblings } = await supabaseAdmin
    .from('referrals')
    .select('id, status, referrer_contact_id, referrer_account_id, referred_contact_id, referred_account_id, referred_lead_id, referred_name')
    .neq('id', ref.id)
    .in('status', ['credited', 'paid'])
  const dupe = (siblings ?? []).find((s) => {
    const sr = s as ReferralRow
    const sameReferrer =
      (ref.referrer_contact_id && sr.referrer_contact_id === ref.referrer_contact_id) ||
      (ref.referrer_account_id && sr.referrer_account_id === ref.referrer_account_id)
    return sameReferrer && sameReferredIdentity(ref, sr)
  })
  if (dupe && !confirmDuplicate) {
    return NextResponse.json({ needs: 'confirmDuplicate', duplicateOf: (dupe as ReferralRow).id })
  }

  // Resolve the amount: override → recorded commission. The figure is taken as USD.
  const amount = overrideAmount ?? (Number(ref.commission_amount) > 0 ? Number(ref.commission_amount) : 0)
  if (!(amount > 0)) return NextResponse.json({ needs: 'amount' })

  // Resolve the referrer's company: override → the referral's own account → the
  // referrer contact's linked accounts (exactly one → use it; several → ask).
  let creditAccountId: string | null = overrideAccountId ?? ref.referrer_account_id ?? null
  const creditContactId = ref.referrer_contact_id ?? null
  if (!creditAccountId && creditContactId) {
    const { data: links } = await supabaseAdmin
      .from('account_contacts')
      .select('account_id, accounts:account_id(company_name)')
      .eq('contact_id', creditContactId)
    const accts = (links ?? []) as Array<{ account_id: string; accounts: { company_name: string | null } | null }>
    const distinct = Array.from(new Map(accts.map((l) => [l.account_id, l.accounts?.company_name ?? null])).entries())
    if (distinct.length === 1) creditAccountId = distinct[0][0]
    else if (distinct.length > 1) {
      return NextResponse.json({ needs: 'account', candidates: distinct.map(([id, name]) => ({ id, name })) })
    }
    // distinct.length === 0 → no company; fall through to a contact-scoped credit.
  }
  if (!creditAccountId && !creditContactId) {
    return NextResponse.json({ error: 'This referral has no referrer to credit.' }, { status: 400 })
  }

  try {
    const { paymentId } = await issueReferralCreditNote(
      {
        referralId: ref.id,
        referrerAccountId: creditAccountId,
        referrerContactId: creditContactId,
        amount,
        currency: 'USD',
        description: `Referral reward — ${REFERRAL_COMMISSION_PCT}% credit (${ref.referred_name ?? 'referred client'})`,
      },
      supabaseAdmin,
    )
    // Keep the row coherent with the credit actually issued (account attribution +
    // USD, and a filled amount) — issueReferralCreditNote already flipped it to credited.
    await supabaseAdmin
      .from('referrals')
      .update({
        referrer_account_id: creditAccountId ?? ref.referrer_account_id,
        commission_amount: amount,
        commission_currency: 'USD',
        commission_type: 'credit_note',
        commission_pct: REFERRAL_COMMISSION_PCT,
      })
      .eq('id', ref.id)

    // Close the stale "Process referral commission — … <referred>" task, if any.
    const name = (ref.referred_name ?? '').trim()
    if (name) {
      // eslint-disable-next-line no-restricted-syntax -- status-only close of the stale "Process referral commission" task now that the credit is issued; scoped write, no lib/operations helper for this one-off.
      await supabaseAdmin
        .from('tasks')
        .update({ status: 'Done', completed_date: new Date().toISOString() })
        .eq('status', 'To Do')
        .like('task_title', 'Process referral commission —%')
        .ilike('task_title', `%${name}%`)
    }

    const { data: cn } = await supabaseAdmin.from('payments').select('invoice_number').eq('id', paymentId).maybeSingle()
    return NextResponse.json({ ok: true, status: 'credited', amount, invoiceNumber: (cn as { invoice_number: string | null } | null)?.invoice_number ?? null })
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Could not issue the credit.' }, { status: 500 })
  }
}
