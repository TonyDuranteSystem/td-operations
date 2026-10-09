'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { ChevronLeft, Loader2, Plus } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { cn } from '@/lib/utils'
import { uploadTeamAttachment } from '@/lib/team/attachment'
import {
  directMessages, dmName, initials, membersWithoutChat, otherUserId, startThreadId, timeLabel, dayLabel,
  type TalkAttachment, type TalkMember, type TalkMessage, type TalkThread,
} from '@/lib/talk/chat-model'
import { TalkMessages } from '@/components/talk/talk-messages'
import { TalkComposer, type TalkSendInput } from '@/components/talk/talk-composer'

const LAST_OPENED_KEY = 'td-talk-last-chat'
const POLL_MS = 10_000

const COLORS = ['bg-rose-500', 'bg-indigo-500', 'bg-emerald-600', 'bg-amber-600', 'bg-sky-600', 'bg-violet-600']
function colorFor(id: string): string {
  let h = 0
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0
  return COLORS[h % COLORS.length]
}

function Avatar({ name, id, size = 'h-10 w-10 text-sm' }: { name: string; id: string; size?: string }) {
  return (
    <span className={cn('flex shrink-0 items-center justify-center rounded-full font-semibold text-white', size, colorFor(id))}>
      {initials(name)}
    </span>
  )
}

function readLastOpened(): string | null {
  try { return window.localStorage.getItem(LAST_OPENED_KEY) } catch { return null }
}
function writeLastOpened(id: string | null) {
  try { if (id) window.localStorage.setItem(LAST_OPENED_KEY, id); else window.localStorage.removeItem(LAST_OPENED_KEY) } catch { /* private mode */ }
}

/**
 * TD Talk — a WhatsApp-style chat for the team (dev job c1e326dd). It opens straight into a conversation (the one
 * with the most recent activity, or the one you left open, or the one a tapped notification points at); a back arrow
 * leads to the short list of people. It reads and writes the existing Team Chat data (direct messages) — the same
 * messages the CRM's Team Chat shows — through the existing routes, so every rule there (notifications, silence
 * for client conversations, read pointers) applies unchanged.
 *
 * READ RULE: opening a conversation marks it read (the server does that on GET). Nothing marks anything read while the
 * app is in the background — a notification is how you learn about a message then.
 */
export function TalkApp() {
  const searchParams = useSearchParams()
  const urlThread = searchParams.get('thread')

  const [threads, setThreads] = useState<TalkThread[]>([])
  const [members, setMembers] = useState<TalkMember[]>([])
  const [meId, setMeId] = useState<string | null>(null)
  const [booting, setBooting] = useState(true)
  const [bootError, setBootError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [messages, setMessages] = useState<TalkMessage[]>([])
  const [peerReadAt, setPeerReadAt] = useState<string | null>(null)
  const [loadingMsgs, setLoadingMsgs] = useState(false)
  const [startingWith, setStartingWith] = useState<string | null>(null)

  const selectedIdRef = useRef<string | null>(null)
  const meIdRef = useRef<string | null>(null)
  const threadsRef = useRef<TalkThread[]>([])
  const initialisedRef = useRef(false)
  selectedIdRef.current = selectedId
  meIdRef.current = meId
  threadsRef.current = threads

  const dms = useMemo(() => directMessages(threads), [threads])

  const loadThreads = useCallback(async (): Promise<TalkThread[] | null> => {
    try {
      const r = await fetch('/api/team/threads')
      if (!r.ok) throw new Error('Could not load your chats.')
      const d = await r.json()
      setThreads(d.threads ?? [])
      setMembers((d.members ?? []).map((m: { id: string; name: string }) => ({ id: m.id, name: m.name })))
      setMeId(d.current_user_id ?? null)
      meIdRef.current = d.current_user_id ?? null
      return d.threads ?? []
    } catch (e) {
      if (!initialisedRef.current) setBootError(e instanceof Error ? e.message : 'Could not load your chats.')
      return null
    }
  }, [])

  // opens a conversation's messages. `markRead` follows the READ RULE (only while the app is on screen).
  const loadMessages = useCallback(async (threadId: string, opts: { silent?: boolean } = {}) => {
    if (!opts.silent) setLoadingMsgs(true)
    try {
      const visible = typeof document === 'undefined' || document.visibilityState === 'visible'
      const r = await fetch(`/api/team/threads/${threadId}${visible ? '' : '?mark_read=0'}`)
      if (!r.ok) throw new Error('Could not load this chat.')
      const d = await r.json()
      if (selectedIdRef.current !== threadId) return // switched chats while loading
      const incoming = (d.messages ?? []) as TalkMessage[]
      setMessages(prev => {
        if (opts.silent) {
          const a = prev[prev.length - 1], b = incoming[incoming.length - 1]
          if (prev.length === incoming.length && a?.id === b?.id && a?.message === b?.message && a?.deleted_at === b?.deleted_at) return prev
        }
        return incoming
      })
      setPeerReadAt(d.peer_read_at ?? null)
    } catch (e) {
      if (!opts.silent) toast.error(e instanceof Error ? e.message : 'Could not load this chat.')
    } finally {
      if (!opts.silent) setLoadingMsgs(false)
    }
  }, [])

  const select = useCallback((id: string | null) => {
    setSelectedId(id)
    setMessages([])
    setPeerReadAt(null)
    writeLastOpened(id)
    try {
      // The open chat lives in the address (?thread=…): a refresh reopens it, and the pop-up rule ("silent only for
      // the chat you are looking at") reads it.
      window.history.replaceState(null, '', id ? `/talk?thread=${id}` : '/talk')
    } catch { /* ignore */ }
  }, [])

  // first load: threads, then straight into a conversation
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const list = await loadThreads()
      if (cancelled || !list) { setBooting(false); return }
      initialisedRef.current = true
      const chats = directMessages(list)
      const first = startThreadId(chats, { wanted: new URLSearchParams(window.location.search).get('thread'), lastOpened: readLastOpened() })
      if (first) select(first)
      setBooting(false)
    })()
    return () => { cancelled = true }
  }, [loadThreads, select])

  // a tapped notification (or any link) while the app is open: go to that chat
  useEffect(() => {
    if (!initialisedRef.current || !urlThread || urlThread === selectedIdRef.current) return
    if (threadsRef.current.some(t => t.id === urlThread && t.thread_type === 'dm')) { select(urlThread); return }
    void loadThreads().then(list => {
      if (list && directMessages(list).some(t => t.id === urlThread)) select(urlThread)
    })
  }, [urlThread, loadThreads, select])

  // open conversation: load now
  useEffect(() => {
    if (selectedId) void loadMessages(selectedId)
  }, [selectedId, loadMessages])

  // live updates + a slow poll as the safety net, and catching up when the app comes back to the screen
  useEffect(() => {
    const supabase = createClient()
    let debounce: ReturnType<typeof setTimeout> | null = null
    const refreshList = () => { if (debounce) clearTimeout(debounce); debounce = setTimeout(() => { void loadThreads() }, 500) }
    const channel = supabase
      .channel('talk-chat')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'internal_messages' }, payload => {
        const m = payload.new as TalkMessage & { thread_id: string }
        if (m.thread_id === selectedIdRef.current) {
          setMessages(prev => prev.some(x => x.id === m.id) ? prev : [...prev, m])
          // someone else's message in the chat I am looking at: it is read the moment it appears (never while hidden)
          if (m.sender_id !== meIdRef.current && document.visibilityState === 'visible') {
            void fetch(`/api/team/threads/${m.thread_id}/read`, { method: 'POST' }).catch(() => {})
          }
        }
        refreshList()
      })
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'internal_messages' }, payload => {
        const m = payload.new as TalkMessage & { thread_id: string }
        if (m.thread_id === selectedIdRef.current) setMessages(prev => prev.map(x => x.id === m.id ? { ...x, ...m } : x))
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'internal_thread_reads' }, payload => {
        const row = payload.new as { thread_id?: string; user_id?: string; last_read_at?: string } | undefined
        if (row?.thread_id === selectedIdRef.current && row.user_id && row.user_id !== meIdRef.current && row.last_read_at) {
          setPeerReadAt(row.last_read_at)
        }
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'internal_threads' }, refreshList)
      .subscribe()

    const tick = () => {
      if (document.visibilityState !== 'visible') return
      if (selectedIdRef.current) void loadMessages(selectedIdRef.current, { silent: true })
      void loadThreads()
    }
    const timer = setInterval(tick, POLL_MS)
    const onVisible = () => { if (document.visibilityState === 'visible') tick() }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
      if (debounce) clearTimeout(debounce)
      supabase.removeChannel(channel)
    }
  }, [loadThreads, loadMessages])

  const send = useCallback(async ({ text, files }: TalkSendInput): Promise<boolean> => {
    const threadId = selectedIdRef.current
    if (!threadId) return false
    const voiceOnly = !text && files.length === 1 && files[0].type.startsWith('audio/')
    try {
      const attachments: TalkAttachment[] = []
      for (const f of files) attachments.push(await uploadTeamAttachment(f, threadId))
      const r = await fetch(`/api/team/threads/${threadId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, reply_to_id: null, attachments: attachments.length ? attachments : null }),
      })
      if (!r.ok) {
        const d = await r.json().catch(() => ({}))
        throw new Error(d.error || 'Could not send. Please try again.')
      }
      const d = await r.json().catch(() => null)
      if (d?.message && selectedIdRef.current === threadId) {
        setMessages(prev => prev.some(x => x.id === d.message.id) ? prev : [...prev, d.message])
      }
      return true
    } catch (e) {
      const why = e instanceof Error && e.message ? e.message : 'Could not send. Please try again.'
      toast.error(voiceOnly ? `${why} Please record the voice message again.` : why)
      return false
    }
  }, [])

  const startChat = useCallback(async (userId: string) => {
    setStartingWith(userId)
    try {
      const r = await fetch('/api/team/dms', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user_id: userId }) })
      const d = await r.json().catch(() => ({}))
      if (!r.ok || !d.thread?.id) throw new Error(d.error || 'Could not start the chat.')
      await loadThreads()
      select(d.thread.id)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not start the chat.')
    } finally {
      setStartingWith(null)
    }
  }, [loadThreads, select])

  const selected = dms.find(t => t.id === selectedId) ?? null
  const strangers = useMemo(() => membersWithoutChat(dms, meId, members), [dms, meId, members])
  const canGoBack = dms.length > 1 || strangers.length > 0
  const otherUnread = dms.filter(t => t.id !== selectedId).reduce((n, t) => n + (t.unread_count ?? 0), 0)

  if (booting) {
    return <div className="flex h-full items-center justify-center bg-white"><Loader2 className="h-6 w-6 animate-spin text-zinc-400" /></div>
  }
  if (bootError) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 bg-white px-6 text-center">
        <p className="text-sm text-zinc-600">{bootError}</p>
        <button type="button" onClick={() => window.location.reload()} className="rounded-full bg-[#BE1E2D] px-5 py-2 text-sm font-semibold text-white">Try again</button>
      </div>
    )
  }

  // ── People (the short list) ──
  if (!selected) {
    return (
      <div className="flex h-full flex-col bg-white" data-testid="talk-people">
        <div className="shrink-0 border-b border-zinc-200 px-4 py-3">
          <h1 className="text-lg font-semibold text-zinc-900">TD Talk</h1>
        </div>
        <div className="flex-1 overflow-y-auto">
          {dms.map(t => {
            const name = dmName(t, meId, members)
            const other = otherUserId(t.dm_key, meId) ?? t.id
            return (
              <button key={t.id} type="button" onClick={() => select(t.id)} className="flex w-full items-center gap-3 border-b border-zinc-100 px-4 py-3 text-left active:bg-zinc-50" data-testid="talk-person">
                <Avatar name={name} id={other} size="h-12 w-12 text-base" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[16px] font-medium text-zinc-900">{name}</span>
                  {t.last_activity_at && <span className="block text-xs text-zinc-400">{dayLabel(t.last_activity_at) === 'Today' ? timeLabel(t.last_activity_at) : dayLabel(t.last_activity_at)}</span>}
                </span>
                {(t.unread_count ?? 0) > 0 && (
                  <span className="flex h-6 min-w-6 items-center justify-center rounded-full bg-[#BE1E2D] px-1.5 text-xs font-semibold text-white">{t.unread_count}</span>
                )}
              </button>
            )
          })}
          {strangers.length > 0 && (
            <div className="px-4 pb-4 pt-5">
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-400">Start a chat</p>
              {strangers.map(m => (
                <button key={m.id} type="button" disabled={startingWith === m.id} onClick={() => void startChat(m.id)} className="flex w-full items-center gap-3 rounded-lg py-2 text-left active:bg-zinc-50 disabled:opacity-50">
                  <Avatar name={m.name} id={m.id} />
                  <span className="flex-1 text-[15px] text-zinc-800">{m.name}</span>
                  <Plus className="h-4 w-4 text-zinc-400" />
                </button>
              ))}
            </div>
          )}
          {dms.length === 0 && strangers.length === 0 && (
            <p className="px-6 py-12 text-center text-sm text-zinc-400">No teammates to chat with yet.</p>
          )}
        </div>
      </div>
    )
  }

  // ── The conversation ──
  const name = dmName(selected, meId, members)
  const other = otherUserId(selected.dm_key, meId) ?? selected.id
  return (
    <div className="flex h-full flex-col bg-white" data-testid="talk-chat">
      <div className="flex shrink-0 items-center gap-2 border-b border-zinc-200 bg-white px-2 py-2">
        {canGoBack ? (
          <button type="button" onClick={() => select(null)} aria-label="Back to your chats" className="relative flex h-10 w-10 items-center justify-center rounded-full text-zinc-700 active:bg-zinc-100" data-testid="talk-back">
            <ChevronLeft className="h-6 w-6" />
            {otherUnread > 0 && <span className="absolute right-0 top-0 flex h-4 min-w-4 items-center justify-center rounded-full bg-[#BE1E2D] px-1 text-[10px] font-semibold text-white">{otherUnread}</span>}
          </button>
        ) : <span className="w-2" />}
        <Avatar name={name} id={other} />
        <span className="min-w-0 flex-1 truncate text-[17px] font-semibold text-zinc-900" data-testid="talk-title">{name}</span>
      </div>
      {meId && <TalkMessages threadId={selected.id} messages={messages} meId={meId} peerReadAt={peerReadAt} loading={loadingMsgs} />}
      <TalkComposer key={selected.id} onSend={send} />
    </div>
  )
}
