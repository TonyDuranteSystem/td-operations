/**
 * Portal Team tab — company owners and members only. Lets an owner or member add
 * and manage employee logins. Teammates themselves can NEVER reach this page
 * (they are not contacts; the admin check fails) and the nav link is hidden.
 */
import { createClient } from '@/lib/supabase/server'
import { getClientContactId } from '@/lib/portal-auth'
import { getPortalAccounts } from '@/lib/portal/queries'
import { isAccountAdmin } from '@/lib/portal/team/account-admin'
import { listTeammates } from '@/lib/portal/team/server'
import { getMySharedMemberIds } from '@/lib/portal/team/personal-docs-server'
import { loadTeamPageData } from '@/lib/portal/team/team-page-data'
import { TeamManager, type Teammate } from '@/components/portal/team-manager'
import { cookies } from 'next/headers'
import { PORTAL_BASE_URL } from '@/lib/config'
import { getLocale } from '@/lib/portal/i18n'
import { redirectIfHiddenForServiceScope } from '@/lib/portal/service-scope-server'
import { SERVICE_SCOPED_PAGE_KEYS } from '@/lib/portal/service-scope'

export const dynamic = 'force-dynamic'

export default async function PortalTeamPage() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return <NotAvailable />
  // A service-scoped login (one bought service) never opens this page; the menu hides it too (lib/portal/service-scope.ts).
  await redirectIfHiddenForServiceScope(user, SERVICE_SCOPED_PAGE_KEYS.team)

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

  // Only a current owner or member of this company may manage its team.
  const admin = await isAccountAdmin(contactId, accountId)
  if (!admin) return <NotAvailable />

  const companyName = accounts.find(a => a.id === accountId)?.company_name ?? 'Your company'
  // The logins, and which of them THIS owner has shared their own personal documents with (Team Powers step 7; each owner sees only their
  // own switch). A list that cannot be read is said so — never shown as "no team" or "nothing shared".
  const pageData = await loadTeamPageData<Teammate>(accountId, contactId, {
    listTeammates: async (id) => (await listTeammates(id)) as unknown as Teammate[],
    getMySharedMemberIds,
  })
  if (pageData.kind === 'failed') return <LoadFailed />

  // The handover message defaults to the owner's language (an Italian owner writes to Italian colleagues).
  const defaultLang = getLocale(user) === 'it' ? 'it' : 'en'

  return <TeamManager accountId={accountId} companyName={companyName} teammates={pageData.teammates} sharesUnavailable={pageData.sharesUnavailable} loginUrl={`${PORTAL_BASE_URL}/portal/login`} defaultLang={defaultLang} />
}

function LoadFailed() {
  return (
    <div className="max-w-2xl mx-auto px-4 lg:px-8 py-16 text-center" data-testid="team-load-failed">
      <h1 className="text-lg font-semibold text-zinc-900">Team</h1>
      <p className="text-sm text-zinc-500 mt-2">We could not load your team right now. Nothing was changed. Please refresh the page in a moment.</p>
    </div>
  )
}

function NotAvailable() {
  return (
    <div className="max-w-2xl mx-auto px-4 lg:px-8 py-16 text-center">
      <h1 className="text-lg font-semibold text-zinc-900">Team</h1>
      <p className="text-sm text-zinc-500 mt-2">Team management is only available to the company&rsquo;s owners and members.</p>
    </div>
  )
}
