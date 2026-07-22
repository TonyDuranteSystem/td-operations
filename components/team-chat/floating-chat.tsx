'use client'

/**
 * The floating green chat window — talk to a teammate from any CRM page.
 *
 * Sibling of the yellow sticky-notes layer, and deliberately NOT a second chat:
 * it is a window onto the REAL Team Workspace direct messages. Everything said
 * here is a normal team message — it appears in Team Chat, pushes to the other
 * person's phone, and is searchable later. A separate store would mean a second
 * inbox, which is the problem Team Workspace exists to solve.
 *
 * THE RULE THAT SHAPES THIS FILE: reading is a write. Fetching a thread normally
 * advances the read pointer, so a window that can appear on its own must fetch
 * with `mark_read=0` and mark read only when a human actually engages. Otherwise
 * a message that arrives while nobody is at the desk pops, clears its own badge,
 * and is never seen again — the push has already been and gone. Every fetch here
 * passes mark_read=0; `markRead()` is called from real interaction only.
 *
 * Desktop: draggable, remembers where you left it, minimizes to a pill.
 * Mobile (<lg): a pill + sheet, never a floating window and never an auto-pop —
 * at ~380px there is nowhere for one to go, and the CRM is used as a phone app.
 *
 * Placement: z-46 — one step above the notes layer so a dragged note cannot
 * cover the composer, still below the AI panel (55), command palette (60) and
 * the note dialogs (70/80) so it can never trap a modal's buttons. Anchored
 * bottom-RIGHT-of-centre: bottom-left belongs to the notes pill, the very
 * bottom-right to toasts.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import dynamic from 'next/dynamic'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import {
  MessageSquare, X, Minus, Send, Loader2, StickyNote, Paperclip,
  Volume2, VolumeX, RotateCcw, Smile, MoreHorizontal, Pencil, Trash2, Copy, Plus, Building2,
  ChevronLeft,
} from 'lucide-react'
import { AccountCombobox } from '@/components/shared/account-combobox'

// Loaded on demand: the emoji data is heavy and the window mounts on EVERY
// dashboard page. ssr:false because the picker touches window on mount.
const EmojiPicker = dynamic(() => import('emoji-picker-react'), { ssr: false })
import { createClient as createSupabaseBrowserClient } from '@/lib/supabase/client'
import { usePathname } from 'next/navigation'
import { decideAutoPop } from '@/lib/team/chat-autopop'
import {
  clampChatWindowPos, readStoredChatWindowPos, serializeChatWindowPos,
  CHAT_WINDOW_POS_KEY, CHAT_WINDOW_DEFAULT_POS, type FracPos,
} from '@/lib/team/chat-window-position'
import {
  selectableChatMembers, myDmThreads, myDmThreadIdSet, otherPartyId,
  openConversations, conversationLabel, windowUnreadCount,
  type ChatMember, type ChatThreadRow,
} from '@/lib/team/chat-window-threads'
import {
  mergeChatMessages, displayBody, isDeleted, attachmentCount, summarizeReactions,
  type ChatMessage,
} from '@/lib/team/chat-messages'
import { ChatErrorBoundary } from '@/components/team-chat/chat-error-boundary'
import { NoteComposeDialog } from '@/components/dashboard/note-quick-create'

const QUIET_KEY = 'td-floating-chat-quiet'

interface ThreadsPayload {
  threads: ChatThreadRow[]
  members: ChatMember[]
  current_user_id: string
  current_user_name: string
}

/** localStorage, wrapped — a throwing/full/blocked store must never break the chat. */
const store = {
  get(key: string): string | null {
    try { return window.localStorage.getItem(key) } catch { return null }
  },
  set(key: string, value: string) {
    try { window.localStorage.setItem(key, value) } catch { /* private mode / quota */ }
  },
}

async function fetchThreads(): Promise<ThreadsPayload> {
  const res = await fetch('/api/team/threads')
  if (!res.ok) {
    const d = await res.json().catch(() => ({}))
    throw new Error(d.error || 'Could not load your conversations.')
  }
  return res.json()
}

/** Always mark_read=0 — see the file header. */
async function fetchMessages(threadId: string): Promise<{ messages: ChatMessage[] }> {
  const res = await fetch(`/api/team/threads/${threadId}?mark_read=0`)
  if (!res.ok) {
    const d = await res.json().catch(() => ({}))
    throw new Error(d.error || 'Could not load this conversation.')
  }
  return res.json()
}

/** The account/contact this page is about, so a note made here lands on the right client. */
function subjectFromPath(pathname: string): { accountId?: string; contactId?: string } {
  const m = pathname.match(/\/(accounts|contacts)\/([0-9a-f-]{36})/i)
  if (!m) return {}
  return m[1].toLowerCase() === 'accounts' ? { accountId: m[2] } : { contactId: m[2] }
}

export default function FloatingChat() {
  return (
    <ChatErrorBoundary>
      <FloatingChatInner />
    </ChatErrorBoundary>
  )
}

function FloatingChatInner() {
  const qc = useQueryClient()
  const pathname = usePathname() ?? ''

  const { data, isError } = useQuery({
    queryKey: ['floating-chat-threads'],
    queryFn: fetchThreads,
    staleTime: 15_000,
    refetchInterval: 60_000,
  })

  const myId = data?.current_user_id ?? null
  const threads = useMemo(() => data?.threads ?? [], [data])
  const members = useMemo(() => data?.members ?? [], [data])

  const dmThreads = useMemo(() => myDmThreads(threads, myId), [threads, myId])
  const conversations = useMemo(() => openConversations(threads), [threads])
  const people = useMemo(() => selectableChatMembers(members, myId), [members, myId])
  // Counts everything the window can OPEN — DMs and live client conversations.
  const unread = useMemo(() => windowUnreadCount(threads, myId), [threads, myId])
  const nameFor = useCallback(
    (id: string | null) => (id ? members.find((m) => m.id === id)?.name ?? 'Teammate' : 'Teammate'),
    [members],
  )

  // ─── window state ───
  // Two separate things: is the window on screen, and which chat is open inside
  // it. Keeping them apart is what lets the window show a LIST of chats — with
  // none open — rather than always dropping you into the last conversation.
  const [windowOpen, setWindowOpen] = useState(false)
  const [openThreadId, setOpenThreadId] = useState<string | null>(null)
  const [minimized, setMinimized] = useState(false)
  const [sheetOpen, setSheetOpen] = useState(false)
  const [newChatOpen, setNewChatOpen] = useState(false)
  const [quiet, setQuiet] = useState(false)
  // Read after mount, never during render — reading storage while rendering
  // desyncs hydration.
  useEffect(() => { setQuiet(store.get(QUIET_KEY) === '1') }, [])
  const toggleQuiet = () => setQuiet((q) => { store.set(QUIET_KEY, q ? '0' : '1'); return !q })

  // Refs so the realtime callback never reads a stale closure.
  const openThreadIdRef = useRef<string | null>(null)
  const minimizedRef = useRef(false)
  const quietRef = useRef(false)
  const myIdRef = useRef<string | null>(null)
  const dmIdsRef = useRef<Set<string>>(new Set())
  const pathnameRef = useRef(pathname)
  useEffect(() => { openThreadIdRef.current = openThreadId }, [openThreadId])
  useEffect(() => { minimizedRef.current = minimized }, [minimized])
  useEffect(() => { quietRef.current = quiet }, [quiet])
  useEffect(() => { myIdRef.current = myId }, [myId])
  useEffect(() => { dmIdsRef.current = myDmThreadIdSet(threads, myId) }, [threads, myId])
  useEffect(() => { pathnameRef.current = pathname }, [pathname])

  // ─── messages for the open conversation ───
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [loadingMsgs, setLoadingMsgs] = useState(false)
  const [msgError, setMsgError] = useState<string | null>(null)

  const loadMessages = useCallback(async (threadId: string) => {
    setLoadingMsgs(true); setMsgError(null)
    try {
      const d = await fetchMessages(threadId)
      // Ignore a response for a conversation we have since switched away from.
      if (openThreadIdRef.current !== threadId) return
      setMessages(mergeChatMessages([], d.messages))
    } catch (e) {
      setMsgError(e instanceof Error ? e.message : 'Could not load this conversation.')
    } finally {
      setLoadingMsgs(false)
    }
  }, [])

  useEffect(() => {
    if (!openThreadId) { setMessages([]); return }
    loadMessages(openThreadId)
  }, [openThreadId, loadMessages])

  /**
   * Advance the read pointer — ONLY from real engagement (opening the composer,
   * scrolling the list, sending). Never on mount, never on poll, never while
   * minimized. Best-effort: a failure here must not break the chat, it just
   * means the badge clears a moment later.
   */
  const markRead = useCallback(async (threadId: string | null) => {
    if (!threadId || minimizedRef.current) return
    try {
      await fetch(`/api/team/threads/${threadId}/read`, { method: 'POST' })
      qc.invalidateQueries({ queryKey: ['floating-chat-threads'] })
    } catch { /* best-effort */ }
  }, [qc])

  // ─── realtime ───
  // Own channel topic. The full chat page owns 'team-workspace'; a second
  // subscriber on that topic would also re-run its unfiltered handlers.
  const refreshedForRef = useRef<Set<string>>(new Set())
  useEffect(() => {
    const supabase = createSupabaseBrowserClient()
    const channel = supabase
      .channel('floating-chat-dm')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'internal_messages' }, (payload) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const row = payload.new as any
        const threadId: string | undefined = row?.thread_id
        if (!threadId) return

        // Land it in the open conversation without a refetch.
        if (openThreadIdRef.current === threadId) {
          setMessages((prev) => mergeChatMessages(prev, [row as ChatMessage]))
        }

        const decision = decideAutoPop({
          isDesktop: window.matchMedia('(min-width: 1024px)').matches,
          quiet: quietRef.current,
          pathname: pathnameRef.current,
          senderId: row?.sender_id,
          myId: myIdRef.current,
          threadId,
          myDmThreadIds: dmIdsRef.current,
          overlayOpen: hasOverlayOpen(),
          isTyping: isUserTyping(),
          openThreadId: openThreadIdRef.current,
          minimized: minimizedRef.current,
          alreadyRefreshed: refreshedForRef.current.has(threadId),
        })

        if (decision === 'refresh') {
          // A conversation we have not learned about yet — could be its FIRST
          // message, which realtime will never replay. Fetch the list and let
          // the next event (or the user) act on it. Once per thread, so an
          // unrecognised thread cannot loop.
          refreshedForRef.current.add(threadId)
          qc.invalidateQueries({ queryKey: ['floating-chat-threads'] })
          return
        }
        if (decision === 'open') {
          setWindowOpen(true)
          setOpenThreadId(threadId)
          setMinimized(false)
        }
        // Either way the badge moves — refresh the counts.
        qc.invalidateQueries({ queryKey: ['floating-chat-threads'] })
      })
      // UPDATE matters: an edit or a soft delete must land live, or a retracted
      // message keeps its original text on screen here after it is gone on the page.
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'internal_messages' }, (payload) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const row = payload.new as any
        if (!row?.thread_id || openThreadIdRef.current !== row.thread_id) return
        setMessages((prev) => mergeChatMessages(prev, [row as ChatMessage]))
      })
      .subscribe()
    return () => { supabase.removeChannel(channel) }
  }, [qc])

  // Re-sync when the tab wakes or the network returns — realtime replays nothing,
  // so a frozen PWA needs a real backfill, not just an invalidate.
  useEffect(() => {
    const resync = () => {
      qc.invalidateQueries({ queryKey: ['floating-chat-threads'] })
      if (openThreadIdRef.current) loadMessages(openThreadIdRef.current)
    }
    const onVis = () => { if (document.visibilityState === 'visible') resync() }
    document.addEventListener('visibilitychange', onVis)
    window.addEventListener('online', resync)
    return () => {
      document.removeEventListener('visibilitychange', onVis)
      window.removeEventListener('online', resync)
    }
  }, [qc, loadMessages])

  // (Opening a DM by person now lives in NewChatDialog — the one place a chat
  // is started, so the "client → conversation / nobody → direct message" rule
  // exists once rather than in two drifting copies.)

  if (isError) return null // never block the CRM on a chat failure

  // The open thread can now be either a DM or a client conversation.
  const openThread = threads.find((t) => t.id === openThreadId) ?? null
  const openTitle = openThread?.thread_type === 'dm'
    ? nameFor(otherPartyId(openThread.dm_key, myId))
    : conversationLabel(openThread)
  // The window is redundant on the full chat page, and two panes fighting over
  // one read pointer is how unread state gets corrupted.
  const onChatPage = pathname === '/team-chat' || pathname.startsWith('/team-chat/')
  if (onChatPage) return null

  return (
    <>
      {/* DESKTOP window */}
      {windowOpen && !minimized && (
        <DesktopWindow
          title={openThread ? openTitle : 'Chats'}
          isList={!openThreadId}
          dmThreads={dmThreads}
          conversations={conversations}
          myId={myId}
          nameFor={nameFor}
          openThreadId={openThreadId}
          openThread={openThread}
          messages={messages}
          loading={loadingMsgs}
          error={msgError}
          quiet={quiet}
          pathname={pathname}
          onToggleQuiet={toggleQuiet}
          onPickThread={(id) => { setOpenThreadId(id); setMinimized(false) }}
          onBack={() => setOpenThreadId(null)}
          onNewChat={() => setNewChatOpen(true)}
          onMinimize={() => setMinimized(true)}
          onClose={() => { setWindowOpen(false); setOpenThreadId(null); setMinimized(false) }}
          onEngage={() => markRead(openThreadId)}
          onChanged={() => { if (openThreadIdRef.current) loadMessages(openThreadIdRef.current) }}
          onSent={(m) => { setMessages((prev) => mergeChatMessages(prev, [m])); markRead(openThreadId) }}
          onError={setMsgError}
        />
      )}

      {/* Launcher — desktop when closed/minimized, and always on mobile */}
      {(!windowOpen || minimized) && (
        <button
          onClick={() => {
            if (window.matchMedia('(min-width: 1024px)').matches) {
              setWindowOpen(true)
              setMinimized(false)
            } else {
              setSheetOpen(true)
            }
          }}
          /* Bigger than a notification pill on purpose. The first cut was a
             small pill and Antonio could not find it at all ("I don't see
             anything anywhere to activate a message") — it read as another
             status chip rather than a control. Now: a 56px circular button with
             a ring, the standard chat-launcher shape people already look for in
             a bottom corner, with the unread count as a badge rather than as the
             label (a bare number in a pill looked like a counter, not a door).

             DELIBERATE TRADE-OFF, do not "fix" silently: the sticky-notes layer
             documents that the toast stack owns bottom-right, which is why the
             notes pill went bottom-LEFT. This button takes bottom-right anyway,
             because that is where every user on earth looks for a chat launcher
             and discoverability was the actual reported failure. Toasts are
             transient and will briefly cover it; the button is permanent. If
             that overlap turns out to be annoying in daily use, move it UP
             (bottom-24) rather than back into a corner nobody checks. */
          className="group fixed bottom-5 right-5 z-[46] flex h-14 w-14 items-center justify-center rounded-full bg-emerald-500 text-white shadow-xl ring-4 ring-emerald-500/20 transition-transform hover:scale-105 hover:bg-emerald-400 lg:bottom-6 lg:right-6"
          aria-label={unread > 0 ? `Team chat, ${unread} unread messages` : 'Team chat'}
          title="Team chat"
        >
          <MessageSquare className="h-6 w-6" />
          {unread > 0 && (
            <span className="absolute -right-0.5 -top-0.5 flex h-6 min-w-6 items-center justify-center rounded-full border-2 border-white bg-red-500 px-1 text-xs font-bold">
              {unread > 9 ? '9+' : unread}
            </span>
          )}
        </button>
      )}

      {/* MOBILE sheet */}
      {sheetOpen && (
        <MobileSheet
          dmThreads={dmThreads}
          conversations={conversations}
          myId={myId}
          nameFor={nameFor}
          openThreadId={openThreadId}
          openThread={openThread}
          title={openThread ? openTitle : 'Chats'}
          messages={messages}
          loading={loadingMsgs}
          error={msgError}
          pathname={pathname}
          onPickThread={(id) => { setOpenThreadId(id); setMinimized(false) }}
          onBack={() => setOpenThreadId(null)}
          onNewChat={() => setNewChatOpen(true)}
          onEngage={() => markRead(openThreadIdRef.current)}
          onChanged={() => { if (openThreadIdRef.current) loadMessages(openThreadIdRef.current) }}
          onSent={(m) => { setMessages((prev) => mergeChatMessages(prev, [m])); markRead(openThreadIdRef.current) }}
          onError={setMsgError}
          onClose={() => setSheetOpen(false)}
        />
      )}

      {newChatOpen && (
        <NewChatDialog
          people={people}
          onOpenThread={(id) => {
            setOpenThreadId(id)
            setWindowOpen(true)
            setMinimized(false)
            qc.invalidateQueries({ queryKey: ['floating-chat-threads'] })
          }}
          onClose={() => setNewChatOpen(false)}
        />
      )}
    </>
  )
}

/* ─────────────────────────── desktop draggable window ─────────────────────────── */

function DesktopWindow(props: {
  title: string
  isList: boolean
  dmThreads: ChatThreadRow[]
  conversations: ChatThreadRow[]
  nameFor: (id: string | null) => string
  openThreadId: string | null
  openThread: ChatThreadRow | null
  messages: ChatMessage[]
  loading: boolean
  error: string | null
  myId: string | null
  quiet: boolean
  pathname: string
  onToggleQuiet: () => void
  onPickThread: (id: string) => void
  onBack: () => void
  onNewChat: () => void
  onMinimize: () => void
  onClose: () => void
  onEngage: () => void
  onChanged: () => void
  onSent: (m: ChatMessage) => void
  onError: (e: string | null) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<FracPos>(CHAT_WINDOW_DEFAULT_POS)
  const drag = useRef<{ dx: number; dy: number } | null>(null)

  // Read the stored position after mount, then clamp against the MEASURED box.
  useEffect(() => {
    const stored = readStoredChatWindowPos(store.get(CHAT_WINDOW_POS_KEY))
    const box = ref.current?.getBoundingClientRect()
    setPos(clampChatWindowPos(stored, {
      vw: window.innerWidth, vh: window.innerHeight, w: box?.width, h: box?.height,
    }))
  }, [])

  // Keep it on screen when the viewport changes under it.
  useEffect(() => {
    const onResize = () => {
      const box = ref.current?.getBoundingClientRect()
      setPos((p) => clampChatWindowPos(p, {
        vw: window.innerWidth, vh: window.innerHeight, w: box?.width, h: box?.height,
      }))
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])

  const onPointerDown = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest('[data-no-drag]')) return
    const rect = ref.current!.getBoundingClientRect()
    drag.current = { dx: e.clientX - rect.left, dy: e.clientY - rect.top }
    ref.current!.setPointerCapture(e.pointerId)
  }
  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag.current) return
    const box = ref.current?.getBoundingClientRect()
    setPos(clampChatWindowPos(
      { x: (e.clientX - drag.current.dx) / window.innerWidth, y: (e.clientY - drag.current.dy) / window.innerHeight },
      { vw: window.innerWidth, vh: window.innerHeight, w: box?.width, h: box?.height },
    ))
  }
  const onPointerUp = () => {
    if (drag.current) { store.set(CHAT_WINDOW_POS_KEY, serializeChatWindowPos(pos)); drag.current = null }
  }
  const resetPos = () => {
    setPos(CHAT_WINDOW_DEFAULT_POS)
    store.set(CHAT_WINDOW_POS_KEY, serializeChatWindowPos(CHAT_WINDOW_DEFAULT_POS))
  }

  return (
    <div
      ref={ref}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      style={{ left: `${pos.x * 100}vw`, top: `${pos.y * 100}vh` }}
      className="hidden lg:flex fixed z-[46] w-[360px] max-h-[70vh] cursor-grab active:cursor-grabbing flex-col overflow-hidden rounded-lg border border-emerald-300 bg-white shadow-2xl"
    >
      {/* Header — WHO or WHAT you are in is ALWAYS visible. This is a shared,
          pushed-to-someone's-phone surface sitting beside private post-its;
          neither "who am I talking to" nor "which chat is this" may be a guess. */}
      <div className="flex items-center gap-2 bg-emerald-500 px-3 py-2 text-white">
        {props.isList ? (
          <MessageSquare className="h-4 w-4 shrink-0" />
        ) : (
          <button data-no-drag onClick={props.onBack} className="rounded p-0.5 hover:bg-white/20" title="All chats">
            <ChevronLeft className="h-4 w-4" />
          </button>
        )}
        <span className="truncate text-sm font-semibold">{props.title}</span>
        <span className="ml-auto flex items-center gap-1">
          {props.isList && (
            <button data-no-drag onClick={props.onNewChat} className="rounded p-1 hover:bg-white/20" title="New chat">
              <Plus className="h-4 w-4" />
            </button>
          )}
          <button data-no-drag onClick={props.onToggleQuiet} className="rounded p-1 hover:bg-white/20"
            title={props.quiet ? 'Pop-ups off — turn on' : 'Pop-ups on — turn off'}>
            {props.quiet ? <VolumeX className="h-3.5 w-3.5" /> : <Volume2 className="h-3.5 w-3.5" />}
          </button>
          <button data-no-drag onClick={resetPos} className="rounded p-1 hover:bg-white/20" title="Reset position">
            <RotateCcw className="h-3.5 w-3.5" />
          </button>
          <button data-no-drag onClick={props.onMinimize} className="rounded p-1 hover:bg-white/20" title="Minimize">
            <Minus className="h-4 w-4" />
          </button>
          <button data-no-drag onClick={props.onClose} className="rounded p-1 hover:bg-white/20" title="Close">
            <X className="h-4 w-4" />
          </button>
        </span>
      </div>

      {props.isList || !props.openThreadId ? (
        <ChatList
          dmThreads={props.dmThreads}
          conversations={props.conversations}
          myId={props.myId}
          nameFor={props.nameFor}
          onPick={props.onPickThread}
          onNewChat={props.onNewChat}
        />
      ) : (
        <>
          <MessageList
            messages={props.messages}
            loading={props.loading}
            error={props.error}
            myId={props.myId}
            pathname={props.pathname}
            onEngage={props.onEngage}
            onChanged={props.onChanged}
            onError={props.onError}
            clientAccountId={props.openThread?.account_id}
            clientContactId={props.openThread?.contact_id}
          />
          <Composer
            threadId={props.openThreadId}
            personKey={props.openThreadId}
            onEngage={props.onEngage}
            onSent={props.onSent}
            onError={props.onError}
          />
        </>
      )}
    </div>
  )
}

/* ─────────────────────────── new chat ─────────────────────────── */

/**
 * "New chat" — Antonio's model, exactly.
 *
 *   pick a client  → it goes under that client's conversation in Team Workspace
 *   pick nobody    → it is a direct message to a teammate
 *
 * Nothing new is invented. A client chat IS the client conversation that already
 * exists: the server reuses an open one for the same client and subject rather
 * than forking a duplicate, and a brand-new one already records who started it
 * and when. That is why this feature avoided every problem the reviewers found
 * with nesting chats inside a direct message — each chat here is a real,
 * top-level conversation that Team Workspace already knows how to show.
 */
function NewChatDialog(props: {
  people: ChatMember[]
  onOpenThread: (id: string) => void
  onClose: () => void
}) {
  const [accountId, setAccountId] = useState<string | undefined>()
  const [accountName, setAccountName] = useState<string | undefined>()
  const [subject, setSubject] = useState('')
  const [personId, setPersonId] = useState<string>(props.people[0]?.id ?? '')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  const start = async () => {
    setBusy(true); setErr(null)
    try {
      if (accountId) {
        // Client chat → the existing client-conversation endpoint.
        const res = await fetch('/api/team/conversations', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ client: `account:${accountId}`, topic: subject.trim() || undefined }),
        })
        if (!res.ok) {
          const d = await res.json().catch(() => ({}))
          throw new Error(d.error || 'Could not start that chat.')
        }
        const d = await res.json()
        props.onOpenThread(d.thread.id)
      } else {
        // No client → a direct message.
        if (!personId) throw new Error('Pick a teammate or a client.')
        const res = await fetch('/api/team/dms', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ user_id: personId }),
        })
        if (!res.ok) {
          const d = await res.json().catch(() => ({}))
          throw new Error(d.error || 'Could not open that conversation.')
        }
        const d = await res.json()
        props.onOpenThread(d.thread.id)
      }
      props.onClose()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Could not start that chat.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-[75] flex items-end justify-center bg-black/30 sm:items-center sm:p-4" onClick={props.onClose}>
      <div className="w-full rounded-t-xl bg-white p-4 shadow-2xl sm:max-w-sm sm:rounded-xl" onClick={(e) => e.stopPropagation()}>
        <div className="mb-3 flex items-center justify-between">
          <span className="text-sm font-semibold">New chat</span>
          <button onClick={props.onClose} className="rounded p-1 hover:bg-zinc-100"><X className="h-4 w-4" /></button>
        </div>

        <label className="mb-1 block text-xs font-medium text-zinc-600">About a client (optional)</label>
        <AccountCombobox
          value={accountId}
          displayValue={accountName}
          onChange={(id, name) => { setAccountId(id); setAccountName(name) }}
          placeholder="Search company or person…"
        />

        {accountId ? (
          <>
            <label className="mb-1 mt-3 block text-xs font-medium text-zinc-600">What about? (optional)</label>
            <input
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="e.g. EIN re-send"
              maxLength={120}
              className="w-full rounded border border-zinc-300 px-2 py-1.5 text-sm outline-none focus:border-emerald-500"
            />
            <p className="mt-1 text-[11px] text-zinc-500">
              Goes under this client in Team Workspace. If a chat on the same subject is already
              open, you&apos;ll land in it rather than starting a duplicate.
            </p>
          </>
        ) : (
          <>
            <label className="mb-1 mt-3 block text-xs font-medium text-zinc-600">Or message a teammate</label>
            <select
              value={personId}
              onChange={(e) => setPersonId(e.target.value)}
              className="w-full rounded border border-zinc-300 px-2 py-1.5 text-sm outline-none focus:border-emerald-500"
            >
              {props.people.length === 0 && <option value="">No teammates available</option>}
              {props.people.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          </>
        )}

        {err && <p className="mt-2 text-xs text-red-700">{err}</p>}

        <div className="mt-4 flex justify-end gap-2">
          <button onClick={props.onClose} className="rounded px-3 py-1.5 text-sm hover:bg-zinc-100">Cancel</button>
          <button onClick={start} disabled={busy || (!accountId && !personId)}
            className="flex items-center gap-1 rounded bg-emerald-500 px-3 py-1.5 text-sm font-medium text-white hover:bg-emerald-400 disabled:opacity-40">
            {busy && <Loader2 className="h-4 w-4 animate-spin" />} Start
          </button>
        </div>
      </div>
    </div>
  )
}

/* ─────────────────────────── the chat list ─────────────────────────── */

/**
 * Every chat the window can open: the direct line to a teammate, and the live
 * client conversations.
 *
 * Antonio's model, in his words: "if it's something between me and Luca, it
 * stays between me and Luca — if I'm opening a chat for a client, it goes under
 * the conversation for that client." So the two are listed separately and
 * labelled, rather than merged into one stream.
 */
function ChatList(props: {
  dmThreads: ChatThreadRow[]
  conversations: ChatThreadRow[]
  myId: string | null
  nameFor: (id: string | null) => string
  onPick: (id: string) => void
  onNewChat: () => void
}) {
  const Row = ({ t, label, icon }: { t: ChatThreadRow; label: string; icon: React.ReactNode }) => {
    const unread = Number(t.unread_count) || 0
    return (
      <button
        onClick={() => props.onPick(t.id)}
        className="flex w-full items-center gap-2 rounded px-2 py-2.5 text-left text-sm hover:bg-zinc-100"
      >
        <span className="shrink-0 text-zinc-400">{icon}</span>
        <span className={`flex-1 truncate ${unread > 0 ? 'font-semibold' : ''}`}>{label}</span>
        {unread > 0 && (
          <span className="shrink-0 rounded-full bg-emerald-500 px-2 py-0.5 text-xs text-white">{unread}</span>
        )}
      </button>
    )
  }

  return (
    <div data-no-drag className="flex-1 overflow-y-auto p-2">
      {props.dmThreads.map((t) => (
        <Row key={t.id} t={t}
          label={props.nameFor(otherPartyId(t.dm_key, props.myId))}
          icon={<MessageSquare className="h-4 w-4" />} />
      ))}

      {props.conversations.length > 0 && (
        <p className="px-2 pb-1 pt-3 text-[11px] font-semibold uppercase tracking-wide text-zinc-400">
          Clients
        </p>
      )}
      {props.conversations.map((t) => (
        <Row key={t.id} t={t} label={conversationLabel(t)} icon={<Building2 className="h-4 w-4" />} />
      ))}

      {props.dmThreads.length === 0 && props.conversations.length === 0 && (
        <p className="py-6 text-center text-sm text-zinc-500">No chats yet.</p>
      )}

      <button
        onClick={props.onNewChat}
        className="mt-2 flex w-full items-center justify-center gap-1 rounded border border-dashed border-zinc-300 px-2 py-2 text-sm text-zinc-500 hover:border-emerald-400 hover:text-emerald-600"
      >
        <Plus className="h-4 w-4" /> New chat
      </button>
    </div>
  )
}

/* ─────────────────────────── shared message list ─────────────────────────── */

function MessageList(props: {
  messages: ChatMessage[]
  loading: boolean
  error: string | null
  myId: string | null
  pathname: string
  onEngage: () => void
  onChanged: () => void
  onError: (e: string | null) => void
  /** The client this conversation is about, if any — a note made here inherits it. */
  clientAccountId?: string | null
  clientContactId?: string | null
}) {
  const endRef = useRef<HTMLDivElement>(null)
  const [noteFor, setNoteFor] = useState<ChatMessage | null>(null)
  // One menu open at a time: per-row state meant one row's full-screen dismiss
  // layer swallowed the tap meant for another row.
  const [menuFor, setMenuFor] = useState<string | null>(null)
  const fromPage = subjectFromPath(props.pathname)
  // A conversation's OWN client wins over whatever page you happen to be on —
  // the thread is the stronger signal. Falls back to the page for a plain DM.
  const subject = props.clientAccountId
    ? { accountId: props.clientAccountId }
    : props.clientContactId
      ? { contactId: props.clientContactId }
      : fromPage

  useEffect(() => { endRef.current?.scrollIntoView({ block: 'end' }) }, [props.messages.length])

  return (
    <div
      data-no-drag
      onScroll={props.onEngage}
      className="flex-1 overflow-y-auto bg-zinc-50 p-2"
    >
      {props.loading && props.messages.length === 0 && (
        <p className="py-6 text-center text-sm text-zinc-500">
          <Loader2 className="mx-auto h-4 w-4 animate-spin" />
        </p>
      )}
      {props.error && <p className="px-2 py-1 text-xs text-red-700">{props.error}</p>}
      {!props.loading && props.messages.length === 0 && !props.error && (
        <p className="py-6 text-center text-sm text-zinc-500">No messages yet.</p>
      )}

      <div className="flex flex-col gap-1.5">
        {props.messages.map((m) => {
          const mine = !!props.myId && m.sender_id === props.myId
          const gone = isDeleted(m)
          const files = attachmentCount(m)
          return (
            <div key={m.id} className={`group flex ${mine ? 'justify-end' : 'justify-start'}`}>
              <div className={`max-w-[85%] rounded-lg px-2.5 py-1.5 text-sm ${
                gone ? 'bg-zinc-200 italic text-zinc-500'
                     : mine ? 'bg-emerald-500 text-white' : 'bg-white text-zinc-900 shadow-sm'
              }`}>
                {!mine && !gone && (
                  <p className="mb-0.5 text-[11px] font-medium opacity-70">{m.sender_name}</p>
                )}
                {/* break-words: the server allows 5000 characters, and a single
                    long URL would otherwise blow the window's width open. */}
                <p className="whitespace-pre-wrap break-words">{displayBody(m)}</p>
                {files > 0 && !gone && (
                  <p className="mt-1 flex items-center gap-1 text-[11px] opacity-80">
                    <Paperclip className="h-3 w-3" />
                    {files} file{files === 1 ? '' : 's'} — open in Team Chat
                  </p>
                )}
                {!gone && summarizeReactions(m).length > 0 && (
                  <div className="mt-1 flex flex-wrap gap-1">
                    {summarizeReactions(m).map((r) => (
                      <span key={r.emoji}
                        title={r.names.join(', ')}
                        className={`rounded-full px-1.5 py-0.5 text-[11px] ${mine ? 'bg-white/20' : 'bg-zinc-100'}`}>
                        {r.emoji}{r.count > 1 ? ` ${r.count}` : ''}
                      </span>
                    ))}
                  </div>
                )}
              </div>
              {!gone && (
                <MessageMenu
                  message={m}
                  isMine={mine}
                  open={menuFor === m.id}
                  onToggle={() => setMenuFor(menuFor === m.id ? null : m.id)}
                  onNote={() => { setNoteFor(m); setMenuFor(null) }}
                  onChanged={props.onChanged}
                  onError={props.onError}
                />
              )}
            </div>
          )
        })}
        <div ref={endRef} />
      </div>

      {noteFor && (
        <NoteComposeDialog
          accountId={subject.accountId}
          contactId={subject.contactId}
          prefill={`${(noteFor.sender_name ?? 'Someone')}: ${displayBody(noteFor)}`}
          onClose={() => setNoteFor(null)}
        />
      )}
    </div>
  )
}

/* ─────────────────────────── per-message ⋯ menu ─────────────────────────── */

/** Quick reactions, matching the set the full Team Chat page offers. */
const QUICK_REACTIONS = ['👍', '✅', '🙏', '🔥', '👀', '❤️', '😂', '🎉']

/**
 * The ⋯ menu Antonio asked for: react, copy, and — on your own messages —
 * edit and delete, plus "make a note" on anything.
 *
 * Always visible rather than hover-only: the CRM is used as a ~380px phone app
 * and there is no hover on touch, which is the exact bug the full chat page had
 * to fix. Delete asks first, because a mis-tap on a phone is cheap and a deleted
 * message is not.
 */
function MessageMenu(props: {
  message: ChatMessage
  isMine: boolean
  open: boolean
  onToggle: () => void
  onNote: () => void
  onChanged: () => void
  onError: (e: string | null) => void
}) {
  const [busy, setBusy] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')

  const call = async (url: string, init: RequestInit) => {
    setBusy(true); props.onError(null)
    try {
      const res = await fetch(url, init)
      if (!res.ok) {
        // R099 — surface what the server actually said.
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || 'That didn\'t work — try again.')
      }
      props.onChanged()
      props.onToggle()
    } catch (e) {
      props.onError(e instanceof Error ? e.message : 'That didn\'t work — try again.')
    } finally {
      setBusy(false)
    }
  }

  const react = (emoji: string) => call(`/api/team/messages/${props.message.id}/react`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ emoji }),
  })
  const saveEdit = () => {
    const body = draft.trim()
    if (!body) return
    call(`/api/team/messages/${props.message.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: body }),
    })
    setEditing(false)
  }
  const remove = () => call(`/api/team/messages/${props.message.id}`, { method: 'DELETE' })
  const copy = async () => {
    try { await navigator.clipboard.writeText(displayBody(props.message)) } catch { /* denied */ }
    props.onToggle()
  }

  return (
    <div className="relative self-center">
      <button
        onClick={props.onToggle}
        aria-label="Message actions"
        className="ml-1 rounded p-1 text-zinc-400 hover:bg-zinc-200 hover:text-zinc-700"
      >
        <MoreHorizontal className="h-4 w-4" />
      </button>

      {props.open && (
        <>
          <div className="fixed inset-0 z-[47]" onClick={props.onToggle} />
          <div className="absolute right-0 top-full z-[48] mt-1 w-52 rounded-lg border bg-white py-1 shadow-xl">
            <div className="flex justify-between px-2 py-1.5">
              {QUICK_REACTIONS.map((e) => (
                <button key={e} onClick={() => react(e)} disabled={busy}
                  className="rounded p-0.5 text-base transition-transform hover:scale-125">{e}</button>
              ))}
            </div>
            <div className="my-1 border-t" />

            {editing ? (
              <div className="px-2 py-1">
                <textarea
                  autoFocus value={draft} onChange={(e) => setDraft(e.target.value)}
                  rows={3} maxLength={5000}
                  className="w-full resize-none rounded border px-2 py-1 text-sm outline-none focus:border-emerald-500"
                />
                <div className="mt-1 flex justify-end gap-1">
                  <button onClick={() => setEditing(false)} className="rounded px-2 py-1 text-xs hover:bg-zinc-100">Cancel</button>
                  <button onClick={saveEdit} disabled={busy || !draft.trim()}
                    className="rounded bg-emerald-500 px-2 py-1 text-xs font-medium text-white disabled:opacity-40">Save</button>
                </div>
              </div>
            ) : (
              <>
                <MenuRow icon={<StickyNote className="h-4 w-4" />} label="Make a note" onClick={props.onNote} />
                <MenuRow icon={<Copy className="h-4 w-4" />} label="Copy text" onClick={copy} />
                {props.isMine && (
                  <MenuRow icon={<Pencil className="h-4 w-4" />} label="Edit"
                    onClick={() => { setDraft(props.message.message ?? ''); setEditing(true) }} />
                )}
                {props.isMine && (
                  confirmDelete ? (
                    <MenuRow icon={<Trash2 className="h-4 w-4" />} label="Tap again to delete"
                      danger onClick={remove} />
                  ) : (
                    <MenuRow icon={<Trash2 className="h-4 w-4" />} label="Delete"
                      danger onClick={() => setConfirmDelete(true)} />
                  )
                )}
              </>
            )}
          </div>
        </>
      )}
    </div>
  )
}

function MenuRow({ icon, label, onClick, danger }: {
  icon: React.ReactNode; label: string; onClick: () => void; danger?: boolean
}) {
  return (
    <button
      onClick={onClick}
      className={`flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-zinc-100 ${danger ? 'text-red-600' : 'text-zinc-700'}`}
    >
      {icon}{label}
    </button>
  )
}

/* ─────────────────────────── composer ─────────────────────────── */

/**
 * Text and send only. Attachments, voice, editing, slash-commands and threads
 * deliberately stay on the full Team Chat page: that composer is welded to a
 * dozen pieces of page state, and reproducing it here to serve a window that
 * needs a fraction of it would mean two versions drifting apart. A documented
 * subset is not drift.
 *
 * Drafts are kept PER CONVERSATION. The window changes subject on its own when
 * a message arrives, and losing what you had typed because someone else wrote
 * to you would be the worst kind of small betrayal.
 */
const drafts = new Map<string, string>()

function Composer(props: {
  threadId: string
  personKey: string
  onEngage: () => void
  onSent: (m: ChatMessage) => void
  onError: (e: string | null) => void
}) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [emojiOpen, setEmojiOpen] = useState(false)
  const boxRef = useRef<HTMLTextAreaElement>(null)

  // Swap the draft when the conversation changes.
  useEffect(() => { setText(drafts.get(props.personKey) ?? '') }, [props.personKey])
  useEffect(() => {
    if (text) drafts.set(props.personKey, text)
    else drafts.delete(props.personKey)
  }, [text, props.personKey])

  /**
   * Grow with the text instead of staying one line.
   *
   * Antonio: "the place where we write the text is fixed, so it's too short.
   * It's not flexible, and it's not dynamic." Height is reset to auto BEFORE
   * reading scrollHeight — without that reset the box can only ever grow, never
   * shrink back when you delete a paragraph. Capped so a long message scrolls
   * inside the composer rather than eating the whole window.
   */
  useEffect(() => {
    const el = boxRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`
  }, [text])

  const insertEmoji = (emoji: string) => {
    const el = boxRef.current
    if (!el) { setText((t) => t + emoji); return }
    // Insert at the caret, not blindly at the end — appending to the end is the
    // classic emoji-picker annoyance when you are editing mid-sentence.
    const start = el.selectionStart ?? text.length
    const end = el.selectionEnd ?? text.length
    setText(text.slice(0, start) + emoji + text.slice(end))
    requestAnimationFrame(() => {
      el.focus()
      const pos = start + emoji.length
      el.setSelectionRange(pos, pos)
    })
  }

  const send = async () => {
    const body = text.trim()
    if (!body || busy) return
    setBusy(true); props.onError(null)
    try {
      const res = await fetch(`/api/team/threads/${props.threadId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: body }),
      })
      if (!res.ok) {
        // R099: surface what the server actually said, never a blanket failure.
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || 'Could not send — try again.')
      }
      const d = await res.json()
      setText('') // only clear once it is genuinely gone
      drafts.delete(props.personKey)
      if (d.message) props.onSent(d.message)
    } catch (e) {
      // Keep what was typed — it is still in the box to retry or copy out.
      props.onError(e instanceof Error ? e.message : 'Could not send — your message is still here.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div data-no-drag className="relative border-t bg-white p-2">
      {emojiOpen && (
        <>
          {/* Dismiss layer — there is no hover-out on touch, so the picker needs
              an explicit way to close or it traps the screen. */}
          <div className="fixed inset-0 z-[47]" onClick={() => setEmojiOpen(false)} />
          <div className="absolute bottom-full left-2 z-[48] mb-1">
            <EmojiPicker
              onEmojiClick={(e: { emoji: string }) => { insertEmoji(e.emoji); setEmojiOpen(false) }}
              width={300}
              height={360}
              lazyLoadEmojis
            />
          </div>
        </>
      )}
      <div className="flex items-end gap-1">
        <button
          onClick={() => setEmojiOpen((o) => !o)}
          className="flex h-[38px] w-[30px] shrink-0 items-center justify-center rounded text-zinc-400 hover:bg-zinc-100 hover:text-zinc-600"
          aria-label="Emoji"
          title="Emoji"
        >
          <Smile className="h-4 w-4" />
        </button>
        <textarea
          ref={boxRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onFocus={props.onEngage}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() }
          }}
          rows={1}
          maxLength={5000}
          placeholder="Write a message…"
          className="min-h-[38px] flex-1 resize-none overflow-y-auto rounded border border-zinc-300 px-2 py-2 text-sm outline-none focus:border-emerald-500"
        />
        <button
          onClick={send}
          disabled={busy || !text.trim()}
          className="flex h-[38px] w-[38px] shrink-0 items-center justify-center rounded bg-emerald-500 text-white hover:bg-emerald-400 disabled:opacity-40"
          aria-label="Send"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
        </button>
      </div>
    </div>
  )
}

/* ─────────────────────────── mobile sheet ─────────────────────────── */

function MobileSheet(props: {
  dmThreads: ChatThreadRow[]
  conversations: ChatThreadRow[]
  myId: string | null
  nameFor: (id: string | null) => string
  openThreadId: string | null
  openThread: ChatThreadRow | null
  title: string
  messages: ChatMessage[]
  loading: boolean
  error: string | null
  pathname: string
  onPickThread: (id: string) => void
  onBack: () => void
  onNewChat: () => void
  onEngage: () => void
  onChanged: () => void
  onSent: (m: ChatMessage) => void
  onError: (e: string | null) => void
  onClose: () => void
}) {
  return (
    <div className="lg:hidden fixed inset-0 z-[47] flex flex-col justify-end bg-black/30" onClick={props.onClose}>
      <div className="flex max-h-[85vh] flex-col rounded-t-xl bg-white" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 rounded-t-xl bg-emerald-500 px-3 py-2 text-white">
          {props.openThreadId ? (
            <button onClick={props.onBack} className="rounded p-0.5 hover:bg-white/20" aria-label="All chats">
              <ChevronLeft className="h-4 w-4" />
            </button>
          ) : (
            <MessageSquare className="h-4 w-4" />
          )}
          <span className="truncate text-sm font-semibold">{props.title}</span>
          <span className="ml-auto flex items-center gap-1">
            {!props.openThreadId && (
              <button onClick={props.onNewChat} className="rounded p-1 hover:bg-white/20" aria-label="New chat">
                <Plus className="h-4 w-4" />
              </button>
            )}
            <button onClick={props.onClose} className="rounded p-1 hover:bg-white/20" aria-label="Close">
              <X className="h-4 w-4" />
            </button>
          </span>
        </div>

        {!props.openThreadId ? (
          <ChatList
            dmThreads={props.dmThreads}
            conversations={props.conversations}
            myId={props.myId}
            nameFor={props.nameFor}
            onPick={props.onPickThread}
            onNewChat={props.onNewChat}
          />
        ) : (
          <>
            <MessageList
              messages={props.messages}
              loading={props.loading}
              error={props.error}
              myId={props.myId}
              pathname={props.pathname}
              onEngage={props.onEngage}
              onChanged={props.onChanged}
              onError={props.onError}
              clientAccountId={props.openThread?.account_id}
              clientContactId={props.openThread?.contact_id}
            />
            <Composer
              threadId={props.openThreadId}
              personKey={props.openThreadId}
              onEngage={props.onEngage}
              onSent={props.onSent}
              onError={props.onError}
            />
          </>
        )}
      </div>
    </div>
  )
}

/* ─────────────────────────── interruption guards ─────────────────────────── */

/**
 * Is a modal/drawer currently up? There is no global "modal open" signal in this
 * app — every dialog is local state plus a fixed overlay — so we look for one.
 * Popping a window over a half-filled form steals focus; popping it under one is
 * invisible while still counting as delivered. Both lose the message.
 */
function hasOverlayOpen(): boolean {
  if (typeof document === 'undefined') return false
  return !!document.querySelector('[role="dialog"], [data-overlay-open="true"], .fixed.inset-0.z-\\[70\\], .fixed.inset-0.z-\\[80\\]')
}

/** Is the user mid-sentence somewhere else? */
function isUserTyping(): boolean {
  if (typeof document === 'undefined') return false
  const el = document.activeElement as HTMLElement | null
  if (!el) return false
  const tag = el.tagName?.toLowerCase()
  return tag === 'input' || tag === 'textarea' || el.isContentEditable === true
}
