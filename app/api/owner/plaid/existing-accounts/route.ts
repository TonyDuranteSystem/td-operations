import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { isOwnerOnly } from '@/lib/auth'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { TD_ENTITY_ID } from '@/lib/owner-finance'

/**
 * Every hand-entered account name in the books, with its most recent date. Shown as a plain
 * reference next to the Connect Bank button — NOT matched against the bank name being typed.
 *
 * A name-matching attempt was tried and found unsafe within this same job: automatic sync
 * labels an institution one way ("Chase"), hand-entered statements label the specific account
 * another way (e.g. "Firstcitizenbank checking 5820" — no space, unlike how a person would type
 * "First Citizens"), and a fuzzy match between them can silently miss a real match, which is
 * the exact failure this feature exists to prevent. Showing the full list instead means Antonio
 * decides the cutover date himself, informed, rather than trusting a guess that could be wrong
 * without him ever seeing it fail.
 */
export async function GET() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isOwnerOnly(user)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { data, error } = await supabaseAdmin
    .from('td_books_transactions')
    .select('transaction_date, transaction_ref, bank_name')
    .eq('entity_id', TD_ENTITY_ID)
    .not('bank_name', 'is', null)
    .order('transaction_date', { ascending: false })
    .limit(5000)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  const manualRows = (data ?? []).filter(r => !(r.transaction_ref ?? '').startsWith('feed:'))
  const lastDateByAccount = new Map<string, string>()
  for (const row of manualRows) {
    if (!row.bank_name) continue
    // Rows are already ordered newest-first, so the first one seen per account is its latest.
    if (!lastDateByAccount.has(row.bank_name)) lastDateByAccount.set(row.bank_name, row.transaction_date)
  }

  const accounts = Array.from(lastDateByAccount.entries())
    .map(([bank_name, last_date]) => ({ bank_name, last_date }))
    .sort((a, b) => b.last_date.localeCompare(a.last_date))

  return NextResponse.json({ accounts })
}
