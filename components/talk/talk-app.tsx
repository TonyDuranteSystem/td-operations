'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { ChevronLeft, Loader2, Plus, Search, Users, X } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { cn } from '@/lib/utils'
import { uploadTeamAttachment } from '@/lib/team/attachment'
import {
  chatName, chatThreads, directMessages, groupMemberNames, initials, isGroupThread, matchMessages, membersWithoutChat, mergeSnapshot, messageSignature, otherUserId, parseTypingSignal, seenByAll, seenState, shouldAnnounceTyping, snippet, startThreadId, timeLabel, dayLabel, typingLabel, TYPING_EXPIRES_MS,
  type TalkAttachment, type TalkMember, type TalkMessage, type TalkReaction, type TalkThread, type TypingKind,
} from '@/lib/talk/chat-model'
import { TalkMessages } from '@/components/talk/talk-messages'
import { TalkComposer, type TalkComposerMode, type TalkSendInput } from '@/components/talk/talk-composer'
import { TalkMessageSheet } from '@/components/talk/talk-sheet'
import { TalkGroupInfo, TalkNewGroup } from '@/components/talk/talk-group-sheets'

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
  const [sheetMsg, setSheetMsg] = useState<TalkMessage | null>(null)
  const [mode, setMode] = useState<TalkComposerMode>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQ, setSearchQ] = useState('')
  const [highlightId, setHighlightId] = useState<string | null>(null)
  const messagesRef = useRef<TalkMessage[]>([])
  const [peerTyping, setPeerTyping] = useState<{ userId: string; kind: TypingKind } | null>(null)
  // groups: who is in the open group, how far each member has read, and the New-group / Group-info screens
  const [groupMemberIds, setGroupMemberIds] = useState<string[]>([])
  const [memberReads, setMemberReads] = useState<Record<string, string>>({})
  const [newGroupOpen, setNewGroupOpen] = useState(false)
  const [groupInfoOpen, setGroupInfoOpen] = useState(false)
  const [groupBusy, setGroupBusy] = useState(false)
  const typingChannelRef = useRef<ReturnType<ReturnType<typeof createClient>['channel']> | null>(null)
  const typingSentAtRef = useRef<number | null>(null)

  const selectedIdRef = useRef<string | null>(null)
  const meIdRef = useRef<string | null>(null)
  const threadsRef = useRef<TalkThread[]>([])
  const initialisedRef = useRef(false)
  selectedIdRef.current = selectedId
  meIdRef.current = meId
  threadsRef.current = threads
  messagesRef.current = messages

  const chats = useMemo(() => chatThreads(threads), [threads])
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
        // MERGE, never replace: a poll that started before a send (or a realtime message) and answers after it would
        // otherwise wipe that newer message until the next poll. Anything local that the snapshot does not have yet and
        // is not older than the snapshot is kept (council finding, 2026-10-09).
        const merged = mergeSnapshot(prev, incoming)
        if (opts.silent && messageSignature(merged) === messageSignature(prev)) return prev
        return merged
      })
      setPeerReadAt(d.peer_read_at ?? null)
      if (Array.isArray(d.members)) setGroupMemberIds(d.members as string[])
      if (Array.isArray(d.member_reads)) {
        const map: Record<string, string> = {}
        for (const r of d.member_reads as Array<{ user_id: string; last_read_at: string }>) map[r.user_id] = r.last_read_at
        setMemberReads(map)
      }
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
    setSheetMsg(null); setMode(null); setSearchOpen(false); setSearchQ(''); setHighlightId(null)
    setGroupInfoOpen(false); setNewGroupOpen(false); setGroupMemberIds([]); setMemberReads({})
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
      const all = chatThreads(list)
      const first = startThreadId(all, { wanted: new URLSearchParams(window.location.search).get('thread'), lastOpened: readLastOpened() })
      if (first) select(first)
      setBooting(false)
    })()
    return () => { cancelled = true }
  }, [loadThreads, select])

  // a tapped notification (or any link) while the app is open: go to that chat
  useEffect(() => {
    if (!initialisedRef.current || !urlThread || urlThread === selectedIdRef.current) return
    if (chatThreads(threadsRef.current).some(t => t.id === urlThread)) { select(urlThread); return }
    void loadThreads().then(list => {
      if (list && chatThreads(list).some(t => t.id === urlThread)) select(urlThread)
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
          if (m.sender_id !== meIdRef.current) setPeerTyping(null) // they sent it — no longer "typing…"
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
          const at = row.last_read_at
          setMemberReads(prev => ({ ...prev, [row.user_id as string]: at }))
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

  // "typing…": a lightweight broadcast on a per-chat channel (nothing is stored). Each side announces while it types or
  // records (at most every 2.5 s) and shows the other side's signal for 4 s. A message from the other person clears it.
  useEffect(() => {
    setPeerTyping(null)
    typingSentAtRef.current = null
    if (!selectedId) return
    const supabase = createClient()
    let expire: ReturnType<typeof setTimeout> | null = null
    const channel = supabase
      .channel(`talk-typing-${selectedId}`, { config: { broadcast: { self: false } } })
      .on('broadcast', { event: 'typing' }, ({ payload }) => {
        const sig = parseTypingSignal(payload, meIdRef.current)
        if (!sig) return
        setPeerTyping({ userId: sig.userId, kind: sig.kind })
        if (expire) clearTimeout(expire)
        expire = setTimeout(() => setPeerTyping(null), TYPING_EXPIRES_MS)
      })
      .subscribe()
    typingChannelRef.current = channel
    return () => {
      if (expire) clearTimeout(expire)
      typingChannelRef.current = null
      void supabase.removeChannel(channel)
    }
  }, [selectedId])

  const announceTyping = useCallback((kind: TypingKind) => {
    const now = Date.now()
    if (!shouldAnnounceTyping(typingSentAtRef.current, now)) return
    typingSentAtRef.current = now
    void typingChannelRef.current?.send({ type: 'broadcast', event: 'typing', payload: { user_id: meIdRef.current, kind } })
  }, [])

  const send = useCallback(async ({ text, files, replyToId }: TalkSendInput): Promise<boolean> => {
    const threadId = selectedIdRef.current
    if (!threadId) return false
    const voiceOnly = !text && files.length === 1 && files[0].type.startsWith('audio/')
    try {
      const attachments: TalkAttachment[] = []
      for (const f of files) attachments.push(await uploadTeamAttachment(f, threadId))
      const r = await fetch(`/api/team/threads/${threadId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, reply_to_id: replyToId ?? null, attachments: attachments.length ? attachments : null }),
      })
      if (!r.ok) {
        const d = await r.json().catch(() => ({}))
        throw new Error(d.error || 'Could not send. Please try again.')
      }
      const d = await r.json().catch(() => null)
      if (d?.message && selectedIdRef.current === threadId) {
        // the server's answer has no preview of the quoted message — attach it so the quote shows at once
        const quoted = replyToId ? messagesRef.current.find(x => x.id === replyToId) : null
        const withPreview: TalkMessage = quoted
          ? { ...d.message, reply_to_preview: { id: quoted.id, message: quoted.message, sender_name: quoted.sender_name, deleted_at: quoted.deleted_at ?? null } }
          : d.message
        setMessages(prev => prev.some(x => x.id === d.message.id) ? prev : [...prev, withPreview])
      }
      return true
    } catch (e) {
      const why = e instanceof Error && e.message ? e.message : 'Could not send. Please try again.'
      toast.error(voiceOnly ? `${why} Please record the voice message again.` : why)
      return false
    }
  }, [])

  // ── message actions (the long-press menu) ──
  const applyToMessage = useCallback((id: string, patch: Partial<TalkMessage>) => {
    setMessages(prev => prev.map(m => m.id === id ? { ...m, ...patch } : m))
  }, [])

  const react = useCallback(async (m: TalkMessage, emoji: string) => {
    setSheetMsg(null)
    try {
      const r = await fetch(`/api/team/messages/${m.id}/react`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ emoji }) })
      const d = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(d.error || 'Could not react.')
      if (Array.isArray(d.reactions)) applyToMessage(m.id, { reactions: d.reactions as TalkReaction[] })
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not react.')
    }
  }, [applyToMessage])

  const copyText = useCallback(async (m: TalkMessage) => {
    setSheetMsg(null)
    try { await navigator.clipboard.writeText(m.message); toast.success('Copied') } catch { toast.error('Could not copy.') }
  }, [])

  const edit = useCallback(async (id: string, text: string): Promise<boolean> => {
    if (!text.trim()) { toast.error('A message cannot be empty. Delete it instead.'); return false }
    try {
      const r = await fetch(`/api/team/messages/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: text }) })
      const d = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(d.error || 'Could not edit the message.')
      if (d.message) applyToMessage(id, { message: d.message.message, edited_at: d.message.edited_at })
      return true
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not edit the message.')
      return false
    }
  }, [applyToMessage])

  const remove = useCallback(async (m: TalkMessage) => {
    setSheetMsg(null)
    try {
      const r = await fetch(`/api/team/messages/${m.id}`, { method: 'DELETE' })
      const d = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(d.error || 'Could not delete the message.')
      applyToMessage(m.id, { deleted_at: new Date().toISOString() })
      setMode(cur => cur && cur.message.id === m.id ? null : cur)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not delete the message.')
    }
  }, [applyToMessage])

  const jumpTo = useCallback((id: string) => {
    if (!messagesRef.current.some(m => m.id === id)) { toast('That message is older than the latest 500 in this chat.'); return }
    setSearchOpen(false)
    // the message list is not on screen while searching — give it a moment to come back, then scroll and flash the message
    setTimeout(() => {
      document.querySelector(`[data-mid="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' })
      setHighlightId(id)
      setTimeout(() => setHighlightId(cur => cur === id ? null : cur), 1800)
    }, 120)
  }, [])

  // ── groups ──
  const createNewGroup = useCallback(async (name: string, memberIds: string[]) => {
    setGroupBusy(true)
    try {
      const r = await fetch('/api/team/groups', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, member_ids: memberIds }) })
      const d = await r.json().catch(() => ({}))
      if (!r.ok || !d.thread?.id) throw new Error(d.error || 'Could not create the group.')
      await loadThreads()
      select(d.thread.id)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not create the group.')
    } finally {
      setGroupBusy(false)
    }
  }, [loadThreads, select])

  const addToGroup = useCallback(async (userIds: string[]) => {
    const id = selectedIdRef.current
    if (!id) return
    setGroupBusy(true)
    try {
      const r = await fetch(`/api/team/groups/${id}/members`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user_ids: userIds }) })
      const d = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(d.error || 'Could not add them.')
      if (Array.isArray(d.members)) setGroupMemberIds(d.members as string[])
      await loadThreads()
      setGroupInfoOpen(false)
      toast.success('Added to the group.')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not add them.')
    } finally {
      setGroupBusy(false)
    }
  }, [loadThreads])

  const renameThisGroup = useCallback(async (name: string) => {
    const id = selectedIdRef.current
    if (!id) return
    setGroupBusy(true)
    try {
      const r = await fetch(`/api/team/groups/${id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) })
      const d = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(d.error || 'Could not rename the group.')
      await loadThreads()
      setGroupInfoOpen(false)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not rename the group.')
    } finally {
      setGroupBusy(false)
    }
  }, [loadThreads])

  const leaveThisGroup = useCallback(async () => {
    const id = selectedIdRef.current
    if (!id) return
    setGroupBusy(true)
    try {
      const r = await fetch(`/api/team/groups/${id}/members`, { method: 'DELETE' })
      const d = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(d.error || 'Could not leave the group.')
      select(null)
      await loadThreads()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not leave the group.')
    } finally {
      setGroupBusy(false)
    }
  }, [loadThreads, select])

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

  const selected = chats.find(t => t.id === selectedId) ?? null
  const strangers = useMemo(() => membersWithoutChat(dms, meId, members), [dms, meId, members])
  // always reachable now: the list is also where you start a group
  const canGoBack = true
  const otherUnread = chats.filter(t => t.id !== selectedId).reduce((n, t) => n + (t.unread_count ?? 0), 0)

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

  // ── New group ──
  if (newGroupOpen && meId) {
    return <TalkNewGroup members={members} meId={meId} creating={groupBusy} onBack={() => setNewGroupOpen(false)} onCreate={(name, ids) => void createNewGroup(name, ids)} />
  }

  // ── People (the short list) ──
  if (!selected) {
    return (
      <div className="flex h-full flex-col bg-white" data-testid="talk-people">
        <div className="flex shrink-0 items-center justify-between border-b border-zinc-200 px-4 py-3">
          <h1 className="text-lg font-semibold text-zinc-900">TD Talk</h1>
          <button type="button" onClick={() => setNewGroupOpen(true)} data-testid="talk-new-group" className="flex items-center gap-1.5 rounded-full border border-zinc-200 px-3 py-1.5 text-sm font-medium text-zinc-800 active:bg-zinc-100">
            <Users className="h-4 w-4" /> New group
          </button>
        </div>
        <div className="flex-1 overflow-y-auto">
          {chats.map(t => {
            const group = isGroupThread(t)
            const name = chatName(t, meId, members)
            const other = group ? t.id : (otherUserId(t.dm_key, meId) ?? t.id)
            return (
              <button key={t.id} type="button" onClick={() => select(t.id)} className="flex w-full items-center gap-3 border-b border-zinc-100 px-4 py-3 text-left active:bg-zinc-50" data-testid={group ? 'talk-group-row' : 'talk-person'}>
                <Avatar name={name} id={other} size="h-12 w-12 text-base" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[16px] font-medium text-zinc-900">{name}</span>
                  <span className="block truncate text-xs text-zinc-400">
                    {group ? `${(t.members ?? []).length} people` : null}
                    {group && t.last_activity_at ? ' · ' : null}
                    {t.last_activity_at ? (dayLabel(t.last_activity_at) === 'Today' ? timeLabel(t.last_activity_at) : dayLabel(t.last_activity_at)) : null}
                  </span>
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
          {chats.length === 0 && strangers.length === 0 && (
            <p className="px-6 py-12 text-center text-sm text-zinc-400">No teammates to chat with yet.</p>
          )}
        </div>
      </div>
    )
  }

  // ── The conversation ──
  const group = isGroupThread(selected)
  const name = chatName(selected, meId, members)
  const other = group ? selected.id : (otherUserId(selected.dm_key, meId) ?? selected.id)
  const memberIdsNow = group ? (groupMemberIds.length > 0 ? groupMemberIds : (selected.members ?? [])) : []
  const typingWho = group && peerTyping ? members.find(m => m.id === peerTyping.userId)?.name ?? 'Someone' : null
  const isSeen = (m: TalkMessage): boolean => {
    if (!group) return seenState(m, peerReadAt) === 'seen'
    return seenByAll(m, memberIdsNow.filter(id => id !== meId), memberReads)
  }
  return (
    <div className="flex h-full flex-col bg-white" data-testid="talk-chat">
      <div className="flex shrink-0 items-center gap-2 border-b border-zinc-200 bg-white px-2 py-2">
        {canGoBack ? (
          <button type="button" onClick={() => select(null)} aria-label="Back to your chats" className="relative flex h-10 w-10 items-center justify-center rounded-full text-zinc-700 active:bg-zinc-100" data-testid="talk-back">
            <ChevronLeft className="h-6 w-6" />
            {otherUnread > 0 && <span className="absolute right-0 top-0 flex h-4 min-w-4 items-center justify-center rounded-full bg-[#BE1E2D] px-1 text-[10px] font-semibold text-white">{otherUnread}</span>}
          </button>
        ) : <span className="w-2" />}
        <button type="button" disabled={!group} onClick={() => setGroupInfoOpen(true)} data-testid="talk-header" className="flex min-w-0 flex-1 items-center gap-2 text-left disabled:cursor-default">
          <Avatar name={name} id={other} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-[17px] font-semibold leading-tight text-zinc-900" data-testid="talk-title">{name}</span>
            {peerTyping
              ? <span className="block truncate text-xs text-[#BE1E2D]" data-testid="talk-typing">{typingLabel(peerTyping.kind, typingWho)}</span>
              : group && <span className="block truncate text-xs text-zinc-400" data-testid="talk-members">{groupMemberNames(memberIdsNow, meId, members)}</span>}
          </span>
        </button>
        <button type="button" onClick={() => { setSearchOpen(o => !o); setSearchQ('') }} aria-label="Search this chat" data-testid="talk-search-toggle" className="flex h-10 w-10 items-center justify-center rounded-full text-zinc-600 active:bg-zinc-100">
          {searchOpen ? <X className="h-5 w-5" /> : <Search className="h-5 w-5" />}
        </button>
      </div>
      {searchOpen && (
        <div className="flex min-h-0 flex-1 flex-col bg-white" data-testid="talk-search">
          <div className="shrink-0 border-b border-zinc-200 px-3 py-2">
            <input
              autoFocus
              value={searchQ}
              onChange={e => setSearchQ(e.target.value)}
              placeholder="Search this chat"
              className="h-10 w-full rounded-full border border-zinc-200 bg-zinc-50 px-4 text-[16px] outline-none"
              data-testid="talk-search-input"
            />
            <p className="mt-1 px-2 text-[11px] text-zinc-400">Searches the latest 500 messages in this chat.</p>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {matchMessages(messages, searchQ).map(m => (
              <button key={m.id} type="button" onClick={() => jumpTo(m.id)} className="block w-full border-b border-zinc-100 px-4 py-3 text-left active:bg-zinc-50" data-testid="talk-search-hit">
                <span className="flex justify-between text-xs text-zinc-400"><span>{m.sender_id === meId ? 'You' : m.sender_name}</span><span>{dayLabel(m.created_at)} · {timeLabel(m.created_at)}</span></span>
                <span className="block truncate text-[15px] text-zinc-800">{snippet(m, 120)}</span>
              </button>
            ))}
            {searchQ.trim().length >= 2 && matchMessages(messages, searchQ).length === 0 && <p className="px-4 py-8 text-center text-sm text-zinc-400">Nothing found.</p>}
          </div>
        </div>
      )}
      {meId && !searchOpen && (
        <TalkMessages
          threadId={selected.id} messages={messages} meId={meId} isSeen={isSeen} showSender={group} loading={loadingMsgs}
          highlightId={highlightId}
          onMenu={setSheetMsg}
          onReply={m => { setMode({ kind: 'reply', message: m, who: m.sender_id === meId ? 'yourself' : m.sender_name }); setSheetMsg(null) }}
          onReact={(m, emoji) => void react(m, emoji)}
          onJumpTo={jumpTo}
        />
      )}
      {!searchOpen && <TalkComposer key={selected.id} onSend={send} onEdit={edit} mode={mode} onCancelMode={() => setMode(null)} onTyping={announceTyping} />}
      {groupInfoOpen && group && meId && (
        <TalkGroupInfo
          name={name} memberIds={memberIdsNow} members={members} meId={meId} busy={groupBusy}
          onClose={() => setGroupInfoOpen(false)}
          onAdd={ids => void addToGroup(ids)}
          onRename={n => void renameThisGroup(n)}
          onLeave={() => void leaveThisGroup()}
        />
      )}
      {sheetMsg && meId && (
        <TalkMessageSheet
          message={messages.find(x => x.id === sheetMsg.id) ?? sheetMsg}
          meId={meId}
          onClose={() => setSheetMsg(null)}
          onReact={emoji => void react(sheetMsg, emoji)}
          onReply={() => { setMode({ kind: 'reply', message: sheetMsg, who: sheetMsg.sender_id === meId ? 'yourself' : sheetMsg.sender_name }); setSheetMsg(null) }}
          onCopy={() => void copyText(sheetMsg)}
          onEdit={() => { setMode({ kind: 'edit', message: sheetMsg }); setSheetMsg(null) }}
          onDelete={() => void remove(sheetMsg)}
        />
      )}
    </div>
  )
}
