'use client'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'next/navigation'
import { ChevronLeft, Loader2, Plus, Search, Users, X } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { isBeingViewed } from '@/lib/talk/window-front'
import { reportDelivered } from '@/lib/talk/report-delivered'
import { TALK_BASE } from '@/lib/talk/paths'
import { showUnreadBadge, talkSplit } from '@/lib/talk/layout'
import { isImplementationChat } from '@/lib/talk/voice-alert'
import { cn } from '@/lib/utils'
import { withOutbox } from '@/lib/talk/outbox-rules'
import { draftKey } from '@/lib/talk/drafts'
import { combineHistory, earlierCursor, EARLIER_PAGE, MAX_JUMP_PAGES, mergeEarlier } from '@/lib/talk/earlier'
import { applyUnreadIndicators, clearUnreadIndicators, previewLine, unreadTotal } from '@/lib/talk/list-preview'
import { leavingLosesRecording, SEND_BEFORE_LEAVING_TIMEOUT_MS, type RecordingControl, type VoiceOutcome } from '@/lib/talk/recording-guard'
import { useChatOutbox } from '@/components/talk/use-chat-outbox'
import { useChatActions } from '@/components/talk/use-chat-actions'
import { actionVerb, hasMyReaction, overlayActions, type ChatAction } from '@/lib/talk/outbox-actions-rules'
import {
  chatName, chatThreads, directMessages, groupMemberNames, initials, isGroupThread, matchMessages, membersWithoutChat, mergeSnapshot, messageSignature, otherUserId, parseTypingSignal, readStatus, tickState, tickStateAll, shouldAnnounceTyping, snippet, startThreadId, timeLabel, dayLabel, typingLabel, TYPING_EXPIRES_MS,
  type TalkMember, type TalkMessage, type TalkReaction, type TalkThread, type TypingKind,
} from '@/lib/talk/chat-model'
import { TalkMessages } from '@/components/talk/talk-messages'
import { TalkComposer, type TalkComposerMode, type TalkSendInput } from '@/components/talk/talk-composer'
import { TalkMessageSheet } from '@/components/talk/talk-sheet'
import { TalkVoiceSwitch, TalkVoiceWakeBar } from '@/components/talk/talk-voice'
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
export function TalkApp({ base = TALK_BASE }: { /** Where this chat lives: `/talk` (the app) or `/td-talk` (the CRM tab) — the address it keeps the open chat in. */ base?: string } = {}) {
  const searchParams = useSearchParams()
  const urlThread = searchParams.get('thread')

  const [threads, setThreads] = useState<TalkThread[]>([])
  const [members, setMembers] = useState<TalkMember[]>([])
  const [meId, setMeId] = useState<string | null>(null)
  const [booting, setBooting] = useState(true)
  const [bootError, setBootError] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [messages, setMessages] = useState<TalkMessage[]>([])
  // older pages the person asked for ("Load earlier messages"): kept apart from the live window so the 10-second refresh can never drop them
  const [older, setOlder] = useState<TalkMessage[]>([])
  const [hasMore, setHasMore] = useState(false)
  const [loadingEarlier, setLoadingEarlier] = useState(false)
  const olderRef = useRef<TalkMessage[]>([])
  const hasMoreRef = useRef(false)
  const loadingEarlierRef = useRef(false)
  const [peerReadAt, setPeerReadAt] = useState<string | null>(null)
  const [peerDeliveredAt, setPeerDeliveredAt] = useState<string | null>(null)
  const [loadingMsgs, setLoadingMsgs] = useState(false)
  const [startingWith, setStartingWith] = useState<string | null>(null)
  const [sheetMsg, setSheetMsg] = useState<TalkMessage | null>(null)
  const [mode, setMode] = useState<TalkComposerMode>(null)
  const [searchOpen, setSearchOpen] = useState(false)
  const [searchQ, setSearchQ] = useState('')
  const [highlightId, setHighlightId] = useState<string | null>(null)
  // a message link (?message=<id>): once the chat's messages are on screen, scroll to it and flash it — once
  const pendingJumpRef = useRef<string | null>(typeof window === 'undefined' ? null : new URLSearchParams(window.location.search).get('message'))
  const messagesRef = useRef<TalkMessage[]>([])
  const [peerTyping, setPeerTyping] = useState<{ userId: string; kind: TypingKind } | null>(null)
  // groups: who is in the open group, how far each member has read, and the New-group / Group-info screens
  const [groupMemberIds, setGroupMemberIds] = useState<string[]>([])
  const [memberReads, setMemberReads] = useState<Record<string, string>>({})
  const [memberDelivered, setMemberDelivered] = useState<Record<string, string>>({})
  const [newGroupOpen, setNewGroupOpen] = useState(false)
  const [groupInfoOpen, setGroupInfoOpen] = useState(false)
  const [groupBusy, setGroupBusy] = useState(false)
  const typingChannelRef = useRef<ReturnType<ReturnType<typeof createClient>['channel']> | null>(null)
  const typingSentAtRef = useRef<number | null>(null)
  // a voice note being recorded: leaving the chat (another chat, the list, search, New group) asks first instead of losing it
  const recordingRef = useRef(false)
  const recordingControl = useRef<RecordingControl | null>(null)
  const voiceDoneRef = useRef<((o: VoiceOutcome) => void) | null>(null)
  const [leaveAsk, setLeaveAsk] = useState<{ go: () => void } | null>(null)
  const [leaveBusy, setLeaveBusy] = useState(false)

  const selectedIdRef = useRef<string | null>(null)
  const meIdRef = useRef<string | null>(null)
  const threadsRef = useRef<TalkThread[]>([])
  const initialisedRef = useRef(false)
  selectedIdRef.current = selectedId
  meIdRef.current = meId
  threadsRef.current = threads
  // changes to messages already sent (edit / delete / react) are kept on the phone until the server has them; the screen lays them over the real messages
  const actionDoneRef = useRef<(a: ChatAction, result: unknown) => void>(() => {})
  const actionFailedRef = useRef<(a: ChatAction, error: string) => void>(() => {})
  const actions = useChatActions({ threadId: selectedId, userId: meId, onDone: (a, r) => actionDoneRef.current(a, r), onFailed: (a, e) => actionFailedRef.current(a, e) })
  const queueAction = actions.queue
  const meName = members.find(m => m.id === meId)?.name ?? 'You'
  const shown = useMemo(() => overlayActions(combineHistory(older, messages), actions.waiting, meId ? { id: meId, name: meName } : null), [older, messages, actions.waiting, meId, meName])
  messagesRef.current = shown
  olderRef.current = older
  hasMoreRef.current = hasMore

  const chats = useMemo(() => chatThreads(threads), [threads])
  const dms = useMemo(() => directMessages(threads), [threads])

  // the unread count on the app icon and in the tab title — the standalone app only (the CRM tab has its own red dot in the menu)
  const unreadAll = unreadTotal(chats, selectedId, isBeingViewed())
  useEffect(() => { if (base === TALK_BASE) applyUnreadIndicators(unreadAll) }, [unreadAll, base])
  useEffect(() => () => { if (base === TALK_BASE) clearUnreadIndicators() }, [base])

  const loadThreads = useCallback(async (): Promise<TalkThread[] | null> => {
    try {
      const r = await fetch('/api/team/threads')
      if (!r.ok) throw new Error('Could not load your chats.')
      const d = await r.json()
      setThreads(d.threads ?? [])
      reportDelivered(d.threads ?? []) // this device now HAS these messages: tell the sender (grey double tick)
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
      const r = await fetch(`/api/team/threads/${threadId}${isBeingViewed() ? '' : '?mark_read=0'}`)
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
      // does the chat have messages older than the live window? (once older pages are loaded, their own answer rules)
      if (olderRef.current.length === 0) setHasMore(d.has_more === true)
      setPeerReadAt(d.peer_read_at ?? null)
      setPeerDeliveredAt(d.peer_delivered_at ?? null)
      if (Array.isArray(d.members)) setGroupMemberIds(d.members as string[])
      if (Array.isArray(d.member_reads)) {
        const map: Record<string, string> = {}
        for (const r of d.member_reads as Array<{ user_id: string; last_read_at: string }>) map[r.user_id] = r.last_read_at
        setMemberReads(map)
      }
      if (Array.isArray(d.member_delivered)) {
        const dm: Record<string, string> = {}
        for (const r of d.member_delivered as Array<{ user_id: string; delivered_at: string }>) dm[r.user_id] = r.delivered_at
        setMemberDelivered(dm)
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
    setOlder([]); setHasMore(false); setLoadingEarlier(false); olderRef.current = []; hasMoreRef.current = false; loadingEarlierRef.current = false
    setPeerReadAt(null)
    setSheetMsg(null); setMode(null); setSearchOpen(false); setSearchQ(''); setHighlightId(null)
    setGroupInfoOpen(false); setNewGroupOpen(false); setGroupMemberIds([]); setMemberReads({})
    writeLastOpened(id)
    try {
      // The open chat lives in the address (?thread=…): a refresh reopens it, and the pop-up rule ("silent only for
      // the chat you are looking at") reads it.
      window.history.replaceState(null, '', id ? `${base}?thread=${id}` : base)
    } catch { /* ignore */ }
  }, [base])

  // Every way out of the open chat goes through here: with a recording in progress the person is asked first (Send it / Throw it away / Keep recording).
  const guardLeave = useCallback((go: () => void) => {
    if (leavingLosesRecording(recordingRef.current)) { setLeaveAsk({ go }); return }
    go()
  }, [])
  const requestSelect = useCallback((id: string | null) => { guardLeave(() => select(id)) }, [guardLeave, select])

  const leaveAfterSending = useCallback((go: () => void) => {
    setLeaveBusy(true)
    let done = false
    const finish = () => { if (done) return; done = true; voiceDoneRef.current = null; clearTimeout(timer); setLeaveBusy(false); setLeaveAsk(null); go() }
    const timer = setTimeout(finish, SEND_BEFORE_LEAVING_TIMEOUT_MS)
    voiceDoneRef.current = () => finish()
    if (recordingControl.current) recordingControl.current.send()
    else finish()
  }, [])
  const leaveAfterThrowingAway = useCallback((go: () => void) => {
    voiceDoneRef.current = null
    recordingControl.current?.discard()
    setLeaveAsk(null)
    go()
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
    if (chatThreads(threadsRef.current).some(t => t.id === urlThread)) { requestSelect(urlThread); return }
    void loadThreads().then(list => {
      if (list && chatThreads(list).some(t => t.id === urlThread)) requestSelect(urlThread)
    })
  }, [urlThread, loadThreads, requestSelect])

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
          if (m.sender_id !== meIdRef.current && isBeingViewed()) {
            void fetch(`/api/team/threads/${m.thread_id}/read`, { method: 'POST' }).catch(() => {})
          }
        }
        refreshList()
      })
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'internal_messages' }, payload => {
        const m = payload.new as TalkMessage & { thread_id: string }
        if (m.thread_id === selectedIdRef.current) {
          setMessages(prev => prev.map(x => x.id === m.id ? { ...x, ...m } : x))
          if (olderRef.current.some(x => x.id === m.id)) setOlder(prev => prev.map(x => x.id === m.id ? { ...x, ...m } : x))
        }
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'internal_thread_reads' }, payload => {
        const row = payload.new as { thread_id?: string; user_id?: string; last_read_at?: string } | undefined
        if (row?.thread_id === selectedIdRef.current && row.user_id && row.user_id !== meIdRef.current && row.last_read_at) {
          setPeerReadAt(row.last_read_at)
          const at = row.last_read_at
          setMemberReads(prev => ({ ...prev, [row.user_id as string]: at }))
        }
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'internal_thread_delivery' }, payload => {
        const row = payload.new as { thread_id?: string; user_id?: string; delivered_at?: string } | undefined
        if (row?.thread_id === selectedIdRef.current && row.user_id && row.user_id !== meIdRef.current && row.delivered_at) {
          const at = row.delivered_at
          setPeerDeliveredAt(at)
          setMemberDelivered(prev => ({ ...prev, [row.user_id as string]: at }))
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
    window.addEventListener('focus', onVisible) // coming back to a window that was behind another one = now it is read
    return () => {
      clearInterval(timer)
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', onVisible)
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

  // A message is kept on the phone and sent as soon as it can be (Antonio, 2 Nov 2026): the box empties at once, the message shows with a clock until the server has it.
  const outbox = useChatOutbox({
    scope: `talk:${selectedId ?? ''}`,
    target: { kind: 'talk', threadId: selectedId ?? '' },
    userId: meId,
    onSent: (message, item) => {
      if (item.target.kind !== 'talk' || selectedIdRef.current !== item.target.threadId) return
      const withPreview: TalkMessage = item.replyPreview ? { ...message, reply_to_preview: item.replyPreview } : message
      setMessages(prev => prev.some(x => x.id === message.id) ? prev : [...prev, withPreview])
    },
  })
  const enqueueOutbox = outbox.enqueue
  const send = useCallback(async ({ text, files, replyToId }: TalkSendInput): Promise<boolean> => {
    if (!selectedIdRef.current) return false
    // the server's answer has no preview of the quoted message — keep it so the quote shows at once
    const quoted = replyToId ? messagesRef.current.find(x => x.id === replyToId) : null
    const replyPreview = quoted ? { id: quoted.id, message: quoted.message, sender_name: quoted.sender_name, deleted_at: quoted.deleted_at ?? null } : null
    const ok = await enqueueOutbox({ text, files, replyToId, replyPreview })
    if (!ok) toast.error('Could not keep the message on this device. Please try again.')
    return ok
  }, [enqueueOutbox])

  // ── message actions (the long-press menu) ──
  const applyToMessage = useCallback((id: string, patch: Partial<TalkMessage>) => {
    setMessages(prev => prev.map(m => m.id === id ? { ...m, ...patch } : m))
    setOlder(prev => prev.some(m => m.id === id) ? prev.map(m => m.id === id ? { ...m, ...patch } : m) : prev)
  }, [])

  // A reaction is kept on the phone and sent as soon as it can be (Batch 3): the wish ("on" / "off") is worked out from what is drawn right now, so a reaction sent twice can never flip back.
  const react = useCallback(async (m: TalkMessage, emoji: string) => {
    setSheetMsg(null)
    const current = messagesRef.current.find(x => x.id === m.id) ?? m
    const ok = await queueAction({ kind: 'react', messageId: m.id, emoji, on: !hasMyReaction(current, emoji, meIdRef.current ?? '') })
    if (!ok) toast.error('Could not keep your reaction on this device. Please try again.')
  }, [queueAction])

  const copyText = useCallback(async (m: TalkMessage) => {
    setSheetMsg(null)
    try { await navigator.clipboard.writeText(m.message); toast.success('Copied') } catch { toast.error('Could not copy.') }
  }, [])

  // "Copy link": opens this chat at this message; a Claude session reads it with the team chat tool
  const copyLink = useCallback(async (m: TalkMessage) => {
    setSheetMsg(null)
    const url = `${window.location.origin}${base}?thread=${encodeURIComponent(selectedIdRef.current ?? '')}&message=${encodeURIComponent(m.id)}`
    try { await navigator.clipboard.writeText(url); toast.success('Link copied.') } catch { toast.error('Could not copy.') }
  }, [base])

  // Edit and delete are kept on the phone too: they show at once and reach the server as soon as the connection allows (a refusal is told to the person and the chat is reloaded).
  const edit = useCallback(async (id: string, text: string): Promise<boolean> => {
    if (!text.trim()) { toast.error('A message cannot be empty. Delete it instead.'); return false }
    const ok = await queueAction({ kind: 'edit', messageId: id, text })
    if (!ok) toast.error('Could not keep your edit on this device. Please try again.')
    return ok
  }, [queueAction])

  const remove = useCallback(async (m: TalkMessage) => {
    setSheetMsg(null)
    const ok = await queueAction({ kind: 'delete', messageId: m.id })
    if (!ok) { toast.error('Could not keep the delete on this device. Please try again.'); return }
    setMode(cur => cur && cur.message.id === m.id ? null : cur)
  }, [queueAction])

  // what the server answered for a kept change: it replaces the overlay with the real thing (only for the open chat; another chat reads the server when it is opened)
  actionDoneRef.current = (a, result) => {
    if (selectedIdRef.current !== a.threadId) return
    const d = (result ?? {}) as { reactions?: TalkReaction[]; message?: { message: string; edited_at: string | null } }
    if (a.kind === 'react' && Array.isArray(d.reactions)) applyToMessage(a.messageId, { reactions: d.reactions })
    else if (a.kind === 'edit' && d.message) applyToMessage(a.messageId, { message: d.message.message, edited_at: d.message.edited_at })
    else if (a.kind === 'delete') applyToMessage(a.messageId, { deleted_at: new Date().toISOString() })
  }
  actionFailedRef.current = (a, error) => {
    toast.error(`Could not ${actionVerb(a)}: ${error}`)
    if (selectedIdRef.current === a.threadId) void loadMessages(a.threadId, { silent: true })
  }

  // One page of OLDER messages ("Load earlier messages"). Resolves with the page that was added (an empty list when there is nothing older), or null when it failed or was not needed.
  const loadEarlier = useCallback(async (): Promise<TalkMessage[] | null> => {
    const threadId = selectedIdRef.current
    // the oldest message known right now: pages fetched a moment ago (not drawn yet) are in olderRef, so a jump that loads several pages in a row keeps moving back
    const cursor = earlierCursor([...olderRef.current, ...messagesRef.current])
    if (!threadId || !cursor || loadingEarlierRef.current) return null
    loadingEarlierRef.current = true
    setLoadingEarlier(true)
    try {
      const r = await fetch(`/api/team/threads/${threadId}?before=${encodeURIComponent(cursor)}&limit=${EARLIER_PAGE}`)
      const d = await r.json().catch(() => ({}))
      if (!r.ok) throw new Error(d.error || 'Could not load earlier messages.')
      if (selectedIdRef.current !== threadId) return null // switched chats while loading
      const page = (d.messages ?? []) as TalkMessage[]
      olderRef.current = mergeEarlier(olderRef.current, page)
      setOlder(olderRef.current)
      setHasMore(d.has_more === true)
      hasMoreRef.current = d.has_more === true
      return page
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not load earlier messages.')
      return null
    } finally {
      loadingEarlierRef.current = false
      setLoadingEarlier(false)
    }
  }, [])

  const jumpTo = useCallback(async (id: string) => {
    // a message older than what is loaded (a copied link, a quote, a search hit): load earlier pages until it turns up (up to MAX_JUMP_PAGES)
    let found = messagesRef.current.some(m => m.id === id)
    let loadedPages = 0
    for (; !found && hasMoreRef.current && loadedPages < MAX_JUMP_PAGES;) {
      const page = await loadEarlier()
      if (!page) break
      loadedPages++
      found = page.some(m => m.id === id)
    }
    if (!found) { toast('That message could not be found in this chat.'); return }
    setSearchOpen(false)
    // the message list is not on screen while searching, and older messages need a moment to draw — then scroll and flash the message
    // (a message that had to be fetched is far away: go there at once instead of gliding past thousands of messages)
    setTimeout(() => {
      document.querySelector(`[data-mid="${CSS.escape(id)}"]`)?.scrollIntoView({ block: 'center', behavior: loadedPages > 0 ? 'auto' : 'smooth' })
      setHighlightId(id)
      setTimeout(() => setHighlightId(cur => cur === id ? null : cur), 1800)
    }, 250)
  }, [loadEarlier])

  useEffect(() => {
    const id = pendingJumpRef.current
    if (!id || loadingMsgs || messages.length === 0) return
    pendingJumpRef.current = null
    // a link to an older message: the chat opens, earlier pages load until the message turns up (jumpTo says so when it cannot be found)
    void jumpTo(id)
  }, [messages, loadingMsgs, jumpTo])

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
      requestSelect(d.thread.id)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not start the chat.')
    } finally {
      setStartingWith(null)
    }
  }, [loadThreads, requestSelect])

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

  // ── People (the short list) — the whole screen on a phone, the left column on a wide screen ──
  const split = talkSplit(base, !!selected)
  const people = (
      <div className="flex h-full w-full flex-col bg-white" data-testid="talk-people">
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-zinc-200 px-4 py-3">
          <h1 className="text-lg font-semibold text-zinc-900">TD Talk</h1>
          <TalkVoiceWakeBar />
          <div className="flex items-center gap-2">
            <TalkVoiceSwitch />
            <button type="button" onClick={() => guardLeave(() => setNewGroupOpen(true))} data-testid="talk-new-group" className="flex items-center gap-1.5 rounded-full border border-zinc-200 px-3 py-1.5 text-sm font-medium text-zinc-800 active:bg-zinc-100">
              <Users className="h-4 w-4" /> New group
            </button>
          </div>
        </div>
        <div className="flex-1 overflow-y-auto">
          {chats.map(t => {
            const group = isGroupThread(t)
            const name = chatName(t, meId, members)
            const other = group ? t.id : (otherUserId(t.dm_key, meId) ?? t.id)
            return (
              <button key={t.id} type="button" onClick={() => { if (t.id !== selectedId) requestSelect(t.id) }} aria-current={t.id === selectedId ? 'true' : undefined} className={cn('flex w-full items-center gap-3 border-b border-zinc-100 px-4 py-3 text-left active:bg-zinc-50', t.id === selectedId && 'bg-zinc-100')} data-testid={group ? 'talk-group-row' : 'talk-person'}>
                <Avatar name={name} id={other} size="h-12 w-12 text-base" />
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline justify-between gap-2">
                    <span className="truncate text-[16px] font-medium text-zinc-900">{name}</span>
                    <span className="shrink-0 text-xs text-zinc-400">
                      {t.last_activity_at ? (dayLabel(t.last_activity_at) === 'Today' ? timeLabel(t.last_activity_at) : dayLabel(t.last_activity_at)) : null}
                    </span>
                  </span>
                  {(() => {
                    const line = previewLine(t, meId, members)
                    const unread = (t.unread_count ?? 0) > 0 && t.id !== selectedId
                    return (
                      <span className={cn('block truncate text-sm', unread ? 'font-semibold text-zinc-900' : 'text-zinc-500')} data-testid="talk-preview">
                        {line || (group ? `${(t.members ?? []).length} people` : ' ')}
                      </span>
                    )
                  })()}
                </span>
                {showUnreadBadge(t.unread_count, t.id === selectedId, isBeingViewed()) && (
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
  // the two columns: the list on the left, the open chat (or a note) on the right
  const columns = (right: React.ReactNode) => (
    <div className="flex h-full w-full" data-testid="talk-columns">
      <div className={split.listPane}>{people}</div>
      <div className={split.chatPane}>{right}</div>
    </div>
  )
  if (!selected) {
    return columns(<div className={cn('h-full w-full items-center justify-center bg-zinc-50 text-sm text-zinc-400', split.emptyNote)} data-testid="talk-pick-a-chat">Pick a chat on the left.</div>)
  }

  // ── The conversation ──
  const group = isGroupThread(selected)
  const name = chatName(selected, meId, members)
  const other = group ? selected.id : (otherUserId(selected.dm_key, meId) ?? selected.id)
  const memberIdsNow = group ? (groupMemberIds.length > 0 ? groupMemberIds : (selected.members ?? [])) : []
  const typingWho = group && peerTyping ? members.find(m => m.id === peerTyping.userId)?.name ?? 'Someone' : null
  // The "New implementation" chat shows under every message who has read it and who has not.
  const readByOf = group && isImplementationChat(selected.title)
    ? (m: TalkMessage) => {
        const nameOf = (id: string) => members.find(x => x.id === id)?.name ?? 'Someone'
        // the open chat is being read by me right now: my own pointer on screen can lag a poll behind a message that just arrived
        const s = readStatus(m, memberIdsNow, isBeingViewed() ? { ...memberReads, [meId]: new Date().toISOString() } : memberReads)
        return { read: s.read.map(nameOf), waiting: s.waiting.map(nameOf) }
      }
    : undefined
  const tickOf = (m: TalkMessage) => group
    ? tickStateAll(m, memberIdsNow.filter(id => id !== meId), memberReads, memberDelivered)
    : tickState(m, peerReadAt, peerDeliveredAt)
  return columns(
    <div className="flex h-full w-full min-w-0 flex-col bg-white" data-testid="talk-chat">
      <div className="flex shrink-0 items-center gap-2 border-b border-zinc-200 bg-white px-2 py-2">
        {canGoBack ? (
          <button type="button" onClick={() => requestSelect(null)} aria-label="Back to your chats" className={cn('relative flex h-10 w-10 items-center justify-center rounded-full text-zinc-700 active:bg-zinc-100', split.back)} data-testid="talk-back">
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
        <button type="button" onClick={() => guardLeave(() => { setSearchOpen(o => !o); setSearchQ('') })} aria-label="Search this chat" data-testid="talk-search-toggle" className="flex h-10 w-10 items-center justify-center rounded-full text-zinc-600 active:bg-zinc-100">
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
            <p className="mt-1 px-2 text-[11px] text-zinc-400">
              Searches the {shown.length} messages loaded in this chat.
              {hasMore && (
                <> <button type="button" onClick={() => void loadEarlier()} disabled={loadingEarlier} data-testid="talk-search-load-earlier" className="font-semibold text-[#BE1E2D] disabled:opacity-60">{loadingEarlier ? 'Loading…' : 'Load earlier messages'}</button> to search further back.</>
              )}
            </p>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto">
            {matchMessages(shown, searchQ).map(m => (
              <button key={m.id} type="button" onClick={() => jumpTo(m.id)} className="block w-full border-b border-zinc-100 px-4 py-3 text-left active:bg-zinc-50" data-testid="talk-search-hit">
                <span className="flex justify-between text-xs text-zinc-400"><span>{m.sender_id === meId ? 'You' : m.sender_name}</span><span>{dayLabel(m.created_at)} · {timeLabel(m.created_at)}</span></span>
                <span className="block truncate text-[15px] text-zinc-800">{snippet(m, 120)}</span>
              </button>
            ))}
            {searchQ.trim().length >= 2 && matchMessages(shown, searchQ).length === 0 && <p className="px-4 py-8 text-center text-sm text-zinc-400">Nothing found.</p>}
          </div>
        </div>
      )}
      {meId && !searchOpen && (
        <TalkMessages
          threadId={selected.id} messages={withOutbox(shown, outbox.waiting)} outbox={{ retry: outbox.retry, discard: outbox.discard }} earlier={{ has: hasMore, loading: loadingEarlier, load: () => void loadEarlier() }} meId={meId} tickOf={tickOf} showSender={group} loading={loadingMsgs} readByOf={readByOf}
          highlightId={highlightId}
          onMenu={setSheetMsg}
          onReply={m => { setMode({ kind: 'reply', message: m, who: m.sender_id === meId ? 'yourself' : m.sender_name }); setSheetMsg(null) }}
          onReact={(m, emoji) => void react(m, emoji)}
          onJumpTo={jumpTo}
        />
      )}
      {!searchOpen && (
        <TalkComposer
          key={selected.id} onSend={send} onEdit={edit} mode={mode} onCancelMode={() => setMode(null)} onTyping={announceTyping}
          draftKey={draftKey(meId, selected.id)}
          onRecordingChange={on => { recordingRef.current = on }}
          recordingControl={recordingControl}
          onVoiceDone={o => voiceDoneRef.current?.(o)}
        />
      )}
      {leaveAsk && (
        <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-4 sm:items-center" role="dialog" aria-modal="true" aria-label="You are recording a voice message" data-testid="talk-leave-recording">
          <div className="w-full max-w-sm rounded-2xl bg-white p-5 shadow-xl">
            <p className="text-[17px] font-semibold text-zinc-900">You are recording a voice message</p>
            <p className="mt-1 text-sm text-zinc-500">Leaving this chat now would lose it. What do you want to do?</p>
            <div className="mt-4 flex flex-col gap-2">
              <button type="button" disabled={leaveBusy} onClick={() => leaveAfterSending(leaveAsk.go)} data-testid="talk-leave-send" className="flex h-11 items-center justify-center gap-2 rounded-full bg-[#BE1E2D] text-sm font-semibold text-white active:opacity-80 disabled:opacity-60">
                {leaveBusy ? <><Loader2 className="h-4 w-4 animate-spin" /> Sending…</> : 'Send it'}
              </button>
              <button type="button" disabled={leaveBusy} onClick={() => leaveAfterThrowingAway(leaveAsk.go)} data-testid="talk-leave-discard" className="h-11 rounded-full border border-zinc-200 text-sm font-semibold text-zinc-800 active:bg-zinc-100 disabled:opacity-60">Throw it away</button>
              <button type="button" disabled={leaveBusy} onClick={() => setLeaveAsk(null)} data-testid="talk-leave-keep" className="h-11 rounded-full text-sm font-medium text-zinc-600 active:bg-zinc-100 disabled:opacity-60">Keep recording</button>
            </div>
          </div>
        </div>
      )}
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
          message={shown.find(x => x.id === sheetMsg.id) ?? sheetMsg}
          meId={meId}
          onClose={() => setSheetMsg(null)}
          onReact={emoji => void react(sheetMsg, emoji)}
          onReply={() => { setMode({ kind: 'reply', message: sheetMsg, who: sheetMsg.sender_id === meId ? 'yourself' : sheetMsg.sender_name }); setSheetMsg(null) }}
          onCopy={() => void copyText(sheetMsg)}
          onCopyLink={() => void copyLink(sheetMsg)}
          onEdit={() => { setMode({ kind: 'edit', message: sheetMsg }); setSheetMsg(null) }}
          onDelete={() => void remove(sheetMsg)}
        />
      )}
    </div>
  )
}
