/**
 * Referrals GIVEN by one actor — powers the "Referrals" card on the account and
 * contact detail pages ("everyone this client brought us", in one place).
 *
 *  GET /api/referral/by-actor?accountId=<uuid>   account + its linked people
 *  GET /api/referral/by-actor?contactId=<uuid>   person + their companies
 *
 * Matching is deliberately broad across scoping (referral rows may be keyed by
 * the contact, the account, or both) and the result is de-duplicated with the
 * same rule as the referrals dashboard. Dashboard-only.
 */
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isDashboardUser } from '@/lib/auth'
import { NextRequest, NextResponse } from 'next/server'
import { dedupeActiveReferrals } from '@/lib/referral-utils'

export const dynamic = 'force-dynamic'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function GET(request: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isDashboardUser(user)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const accountId = request.nextUrl.searchParams.get('accountId')
  const contactId = request.nextUrl.searchParams.get('contactId')
  if (accountId && !UUID_RE.test(accountId)) return NextResponse.json({ error: 'Invalid accountId.' }, { status: 400 })
  if (contactId && !UUID_RE.test(contactId)) return NextResponse.json({ error: 'Invalid contactId.' }, { status: 400 })
  if (!accountId && !contactId) return NextResponse.json({ error: 'accountId or contactId required.' }, { status: 400 })

  // Resolve the actor's full identity: the account + its people, or the person
  // + their companies — a referral row may be keyed by either side.
  const contactIds = new Set<string>()
  const accountIds = new Set<string>()
  if (accountId) accountIds.add(accountId)
  if (contactId) contactIds.add(contactId)
  if (accountId) {
    const { data: links } = await supabaseAdmin.from('account_contacts').select('contact_id').eq('account_id', accountId)
    for (const l of (links ?? []) as Array<{ contact_id: string }>) if (l.contact_id) contactIds.add(l.contact_id)
  } else if (contactId) {
    const { data: links } = await supabaseAdmin.from('account_contacts').select('account_id').eq('contact_id', contactId)
    for (const l of (links ?? []) as Array<{ account_id: string }>) if (l.account_id) accountIds.add(l.account_id)
  }

  const orParts = [
    contactIds.size ? `referrer_contact_id.in.(${Array.from(contactIds).join(',')})` : null,
    accountIds.size ? `referrer_account_id.in.(${Array.from(accountIds).join(',')})` : null,
  ].filter(Boolean)

  const { data: rows } = await supabaseAdmin
    .from('referrals')
    .select(`
      id, referrer_contact_id, referrer_account_id, referred_contact_id, referred_account_id,
      referred_name, status, commission_amount, commission_currency, credited_amount, paid_amount, created_at,
      referred_account:accounts!referrals_referred_account_id_fkey(company_name)
    `)
    .or(orParts.join(','))
    .eq('is_test', false)
    .order('created_at', { ascending: false })

  const referrals = dedupeActiveReferrals(
    ((rows ?? []) as unknown as Array<Record<string, unknown>>).map(r => ({
      id: r.id as string,
      referrer_contact_id: (r.referrer_contact_id as string) ?? null,
      referrer_account_id: (r.referrer_account_id as string) ?? null,
      referred_contact_id: (r.referred_contact_id as string) ?? null,
      referred_account_id: (r.referred_account_id as string) ?? null,
      referred_name: (r.referred_name as string) ?? null,
      status: r.status as string,
      created_at: r.created_at as string,
      commission_amount: (r.commission_amount as number) ?? null,
      commission_currency: (r.commission_currency as string) ?? null,
      credited_amount: (r.credited_amount as number) ?? null,
      paid_amount: (r.paid_amount as number) ?? null,
      referred_company: (r.referred_account as { company_name: string | null } | null)?.company_name ?? null,
    })),
  )

  return NextResponse.json({ referrals })
}
