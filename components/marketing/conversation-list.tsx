'use client'

import { useState } from 'react'
import { useLang, useT } from '@/components/marketing/lang-provider'
import { useLeadWindows } from '@/components/marketing/lead-windows-host'
import { localeFor } from '@/lib/marketing/i18n'
import { formatWhen } from '@/lib/marketing/lead-view'
import type { Conversation } from '@/lib/marketing/lead-chat-server'

/** The chats about leads, newest first, a red number on those with something new (dev job 9aec66fa). A click opens the lead on its Chat tab in a floating window. */
export function ConversationList({ conversations }: { conversations: Conversation[] }) {
  const t = useT()
  const lang = useLang()
  const { open } = useLeadWindows()
  const [q, setQ] = useState('')
  const shown = conversations.filter(c => !q.trim() || c.name.toLowerCase().includes(q.trim().toLowerCase()) || c.last.toLowerCase().includes(q.trim().toLowerCase()))
  return (
    <section className="rounded-xl border bg-white" aria-label={t('Chats about leads')} data-testid="messages">
      <div className="border-b p-3"><input value={q} onChange={e => setQ(e.target.value)} placeholder={t('Search the chats')} aria-label={t('Search the chats')} className="h-9 w-full rounded-lg border bg-white px-3 text-sm outline-none focus:border-slate-500" data-testid="chat-filter" /></div>
      {shown.length === 0 ? <p className="p-5 text-sm text-slate-500">{conversations.length === 0 ? t('No conversations yet. Open a lead and write in its Chat tab.') : t('No chat matches.')}</p> : (
        <ul className="divide-y">
          {shown.map(c => (
            <li key={c.leadId}>
              <button type="button" onClick={() => open({ id: c.leadId, name: c.name }, 'chat')} data-testid="conversation" data-lead={c.leadId} className="flex w-full items-start justify-between gap-3 px-4 py-3 text-left hover:bg-slate-50">
                <span className="min-w-0"><b className="block truncate text-sm font-medium">{c.name}</b><span className="block truncate text-xs text-slate-500">{c.lastBy ? `${c.lastBy}: ` : ''}{t(c.last)}</span></span>
                <span className="flex shrink-0 flex-col items-end gap-1"><span className="text-[11px] text-slate-400">{formatWhen(c.lastAt, 'Europe/Rome', localeFor(lang))}</span>{c.unread > 0 && <span className="rounded-full bg-red-600 px-1.5 text-[11px] font-semibold text-white" data-testid="conversation-unread">{c.unread}</span>}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
