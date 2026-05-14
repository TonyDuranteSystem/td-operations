import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { getClientContactId } from '@/lib/portal-auth'
import { getPortalAccounts } from '@/lib/portal/queries'
import { t, getLocale } from '@/lib/portal/i18n'
import { cookies } from 'next/headers'
import { PortalChat } from '@/components/portal/portal-chat'
import { LogTab } from '@/components/portal/chat/log-tab'
import { cn } from '@/lib/utils'

export default async function PortalChatPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string }>
}) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/portal/login')

  const contactId = getClientContactId(user)
  if (!contactId) redirect('/portal')

  const accounts = await getPortalAccounts(contactId)
  const cookieStore = cookies()
  const cookieAccountId = (await cookieStore).get('portal_account_id')?.value
  const selectedAccountId = accounts.find(a => a.id === cookieAccountId)?.id ?? accounts[0]?.id
  const locale = getLocale(user)
  const { view } = await searchParams
  const activeView = view === 'log' ? 'log' : 'chat'

  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-4xl mx-auto h-[calc(100dvh-3.5rem)] lg:h-[calc(100dvh-6rem)] flex flex-col overflow-hidden">
      <div className="mb-3 sm:mb-4">
        <h1 className="text-xl sm:text-2xl font-semibold tracking-tight text-zinc-900">{t('chat.title', locale)}</h1>
        <p className="text-zinc-500 text-xs sm:text-sm mt-1">{t('chat.team', locale)}</p>
      </div>

      {/* Tab switcher */}
      <div className="flex gap-1 mb-3 border-b border-zinc-200">
        <Link
          href="/portal/chat"
          className={cn(
            'px-3 py-1.5 text-sm font-medium transition-colors border-b-2 -mb-px',
            activeView === 'chat'
              ? 'border-zinc-900 text-zinc-900'
              : 'border-transparent text-zinc-500 hover:text-zinc-700',
          )}
        >
          Messages
        </Link>
        <Link
          href="/portal/chat?view=log"
          className={cn(
            'px-3 py-1.5 text-sm font-medium transition-colors border-b-2 -mb-px',
            activeView === 'log'
              ? 'border-zinc-900 text-zinc-900'
              : 'border-transparent text-zinc-500 hover:text-zinc-700',
          )}
        >
          Journey Log
        </Link>
      </div>

      {activeView === 'chat' ? (
        <PortalChat
          accountId={selectedAccountId}
          contactId={contactId}
          userId={user.id}
          locale={locale}
          accounts={accounts.map(a => ({ id: a.id, company_name: a.company_name }))}
        />
      ) : (
        <div className="flex-1 overflow-y-auto">
          <LogTab />
        </div>
      )}
    </div>
  )
}
