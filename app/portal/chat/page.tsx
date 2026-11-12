import { createClient } from '@/lib/supabase/server'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { getClientContactId } from '@/lib/portal-auth'
import { getTeammateScopeOrNull } from '@/lib/portal/team/gate'
import { getChatEntities, type PortalChatEntity } from '@/lib/portal/queries'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { t, getLocale } from '@/lib/portal/i18n'
import { cookies } from 'next/headers'
import { PortalChat } from '@/components/portal/portal-chat'
import type { ChatScope } from '@/lib/hooks/use-portal-chat'
import { LogTab } from '@/components/portal/chat/log-tab'
import { cn } from '@/lib/utils'
import { getClientAppModeActive } from '@/lib/app-mode/server'

export default async function PortalChatPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string; topic?: string }>
}) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) redirect('/portal/login')

  const contactId = getClientContactId(user)
  const { view, topic } = await searchParams

  let entities: PortalChatEntity[] = []
  let selectedEntityId = ''
  let scope: ChatScope
  let selectedAccountId: string | undefined

  if (contactId) {
    entities = await getChatEntities(contactId)
    const cookieStore = await cookies()
    const cookieFormationId = cookieStore.get('portal_formation')?.value
    const cookieAccountId = cookieStore.get('portal_account_id')?.value

    // Resolve the selected entity, mirroring the sidebar switcher's cookie
    // precedence: a formation selection wins, then portal_account_id (which can
    // be a real account id OR the 'personal' sentinel), else the first entity.
    const byId = new Map(entities.map(e => [e.id, e]))
    // (A "new message" link's company is applied BEFORE this page renders, by
    // /portal/chat/open, which saves it to these same cookies — dev job 05d997f2.)
    const selected =
      (cookieFormationId ? byId.get(cookieFormationId) : undefined) ??
      (cookieAccountId ? byId.get(cookieAccountId) : undefined) ??
      entities[0]

    selectedEntityId = selected?.id ?? 'personal'
    selectedAccountId = selected?.accountId ?? undefined

    if (selected && selected.kind === 'company' && selected.accountId) {
      scope = {
        mode: 'company',
        accountId: selected.accountId,
        contactId,
        includePersonalNull: selected.includePersonalNull,
      }
    } else {
      // formation / personal / no entity → the contact's own untagged thread.
      scope = { mode: 'personal', contactId }
    }
  } else {
    // Teammate (Portal Team Access): no contact → scope chat to their ONE company
    // when the 'chat' capability is granted; otherwise send them back to the portal.
    const tmAccountId = await getTeammateScopeOrNull(user, 'chat')
    if (!tmAccountId) redirect('/portal')
    selectedAccountId = tmAccountId
    const { data: acct } = await supabaseAdmin
      .from('accounts')
      .select('id, company_name')
      .eq('id', tmAccountId)
      .single()
    const label = acct?.company_name ?? 'Company'
    entities = [{ id: tmAccountId, kind: 'company', label, accountId: tmAccountId, isShared: false, includePersonalNull: false }]
    selectedEntityId = tmAccountId
    scope = { mode: 'account', accountId: tmAccountId }
  }

  const locale = getLocale(user)
  // Deep-linked topic (Wave 2): tax notification links open the chat ON the
  // tax tab so the client's reply is tagged without them knowing anything.
  const initialTopic = typeof topic === 'string' && topic.trim() ? topic.trim().slice(0, 100) : null
  // Teammates are scoped to chat only — the Journey Log (contact-oriented) is hidden.
  const isTeammate = !contactId
  // Inside the client iPhone app (dev job 056a70d0, Step 3b): the screen's name sits in the top row (lib/portal-app/frame.ts), the
  // "Tony Durante Team" line moves into the chat's own header next to the Topic button, and there is no Journey Log, only the messages.
  const appMode = await getClientAppModeActive()
  const activeView = view === 'log' && !isTeammate && !appMode ? 'log' : 'chat'

  return (
    <div
      // Inside the app the page is exactly "the screen minus the 52 px top row" with a slim edge, and the website's top-bar spacer / padding are gone
      // (they left a blank strip and squeezed the messages). The marker lets the stylesheet hide the privacy box on this screen only.
      data-app-screen={appMode ? 'chat' : undefined}
      className={appMode
        ? 'px-2 pb-2 max-w-4xl mx-auto h-[calc(100dvh-52px)] flex flex-col overflow-hidden'
        : 'p-4 sm:p-6 lg:p-8 max-w-4xl mx-auto h-[calc(100dvh-3.5rem)] lg:h-[calc(100dvh-6rem)] flex flex-col overflow-hidden'}
    >
      {!appMode && (
        <div className="mb-3 sm:mb-4">
          <h1 className="text-xl sm:text-2xl font-semibold tracking-tight text-zinc-900">{t('chat.title', locale)}</h1>
          <p className="text-zinc-500 text-xs sm:text-sm mt-1">{t('chat.team', locale)}</p>
        </div>
      )}

      {/* Tab switcher — hidden for teammates (chat-only scope) and inside the client app (no Journey Log there) */}
      {!isTeammate && !appMode && (
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
      )}

      {activeView === 'chat' ? (
        <PortalChat
          scope={scope}
          accountId={selectedAccountId}
          contactId={contactId ?? ''}
          userId={user.id}
          locale={locale}
          entities={entities}
          selectedEntityId={selectedEntityId}
          initialTopic={initialTopic}
        />
      ) : (
        <div className="flex-1 overflow-y-auto">
          <LogTab />
        </div>
      )}
    </div>
  )
}
