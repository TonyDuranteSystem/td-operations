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
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { MessageSquare, X, Minus, Send, Loader2, StickyNote, Paperclip, Volume2, VolumeX, RotateCcw } from 'lucide-react'
import { createClient as createSupabaseBrowserClient } from '@/lib/supabase/client'
import { usePathname } from 'next/navigation'
import { decideAutoPop } from '@/lib/team/chat-autopop'
import {
  clampChatWindowPos, readStoredChatWindowPos, serializeChatWindowPos,
  CHAT_WINDOW_POS_KEY, CHAT_WINDOW_DEFAULT_POS, type FracPos,
} from '@/lib/team/chat-window-position'
import {
  selectableChatMembers, myDmThreads, myDmThreadIdSet, dmUnreadCount, otherPartyId,
  type ChatMember, type ChatThreadRow,
} from '@/lib/team/chat-window-threads'
import {
  mergeChatMessages, displayBody, isDeleted, attachmentCount, type ChatMessage,
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
  const people = useMemo(() => selectableChatMembers(members, myId), [members, myId])
  const unread = useMemo(() => dmUnreadCount(threads, myId), [threads, myId])
  const nameFor = useCallback(
    (id: string | null) => (id ? members.find((m) => m.id === id)?.name ?? 'Teammate' : 'Teammate'),
    [members],
  )

  // ─── window state ───
  const [openThreadId, setOpenThreadId] = useState<string | null>(null)
  const [minimized, setMinimized] = useState(false)
  const [sheetOpen, setSheetOpen] = useState(false)
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

  const openWith = useCallback(async (personId: string) => {
    const existing = dmThreads.find((t) => otherPartyId(t.dm_key, myId) === personId)
    if (existing) { setOpenThreadId(existing.id); setMinimized(false); return }
    try {
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
      setOpenThreadId(d.thread?.id ?? null)
      setMinimized(false)
      qc.invalidateQueries({ queryKey: ['floating-chat-threads'] })
    } catch (e) {
      setMsgError(e instanceof Error ? e.message : 'Could not open that conversation.')
    }
  }, [dmThreads, myId, qc])

  if (isError) return null // never block the CRM on a chat failure

  const openThread = dmThreads.find((t) => t.id === openThreadId) ?? null
  const openWithName = nameFor(otherPartyId(openThread?.dm_key, myId))
  // The window is redundant on the full chat page, and two panes fighting over
  // one read pointer is how unread state gets corrupted.
  const onChatPage = pathname === '/team-chat' || pathname.startsWith('/team-chat/')
  if (onChatPage) return null

  return (
    <>
      {/* DESKTOP window */}
      {openThreadId && !minimized && (
        <DesktopWindow
          title={openWithName}
          people={people}
          openThreadId={openThreadId}
          messages={messages}
          loading={loadingMsgs}
          error={msgError}
          myId={myId}
          quiet={quiet}
          pathname={pathname}
          onToggleQuiet={toggleQuiet}
          onPickPerson={openWith}
          onMinimize={() => setMinimized(true)}
          onClose={() => { setOpenThreadId(null); setMinimized(false) }}
          onEngage={() => markRead(openThreadId)}
          onSent={(m) => { setMessages((prev) => mergeChatMessages(prev, [m])); markRead(openThreadId) }}
          onError={setMsgError}
        />
      )}

      {/* Launcher pill — desktop when closed/minimized, and always on mobile */}
      {(!openThreadId || minimized) && (
        <button
          onClick={() => {
            if (window.matchMedia('(min-width: 1024px)').matches) {
              if (openThreadId) { setMinimized(false); return }
              // No conversation chosen yet — open the most recent, else the picker.
              const first = dmThreads[0]
              if (first) { setOpenThreadId(first.id); setMinimized(false) } else setSheetOpen(true)
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
          aria-label={unread > 0 ? `Team chat, ${unread} unread direct messages` : 'Team chat'}
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
          people={people}
          dmThreads={dmThreads}
          myId={myId}
          nameFor={nameFor}
          openThreadId={openThreadId}
          messages={messages}
          loading={loadingMsgs}
          error={msgError}
          pathname={pathname}
          onPickPerson={(id) => openWith(id)}
          onPickThread={(id) => { setOpenThreadId(id); setMinimized(false) }}
          onEngage={() => markRead(openThreadIdRef.current)}
          onSent={(m) => { setMessages((prev) => mergeChatMessages(prev, [m])); markRead(openThreadIdRef.current) }}
          onError={setMsgError}
          onClose={() => setSheetOpen(false)}
        />
      )}
    </>
  )
}

/* ─────────────────────────── desktop draggable window ─────────────────────────── */

function DesktopWindow(props: {
  title: string
  people: ChatMember[]
  openThreadId: string
  messages: ChatMessage[]
  loading: boolean
  error: string | null
  myId: string | null
  quiet: boolean
  pathname: string
  onToggleQuiet: () => void
  onPickPerson: (id: string) => void
  onMinimize: () => void
  onClose: () => void
  onEngage: () => void
  onSent: (m: ChatMessage) => void
  onError: (e: string | null) => void
}) {
  const ref = useRef<HTMLDivElement>(null)
  const [pos, setPos] = useState<FracPos>(CHAT_WINDOW_DEFAULT_POS)
  const drag = useRef<{ dx: number; dy: number } | null>(null)
  const [showPicker, setShowPicker] = useState(false)

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
      {/* Header — the recipient's name is ALWAYS visible. This is a shared,
          pushed-to-someone's-phone surface sitting beside private post-its;
          "who am I talking to" must never be a guess. */}
      <div className="flex items-center gap-2 bg-emerald-500 px-3 py-2 text-white">
        <MessageSquare className="h-4 w-4 shrink-0" />
        <button
          data-no-drag
          onClick={() => setShowPicker((s) => !s)}
          className="truncate text-sm font-semibold hover:underline"
          title="Switch person"
        >
          {props.title}
        </button>
        <span className="ml-auto flex items-center gap-1">
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

      {showPicker && (
        <div data-no-drag className="border-b bg-emerald-50 p-2">
          {props.people.length === 0 && <p className="px-2 py-1 text-xs text-zinc-500">No teammates available.</p>}
          {props.people.map((m) => (
            <button key={m.id}
              onClick={() => { props.onPickPerson(m.id); setShowPicker(false) }}
              className="block w-full rounded px-2 py-1.5 text-left text-sm hover:bg-emerald-100">
              {m.name}
            </button>
          ))}
        </div>
      )}

      <MessageList
        messages={props.messages}
        loading={props.loading}
        error={props.error}
        myId={props.myId}
        pathname={props.pathname}
        onEngage={props.onEngage}
      />

      <Composer
        threadId={props.openThreadId}
        personKey={props.openThreadId}
        onEngage={props.onEngage}
        onSent={props.onSent}
        onError={props.onError}
      />
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
}) {
  const endRef = useRef<HTMLDivElement>(null)
  const [noteFor, setNoteFor] = useState<ChatMessage | null>(null)
  const subject = subjectFromPath(props.pathname)

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
              </div>
              {!gone && (
                <button
                  onClick={() => setNoteFor(m)}
                  title="Make a note from this message"
                  className="ml-1 self-center rounded p-1 text-zinc-400 opacity-0 transition-opacity hover:bg-zinc-200 hover:text-zinc-700 group-hover:opacity-100"
                >
                  <StickyNote className="h-3.5 w-3.5" />
                </button>
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

  // Swap the draft when the conversation changes.
  useEffect(() => { setText(drafts.get(props.personKey) ?? '') }, [props.personKey])
  useEffect(() => {
    if (text) drafts.set(props.personKey, text)
    else drafts.delete(props.personKey)
  }, [text, props.personKey])

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
    <div data-no-drag className="flex items-end gap-1 border-t bg-white p-2">
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        onFocus={props.onEngage}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() }
        }}
        rows={1}
        maxLength={5000}
        placeholder="Write a message…"
        className="max-h-24 min-h-[38px] flex-1 resize-none rounded border border-zinc-300 px-2 py-2 text-sm outline-none focus:border-emerald-500"
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
  )
}

/* ─────────────────────────── mobile sheet ─────────────────────────── */

function MobileSheet(props: {
  people: ChatMember[]
  dmThreads: ChatThreadRow[]
  myId: string | null
  nameFor: (id: string | null) => string
  openThreadId: string | null
  messages: ChatMessage[]
  loading: boolean
  error: string | null
  pathname: string
  onPickPerson: (id: string) => void
  onPickThread: (id: string) => void
  onEngage: () => void
  onSent: (m: ChatMessage) => void
  onError: (e: string | null) => void
  onClose: () => void
}) {
  return (
    <div className="lg:hidden fixed inset-0 z-[47] flex flex-col justify-end bg-black/30" onClick={props.onClose}>
      <div className="flex max-h-[80vh] flex-col rounded-t-xl bg-white" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2 rounded-t-xl bg-emerald-500 px-3 py-2 text-white">
          <MessageSquare className="h-4 w-4" />
          <span className="text-sm font-semibold">
            {props.openThreadId
              ? props.nameFor(otherPartyId(props.dmThreads.find((t) => t.id === props.openThreadId)?.dm_key, props.myId))
              : 'Team chat'}
          </span>
          <button onClick={props.onClose} className="ml-auto rounded p-1 hover:bg-white/20" aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>

        {!props.openThreadId ? (
          <div className="overflow-y-auto p-2">
            {props.dmThreads.map((t) => (
              <button key={t.id} onClick={() => props.onPickThread(t.id)}
                className="flex w-full items-center justify-between rounded px-3 py-3 text-left text-sm hover:bg-zinc-100">
                <span>{props.nameFor(otherPartyId(t.dm_key, props.myId))}</span>
                {Number(t.unread_count) > 0 && (
                  <span className="rounded-full bg-emerald-500 px-2 py-0.5 text-xs text-white">{t.unread_count}</span>
                )}
              </button>
            ))}
            <p className="px-3 pb-1 pt-3 text-xs font-medium uppercase tracking-wide text-zinc-400">Start a chat</p>
            {props.people.map((m) => (
              <button key={m.id} onClick={() => props.onPickPerson(m.id)}
                className="block w-full rounded px-3 py-3 text-left text-sm hover:bg-zinc-100">
                {m.name}
              </button>
            ))}
          </div>
        ) : (
          <>
            <MessageList
              messages={props.messages}
              loading={props.loading}
              error={props.error}
              myId={props.myId}
              pathname={props.pathname}
              onEngage={props.onEngage}
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
