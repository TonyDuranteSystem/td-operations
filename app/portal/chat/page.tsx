import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import { getClientContactId } from '@/lib/portal-auth'
import { getPortalAccounts } from '@/lib/portal/queries'
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
  if (!selectedAccountId) redirect('/portal')

  return (
    <div className="p-6 lg:p-8 max-w-4xl mx-auto h-[calc(100vh-6rem)] flex flex-col">
      <div className="mb-4">
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-900">Support Chat</h1>
        <p className="text-zinc-500 text-sm mt-1">Chat with the Tony Durante team</p>
      </div>
      <PortalChat accountId={selectedAccountId} userId={user.id} />
    </div>
  )
}
