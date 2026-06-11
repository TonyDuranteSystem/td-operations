export const dynamic = 'force-dynamic'

import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { getClientContactId } from '@/lib/portal-auth'
import { getPortalAccounts } from '@/lib/portal/queries'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { cookies } from 'next/headers'
import { getLocale } from '@/lib/portal/i18n'
import { TaxFinancialsReview } from '@/components/portal/tax-financials-review'

/**
 * /portal/tax-financials — the review/confirm screen (Slice 8, master plan
 * §3.5-3.7): generated P&L + Balance Sheet, the six verification gates as
 * checkmarks, per-file cards with delete & replace, pattern-grouped
 * questions, Excel download, and the confirm attestation.
 *
 * OWNER-ONLY — the API routes enforce it; teammates get errors if they
 * navigate here directly.
 */
export default async function TaxFinancialsPage() {
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

  // The open filing year — same derivation the wizard submit uses.
  const { data: tr } = await supabaseAdmin
    .from('tax_returns')
    .select('tax_year')
    .eq('account_id', selectedAccountId)
    .eq('data_received', false)
    .order('tax_year', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (!tr?.tax_year) redirect('/portal')

  const locale = getLocale(user)

  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-5xl mx-auto">
      <TaxFinancialsReview accountId={selectedAccountId} taxYear={tr.tax_year} locale={locale} />
    </div>
  )
}
