'use client'

import { useEffect, useState } from 'react'
import { useT } from '@/components/marketing/lang-provider'
import { LeadChat } from '@/components/marketing/lead-chat'
import { FRAME_FOCUS, OPEN_TAB_MESSAGE, WINDOW_STATE_MESSAGE, isChatTab, laneOfTab } from '@/lib/marketing/lead-windows'
import { setFrameHidden } from '@/lib/marketing/frame-visibility'

export interface LaneTab { lane: 'owners' | 'setter'; label: string; unread: number }

/**
 * Inside a lead window (dev job 9aec66fa, Addendum G): the tabs. Lead, then one button per chat the person may use (Rocco: "Discuss with Antonio" and "Discuss with Cristina"; the setter: "Discuss with Rocco";
 * Antonio: "Chat with Rocco") — a lead has two chats and nobody is ever handed one that is not theirs. The lead page (a server-rendered block) is passed in and stays mounted while a chat is
 * open; a chat is mounted ONLY while its tab is showing, so nothing is marked read while somebody is looking at the other tab. Each button carries my unread number, kept fresh by a short refresh while it is not showing.
 */
export function LeadWindowTabs({ leadId, chatOn, initialTab, lanes, children }: { leadId: string; chatOn: boolean; initialTab: string; lanes: LaneTab[]; children: React.ReactNode }) {
  const t = useT()
  // the tab asked for: "chat" = the first chat; "chat:<lane>" = that chat when it is one of mine
  const laneFor = (tab: string | null | undefined): 'owners' | 'setter' | null => {
    if (!chatOn || lanes.length === 0) return null
    const asked = laneOfTab(tab)
    return asked && lanes.some(l => l.lane === asked) ? asked : isChatTab(tab) ? lanes[0].lane : null
  }
  const [tab, setTab] = useState<'lead' | 'owners' | 'setter'>(laneFor(initialTab) ?? 'lead')
  const [unread, setUnread] = useState<Record<string, number>>(() => Object.fromEntries(lanes.map(l => [l.lane, l.unread])))

  // the board asks this window to show a tab (a notification or the Messages list opened an already-open lead): same page, nothing reloaded, nothing typed is lost
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const d = e.data as { type?: string; tab?: string; hidden?: boolean } | null
      if (e.origin !== window.location.origin || e.source !== window.parent || !d) return
      if (d.type === WINDOW_STATE_MESSAGE) { setFrameHidden(d.hidden === true); return }
      if (d.type !== OPEN_TAB_MESSAGE) return
      const lane = laneFor(d.tab)
      if (lane) setTab(lane)
      else if (d.tab === 'lead') setTab('lead')
    }
    window.addEventListener('message', onMessage)
    return () => window.removeEventListener('message', onMessage)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- laneFor only reads chatOn and lanes
  }, [chatOn, lanes])

  // a click inside this window brings it to the front of the board's other windows
  useEffect(() => {
    if (window.parent === window) return
    const toFront = () => window.parent.postMessage({ type: FRAME_FOCUS, leadId }, window.location.origin)
    window.addEventListener('pointerdown', toFront, { capture: true, passive: true })
    return () => window.removeEventListener('pointerdown', toFront, { capture: true })
  }, [leadId])

  useEffect(() => {
    if (!chatOn) return
    // the chat on screen is read: its number goes at once
    if (tab !== 'lead') setUnread(u => ({ ...u, [tab]: 0 }))
    const poll = async () => {
      if (document.visibilityState !== 'visible') return
      try {
        const r = await fetch('/api/marketing/chat/unread')
        if (r.ok) { const d = await r.json(); setUnread(u => Object.fromEntries(Object.keys(u).map(lane => [lane, lane === tab ? 0 : Number(d.by_lane?.[`${leadId}|${lane}`] ?? 0)]))) }
      } catch { /* the number is only a convenience */ }
    }
    const timer = setInterval(poll, 8000)
    return () => clearInterval(timer)
  }, [chatOn, tab, leadId])

  if (!chatOn || lanes.length === 0) return <main className="p-4">{children}</main>
  const tabBtn = (key: 'lead' | 'owners' | 'setter', label: string, testId: string, badge?: number) => (
    <button type="button" role="tab" aria-selected={tab === key} data-testid={testId} onClick={() => setTab(key)}
      className={`px-5 py-2 text-sm ${tab === key ? 'border-b-2 border-slate-900 font-semibold text-slate-900' : 'text-slate-500 hover:text-slate-800'}`}>
      {label}{badge ? <span className="ml-1.5 rounded-full bg-red-600 px-1.5 text-[11px] font-semibold text-white" data-testid="chat-tab-unread">{badge}</span> : null}
    </button>
  )
  return (
    <div className="flex h-screen flex-col">
      <div role="tablist" className="flex shrink-0 flex-wrap border-b bg-white">
        {tabBtn('lead', t('Lead'), 'tab-lead')}
        {lanes.map(l => tabBtn(l.lane, t(l.label), lanes.length === 1 ? 'tab-chat' : `tab-chat-${l.lane}`, tab === l.lane ? 0 : unread[l.lane]))}
      </div>
      <div className="min-h-0 flex-1">
        <main className="h-full overflow-y-auto p-4" hidden={tab !== 'lead'}>{children}</main>
        {tab !== 'lead' && <div className="h-full" data-testid="chat-pane" data-lane={tab}><LeadChat key={tab} leadId={leadId} lane={tab} /></div>}
      </div>
    </div>
  )
}
