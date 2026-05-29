/**
 * Portal Team tab — account-admin only. Lets the company's main person invite
 * and manage employee logins. Teammates themselves can NEVER reach this page
 * (they are not contacts; the admin check fails) and the nav link is hidden.
 */
import { createClient } from '@/lib/supabase/server'
import { getClientContactId } from '@/lib/portal-auth'
import { getPortalAccounts } from '@/lib/portal/queries'
import { isAccountAdmin } from '@/lib/portal/team/account-admin'
import { listTeammates } from '@/lib/portal/team/server'
import { TeamManager, type Teammate } from '@/components/portal/team-manager'
import { cookies } from 'next/headers'

export const dynamic = 'force-dynamic'

export default async function PortalTeamPage() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return <NotAvailable />

  const contactId = getClientContactId(user)
  if (!contactId) return <NotAvailable />

  // Resolve the selected company (same cookie the layout uses), else first account.
  const accounts = await getPortalAccounts(contactId)
  const cookieStore = await cookies()
  const cookieAccountId = cookieStore.get('portal_account_id')?.value
  const accountId = (cookieAccountId && accounts.some(a => a.id === cookieAccountId))
    ? cookieAccountId
    : accounts[0]?.id

  if (!accountId) return <NotAvailable />

  // Only the account admin (main person) may manage the team.
  const admin = await isAccountAdmin(contactId, accountId)
  if (!admin) return <NotAvailable />

  const companyName = accounts.find(a => a.id === accountId)?.company_name ?? 'Your company'
  const teammates = (await listTeammates(accountId)) as Teammate[]

  return <TeamManager accountId={accountId} companyName={companyName} teammates={teammates} />
}

function NotAvailable() {
  return (
    <div className="max-w-2xl mx-auto px-4 lg:px-8 py-16 text-center">
      <h1 className="text-lg font-semibold text-zinc-900">Team</h1>
      <p className="text-sm text-zinc-500 mt-2">Team management is only available to the company&rsquo;s main contact.</p>
    </div>
  )
}
