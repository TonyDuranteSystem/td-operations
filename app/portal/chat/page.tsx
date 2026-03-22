import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { getClientContactId } from '@/lib/portal-auth'
import { getPortalAccounts } from '@/lib/portal/queries'
import { t, getLocale } from '@/lib/portal/i18n'
import { cookies } from 'next/headers'
import { PortalChat } from '@/components/portal/portal-chat'

export default async function PortalChatPage() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/portal/login')

  const contactId = getClientContactId(user)
  if (!contactId) redirect('/portal')

  const accounts = await getPortalAccounts(contactId)
  const cookieStore = cookies()
  const cookieAccountId = (await cookieStore).get('portal_account_id')?.value
  const selectedAccountId = accounts.find(a => a.id === cookieAccountId)?.id ?? accounts[0]?.id
  // Leads without an account can still use chat via contact_id
  const chatId = selectedAccountId || contactId

  const locale = getLocale(user)

  return (
    <div className="p-4 sm:p-6 lg:p-8 max-w-4xl mx-auto h-[calc(100dvh-3.5rem)] lg:h-[calc(100dvh-6rem)] flex flex-col">
      <div className="mb-3 sm:mb-4">
        <h1 className="text-xl sm:text-2xl font-semibold tracking-tight text-zinc-900">{t('chat.title', locale)}</h1>
        <p className="text-zinc-500 text-xs sm:text-sm mt-1">{t('chat.team', locale)}</p>
      </div>
      <PortalChat accountId={chatId} userId={user.id} />
    </div>
  )
}
