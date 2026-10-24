'use client'

import { useEffect, useState } from 'react'
import { useT } from '@/components/marketing/lang-provider'
import { LeadChat } from '@/components/marketing/lead-chat'
import { OPEN_TAB_MESSAGE } from '@/lib/marketing/lead-windows'

/**
 * Inside a lead window (dev job 9aec66fa, Addendum G): the two tabs, Lead and Chat. The lead page (a server-rendered block) is passed in and stays mounted while the chat is
 * open; the chat is mounted ONLY while its tab is showing, so nothing is marked read while somebody is looking at the other tab. The Chat tab carries my unread number, kept
 * fresh by a short refresh while the Lead tab is showing.
 */
export function LeadWindowTabs({ leadId, chatOn, initialTab, initialUnread, children }: { leadId: string; chatOn: boolean; initialTab: 'lead' | 'chat'; initialUnread: number; children: React.ReactNode }) {
  const t = useT()
  const [tab, setTab] = useState<'lead' | 'chat'>(chatOn ? initialTab : 'lead')
  const [unread, setUnread] = useState(initialUnread)

  // the board asks this window to show a tab (a notification or the Messages list opened an already-open lead): same page, nothing reloaded, nothing typed is lost
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const d = e.data as { type?: string; tab?: string } | null
      if (e.origin !== window.location.origin || !d || d.type !== OPEN_TAB_MESSAGE) return
      if (d.tab === 'chat' && chatOn) setTab('chat')
      else if (d.tab === 'lead') setTab('lead')
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
  }, [chatOn])

  useEffect(() => {
    if (!chatOn) return
    if (tab === 'chat') { setUnread(0); return }
    const poll = async () => {
      if (document.visibilityState !== 'visible') return
      try {
        const r = await fetch('/api/marketing/chat/unread')
        if (r.ok) { const d = await r.json(); setUnread(Number(d.by_lead?.[leadId] ?? 0)) }
      } catch { /* the number is only a convenience */ }
    }
    const timer = setInterval(poll, 8000)
    return () => clearInterval(timer)
  }, [chatOn, tab, leadId])

  if (!chatOn) return <main className="p-4">{children}</main>
  const tabBtn = (key: 'lead' | 'chat', label: string, badge?: number) => (
    <button type="button" role="tab" aria-selected={tab === key} data-testid={`tab-${key}`} onClick={() => setTab(key)}
      className={`px-5 py-2 text-sm ${tab === key ? 'border-b-2 border-slate-900 font-semibold text-slate-900' : 'text-slate-500 hover:text-slate-800'}`}>
      {label}{badge ? <span className="ml-1.5 rounded-full bg-red-600 px-1.5 text-[11px] font-semibold text-white" data-testid="chat-tab-unread">{badge}</span> : null}
    </button>
  )
  return (
    <div className="flex h-screen flex-col">
      <div role="tablist" className="flex shrink-0 border-b bg-white">{tabBtn('lead', t('Lead'))}{tabBtn('chat', t('Chat'), tab === 'chat' ? 0 : unread)}</div>
      <div className="min-h-0 flex-1">
        <main className="h-full overflow-y-auto p-4" hidden={tab !== 'lead'}>{children}</main>
        {tab === 'chat' && <div className="h-full" data-testid="chat-pane"><LeadChat leadId={leadId} /></div>}
      </div>
    </div>
  )
}
