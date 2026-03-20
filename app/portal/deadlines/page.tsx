export const dynamic = 'force-dynamic'

import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { getClientContactId } from '@/lib/portal-auth'
import { getPortalAccounts } from '@/lib/portal/queries'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { cookies } from 'next/headers'
import { t, getLocale } from '@/lib/portal/i18n'
import { DeadlineCalendar } from '@/components/portal/deadline-calendar'

export default async function PortalDeadlinesPage() {
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

  const locale = getLocale(user)

  // Fetch ALL deadlines for this account (not just upcoming)
  const { data: deadlines } = await supabaseAdmin
    .from('deadlines')
    .select('id, deadline_type, due_date, status, notes, state, year, filed_date')
    .eq('account_id', selectedAccountId)
    .order('due_date', { ascending: true })
    .limit(100)

  return (
    <div className="p-6 lg:p-8 max-w-5xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-900">{t('deadlines.title', locale)}</h1>
        <p className="text-zinc-500 text-sm mt-1">{t('deadlines.subtitle', locale)}</p>
      </div>

      <DeadlineCalendar deadlines={deadlines ?? []} />
    </div>
  )
}
