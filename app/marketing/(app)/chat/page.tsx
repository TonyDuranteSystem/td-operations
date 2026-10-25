import { redirect } from 'next/navigation'
import { resolveMarketingContext } from '@/lib/marketing/guard'
import { hasPermission } from '@/lib/marketing/permissions'
import { getLang } from '@/lib/marketing/lang'
import { makeT } from '@/lib/marketing/i18n'
import { listConversations } from '@/lib/marketing/lead-chat-server'
import { listThreads } from '@/lib/marketing/team-chat-server'
import { isInvolved } from '@/lib/marketing/lead-chat'
import { ChatWorkspace } from '@/components/marketing/chat-workspace'

export const dynamic = 'force-dynamic'

/**
 * TD Marketing — Chat (dev job 9aec66fa): direct messages, groups and the chats about leads, newest first, with a red number where something is new. Needs the chat permission (the ad person has
 * it: direct messages and groups are for the whole team). The chats about leads are listed only for people who work the leads (they also need the right to read leads); the team comes from the guard.
 */
export default async function MarketingChat({ searchParams }: { searchParams: Promise<{ thread?: string }> }) {
  const g = await resolveMarketingContext()
  if (g.ok === false) redirect('/marketing')
  const t = makeT(getLang())
  if (!hasPermission(g.ctx.permissions, 'chat')) {
    return <main className="mx-auto max-w-xl px-4 py-10"><p className="rounded-xl border border-amber-300 bg-amber-50 p-5 text-sm">{t('You do not have access to the chat. Ask your team owner.')}</p></main>
  }
  const sp = await searchParams
  const showLeads = hasPermission(g.ctx.permissions, 'leads.read') && isInvolved(g.ctx.permissions)
  const [snap, leadConversations] = await Promise.all([listThreads(g.ctx), showLeads ? listConversations(g.ctx) : Promise.resolve([])])
  return (
    <div className="space-y-4 p-6 pb-20">
      <div><h1 className="text-2xl font-semibold">{t('Chat')}</h1><p className="mt-1 text-sm text-slate-500">{t('Direct messages, groups and the chats about leads.')}</p></div>
      <ChatWorkspace initial={snap} leadConversations={leadConversations} showLeads={showLeads} startThread={typeof sp.thread === 'string' ? sp.thread : null} />
    </div>
  )
}
