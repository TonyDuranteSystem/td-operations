import { redirect } from 'next/navigation'
import { resolveMarketingContext } from '@/lib/marketing/guard'
import { hasPermission } from '@/lib/marketing/permissions'
import { getLang } from '@/lib/marketing/lang'
import { makeT } from '@/lib/marketing/i18n'
import { listConversations } from '@/lib/marketing/lead-chat-server'
import { ConversationList } from '@/components/marketing/conversation-list'

export const dynamic = 'force-dynamic'

/**
 * TD Marketing — Chat (dev job 9aec66fa): the chats about leads, newest first, with a red number where something is new. A click opens the lead on its Chat tab in a floating window.
 * Needs the chat permission and the right to read leads (the same two as every chat route); the team comes from the guard.
 */
export default async function MarketingChat() {
  const g = await resolveMarketingContext()
  if (g.ok === false) redirect('/marketing')
  const t = makeT(getLang())
  if (!hasPermission(g.ctx.permissions, 'chat') || !hasPermission(g.ctx.permissions, 'leads.read')) {
    return <main className="mx-auto max-w-xl px-4 py-10"><p className="rounded-xl border border-amber-300 bg-amber-50 p-5 text-sm">{t('You do not have access to the chat. Ask your team owner.')}</p></main>
  }
  const conversations = await listConversations(g.ctx)
  return (
    <div className="space-y-4 p-6 pb-20">
      <div><h1 className="text-2xl font-semibold">{t('Chat')}</h1><p className="mt-1 text-sm text-slate-500">{t('Chats about leads. Click one to open the lead on its Chat tab.')}</p></div>
      <ConversationList conversations={conversations} />
    </div>
  )
}
