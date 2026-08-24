export const dynamic = 'force-dynamic'

import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { getClientContactId } from '@/lib/portal-auth'
import { getPortalAccounts } from '@/lib/portal/queries'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { cookies } from 'next/headers'
import { getLocale } from '@/lib/portal/i18n'
import { TaxFinancialsReview } from '@/components/portal/tax-financials-review'
import { pickOpenYear, mergeReachableYears } from '@/lib/portal/open-year'

/**
 * /portal/tax-financials — the review/confirm screen (Slice 8, master plan
 * §3.5-3.7): generated P&L + Balance Sheet, the six verification gates as
 * checkmarks, per-file cards with delete & replace, pattern-grouped
 * questions, Excel download, and the confirm attestation.
 *
 * OWNER-ONLY — the API routes enforce it; teammates get errors if they
 * navigate here directly.
 */
export default async function TaxFinancialsPage({ searchParams }: { searchParams?: Promise<{ year?: string }> }) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/portal/login')

  const contactId = getClientContactId(user)
  if (!contactId) redirect('/portal')

  const accounts = await getPortalAccounts(contactId)
  const cookieStore = cookies()
  const cookieAccountId = (await cookieStore).get('portal_account_id')?.value
  const selectedAccountId = accounts.find(a => a.id === cookieAccountId)?.id ?? accounts[0]?.id
  if (!selectedAccountId) redirect('/portal')

  // ALL open filing years (data_received=false) — an amendment/correction can
  // leave an older year open next to the current cycle (2026-07-07, Dynamiq
  // 2024 rebuild: the page used to show only the newest and a correction year
  // was unreachable). One open year renders exactly as before; several render
  // a year switcher.
  const { data: trs } = await supabaseAdmin
    .from('tax_returns')
    .select('tax_year')
    .eq('account_id', selectedAccountId)
    .eq('data_received', false)
    .order('tax_year', { ascending: false })
  const openYears = Array.from(new Set(((trs ?? []) as Array<{ tax_year: number }>).map(t => t.tax_year)))

  // A year whose intake already closed (data_received=true) can still have a
  // generated P&L sitting on real uncategorized transactions — the client
  // must be able to reach that review too, not just years still awaiting
  // their first submission (2026-08-24, Adact Studio International). Narrower
  // "suspected owner" flags (lib/tax/question-groups.ts) aren't checked here —
  // no known account is stuck on that case alone; revisit if one appears.
  const { data: pendingRows } = await supabaseAdmin
    .from('bank_transactions')
    .select('tax_year')
    .eq('account_id', selectedAccountId)
    .eq('category', 'uncategorized')
  const pendingReviewYears = Array.from(new Set(((pendingRows ?? []) as Array<{ tax_year: number }>).map(r => r.tax_year)))
  const reachableYears = mergeReachableYears(openYears, pendingReviewYears)

  const params = searchParams ? await searchParams : undefined
  const taxYear = pickOpenYear(reachableYears, params?.year)
  if (!taxYear) redirect('/portal')

  const locale = getLocale(user)
  const it = locale === 'it'

  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-5xl mx-auto">
      {reachableYears.length > 1 && (
        <nav className="mb-4 flex items-center gap-2" aria-label={it ? 'Anno fiscale' : 'Tax year'}>
          <span className="text-xs text-zinc-500">{it ? 'Anno fiscale:' : 'Tax year:'}</span>
          {reachableYears.map(y => (
            <a
              key={y}
              href={`/portal/tax-financials?year=${y}`}
              aria-current={y === taxYear ? 'page' : undefined}
              className={`rounded-full px-3 py-1 text-sm font-medium ${y === taxYear
                ? 'bg-zinc-900 text-white'
                : 'border border-zinc-300 bg-white text-zinc-600 hover:border-zinc-500'}`}
            >
              {y}
            </a>
          ))}
        </nav>
      )}
      <TaxFinancialsReview accountId={selectedAccountId} taxYear={taxYear} locale={locale} />
    </div>
  )
}
