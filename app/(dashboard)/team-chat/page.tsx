'use client'

import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'
import {
  Send, Loader2, Users, Hash, Paperclip, Smile, Mic, MicOff, FileText, X,
  CornerUpLeft, Trash2, Plus, Search, Pin, PinOff, Pencil, Check,
  MessageSquare, Bot, Building2, Slack, ExternalLink,
  LayoutGrid, List as ListIcon, MoreHorizontal, Clock, ChevronRight, ChevronDown, ChevronLeft,
  Bell, BellOff, Archive, ArchiveRestore, Mail, Link2,
} from 'lucide-react'
import { TeamBoard } from './board'
import { matchesConversationFilter } from '@/lib/team/conversation-filter'
import { groupIntoSections, badgeTextFor, DEFAULT_OPEN_BUCKETS, type BucketKey } from '@/lib/team/conversation-buckets'
import EmojiPicker from 'emoji-picker-react'
import { format, isToday, isYesterday } from 'date-fns'
import { cn } from '@/lib/utils'
import { useVoiceInput } from '@/lib/hooks/use-voice-input'
import { uploadTeamAttachment, prepareChatFiles, CHAT_ATTACHMENT_MAX_COUNT } from '@/lib/team/attachment'
import { WorkerDropZone } from '@/components/chat/worker-dropzone'
import { TurnBadge } from '@/components/team-chat/turn-badge'
import { useSelectionHistory } from '@/lib/hooks/use-selection-history'
import { sortPanelThreads, filterStreamRoots } from '@/lib/team/thread-meta'
import { TEAM_COLORS, CLAUDE_SENDER_UUID, channelSlug, TEAM_WORK_STATUSES, TEAM_WORK_STATUS_LABELS, TEAM_STATUS_COLORS, type TeamWorkStatus } from '@/lib/team/workspace'
import type { ChatAttachment } from '@/lib/types'
import type { TeamMsg, TeamThread, TeamMember, Reaction, SlackChannel, SlackMsg, ThreadMeta, ThreadListItem, BoardThread, LaterThread } from './types'

const AVATAR_COLORS = ['bg-blue-500', 'bg-emerald-500', 'bg-violet-500', 'bg-orange-500', 'bg-rose-500', 'bg-cyan-500', 'bg-amber-500', 'bg-indigo-500']
const QUICK_EMOJIS = ['👍', '✅', '🙏', '🔥', '👀', '❤️', '😂', '🎉']

function senderColor(id: string): string {
  let h = 0
  for (let i = 0; i < id.length; i++) { h = (h << 5) - h + id.charCodeAt(i); h |= 0 }
  return AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length]
}
function initials(name: string): string {
  return name.split(' ').filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('')
}
function msgTime(ts: string): string {
  const d = new Date(ts)
  if (isToday(d)) return format(d, 'HH:mm')
  if (isYesterday(d)) return `Yesterday ${format(d, 'HH:mm')}`
  return format(d, 'MMM d, HH:mm')
}
function fileSize(b: number): string {
  if (b < 1024) return `${b} B`
  if (b < 1024 * 1024) return `${(b / 1024).toFixed(1)} KB`
  return `${(b / 1024 / 1024).toFixed(1)} MB`
}

export default function TeamWorkspacePage() {
  const [threads, setThreads] = useState<TeamThread[]>([])
  // Mirror of `threads` for effects that must READ the list without re-running
  // whenever it refreshes (the selection effect below decides the opening view;
  // tracking `threads` there would reopen the panel on every poll).
  const threadsRef = useRef<TeamThread[]>([])
  useEffect(() => { threadsRef.current = threads }, [threads])
  // Declared here (not next to its effect further down) because the selection
  // effect reads it to avoid covering a deep-linked bug with the threads panel.
  const deepRootDoneRef = useRef(false)
  const [members, setMembers] = useState<TeamMember[]>([])
  const [currentUserId, setCurrentUserId] = useState<string | null>(null)
  const [isAdmin, setIsAdmin] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [messages, setMessages] = useState<TeamMsg[]>([])
  const [loadingThreads, setLoadingThreads] = useState(true)
  const [loadingMsgs, setLoadingMsgs] = useState(false)

  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [replyTo, setReplyTo] = useState<TeamMsg | null>(null)
  const [editing, setEditing] = useState<TeamMsg | null>(null)
  const [pendingFiles, setPendingFiles] = useState<File[]>([])
  const [uploading, setUploading] = useState(false)
  const [showEmoji, setShowEmoji] = useState(false)
  const [mentionQuery, setMentionQuery] = useState<string | null>(null)
  const [commandQuery, setCommandQuery] = useState<string | null>(null)
  const [showNewChannel, setShowNewChannel] = useState(false)
  const [showNewDm, setShowNewDm] = useState(false)
  const [showNewConversation, setShowNewConversation] = useState(false)
  const [slackEnabled, setSlackEnabled] = useState(false)
  const [slackChannels, setSlackChannels] = useState<SlackChannel[]>([])
  const [selectedSlackId, setSelectedSlackId] = useState<string | null>(null)
  const [slackMessages, setSlackMessages] = useState<SlackMsg[]>([])
  const [loadingSlack, setLoadingSlack] = useState(false)
  const [view, setView] = useState<'list' | 'board'>('list')
  const [expandedChannels, setExpandedChannels] = useState<Set<string>>(new Set())
  const [expandedClients, setExpandedClients] = useState<Set<string>>(new Set())
  const [expandedBuckets, setExpandedBuckets] = useState<Set<BucketKey>>(() => new Set(DEFAULT_OPEN_BUCKETS))
  const [convTopicFilter, setConvTopicFilter] = useState<string>('')          // '' = all topics
  const [convStateFilter, setConvStateFilter] = useState<'all' | 'open' | 'solved' | 'closed'>('all')
  const [menuThreadId, setMenuThreadId] = useState<string | null>(null)
  const [searchQ, setSearchQ] = useState('')
  const [searchResults, setSearchResults] = useState<{ id: string; thread_id: string; thread_label: string; message: string; sender_name: string; created_at: string }[] | null>(null)
  const [reactFor, setReactFor] = useState<string | null>(null)
  // Which message's touch (⋯) menu is open — ONE at a time, like reactFor. Held
  // per-row it meant row A's full-screen backdrop swallowed the tap on row B.
  const [touchMenuFor, setTouchMenuFor] = useState<string | null>(null)
  // Slack threads: per-root metadata (reply counts + unread) and the currently
  // open thread pane (a root message id, or null when no pane is open).
  const [threadMeta, setThreadMeta] = useState<Record<string, ThreadMeta>>({})
  const [openRootId, setOpenRootId] = useState<string | null>(null)
  // Threads management panel: the channel's threads with status/assignee, and
  // whether the panel is open.
  const [threadsList, setThreadsList] = useState<ThreadListItem[]>([])
  const [showThreadsPanel, setShowThreadsPanel] = useState(false)
  const [paneStatusMenu, setPaneStatusMenu] = useState(false)
  // Board = every thread across every channel.
  const [allThreads, setAllThreads] = useState<BoardThread[]>([])
  const [showNewThread, setShowNewThread] = useState(false)
  // Archived threads: hidden from the panel AND the channel stream until the
  // archive view is switched on (that's what "remove it" has to mean).
  const [showArchived, setShowArchived] = useState(false)
  // The COMPLETE set of archived roots in the open channel (server-supplied).
  const [archivedRoots, setArchivedRoots] = useState<string[]>([])
  // Personal "bring forward" list — threads flagged from any channel.
  const [laterRoots, setLaterRoots] = useState<LaterThread[]>([])

  const bottomRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  // Mirror of pendingFiles for the file-intake cap math (avoids a stale closure
  // when drop/paste/paperclip fire in quick succession).
  const pendingFilesRef = useRef<File[]>([])
  const emojiRef = useRef<HTMLDivElement>(null)
  const selectedIdRef = useRef<string | null>(null)
  selectedIdRef.current = selectedId
  // Refs so the once-subscribed realtime handler reads live values.
  const currentUserIdRef = useRef<string | null>(null)
  const openRootIdRef = useRef<string | null>(null)
  // Read by loadMessages so toggling the archive view doesn't rebuild that
  // callback (it sits in a dozen dependency arrays).
  const showArchivedRef = useRef(false)
  // Threads with a delete in flight — guards against a double tap.
  const deletingRef = useRef<Set<string>>(new Set())
  const messagesRef = useRef<TeamMsg[]>([])
  // A thread the user asked to open from the Board, waiting for its channel to load.
  const pendingOpenRef = useRef<{ threadId: string; rootId: string } | null>(null)

  const { isRecording, isTranscribing, startRecording, stopRecording, isSupported: voiceSupported } =
    useVoiceInput({ language: 'en-US', onTranscript: t => setText(p => p ? `${p} ${t}` : t), onError: m => toast.error(m) })

  const selected = useMemo(() => threads.find(t => t.id === selectedId) ?? null, [threads, selectedId])
  currentUserIdRef.current = currentUserId
  openRootIdRef.current = openRootId
  messagesRef.current = messages
  showArchivedRef.current = showArchived

  // Slack threads are a channel/general feature; DMs and client discussions keep
  // the flat inline layout (and their @claude continuation) unchanged.
  const isThreadedChannel = !!selected && (selected.thread_type === 'channel' || selected.thread_type === 'general')
  // The main channel stream shows ROOTS only (incl. soft-deleted roots as
  // tombstones so their replies stay attached); replies live in the pane.
  const streamMessages = useMemo(() => {
    if (!isThreadedChannel) return messages
    // Uses the server's COMPLETE archived set, never the panel's thread list —
    // that list drops archived rows when the archive view is off, so deriving
    // from it hid nothing exactly when hiding mattered (the bug Antonio hit on
    // 2026-07-18: archived, still sitting in the channel).
    return filterStreamRoots(messages, archivedRoots, showArchived)
  }, [isThreadedChannel, messages, archivedRoots, showArchived])
  const paneRoot = useMemo(() => (openRootId ? messages.find(m => m.id === openRootId) ?? null : null), [openRootId, messages])
  const paneReplies = useMemo(() => (openRootId ? messages.filter(m => m.root_id === openRootId) : []), [openRootId, messages])

  const loadThreads = useCallback(async (selectFirst = false) => {
    try {
      const r = await fetch('/api/team/threads')
      if (!r.ok) throw new Error('Failed to load')
      const d = await r.json()
      setThreads(d.threads)
      setMembers(d.members)
      setCurrentUserId(d.current_user_id)
      setIsAdmin(d.is_admin)
      if (selectFirst && !selectedIdRef.current) {
        const general = d.threads.find((t: TeamThread) => t.thread_type === 'general')
        if (general) setSelectedId(general.id)
      }
    } catch {
      toast.error('Failed to load team workspace')
    } finally {
      setLoadingThreads(false)
    }
  }, [])

  const loadMessages = useCallback(async (threadId: string, opts?: { silent?: boolean }) => {
    if (!opts?.silent) setLoadingMsgs(true)
    try {
      const r = await fetch(`/api/team/threads/${threadId}${showArchivedRef.current ? '?include_archived=1' : ''}`)
      if (!r.ok) throw new Error('Failed')
      const d = await r.json()
      // Ignore a stale response: if the user switched threads while this was in
      // flight (e.g. deep-link auto-selects general then jumps to the channel),
      // this response is for a thread we're no longer viewing — applying it would
      // show the wrong channel's messages/threads.
      if (selectedIdRef.current && threadId !== selectedIdRef.current) return
      // On a silent poll, only replace if something actually changed (avoids
      // clobbering local optimistic state / re-render churn).
      setMessages(prev => {
        if (opts?.silent) {
          const a = prev[prev.length - 1]?.id, b = d.messages[d.messages.length - 1]?.id
          if (prev.length === d.messages.length && a === b) return prev
        }
        // Keep an OPEN thread alive across refreshes: a thread opened from the
        // Board can be older than the newest-500 window, so a plain replace would
        // empty the pane a few seconds after opening it.
        const openRoot = openRootIdRef.current
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const next = d.messages as any[]
        if (openRoot && !next.some(m => m.id === openRoot)) {
          const keep = prev.filter(m => m.id === openRoot || m.root_id === openRoot)
          if (keep.length) {
            return [...keep, ...next].sort((a, b) => (a.created_at < b.created_at ? -1 : 1))
          }
        }
        return d.messages
      })
      setThreadMeta(d.thread_meta ?? {})
      setThreadsList(d.threads ?? [])
      setArchivedRoots(d.archived_roots ?? [])
      // Optimistically clear this thread's unread badge locally — but NOT for a
      // channel. A channel's badge counts BUGS WITH SOMETHING NEW and is
      // deliberately not cleared by opening the channel (that was the whole
      // bug). Zeroing it here made it blink: this call zeroed it, the 20s
      // thread-list poll restored the true number, the 8s message poll zeroed it
      // again — which reads exactly like the defect being fixed.
      setThreads(prev => prev.map(t => (
        t.id === threadId && t.thread_type !== 'channel' ? { ...t, unread_count: 0 } : t
      )))
    } catch {
      if (!opts?.silent) toast.error('Failed to load messages')
    } finally {
      if (!opts?.silent) setLoadingMsgs(false)
    }
  }, [])

  // Initial load
  useEffect(() => { loadThreads(true) }, [loadThreads])

  // Slack mirror (only shows when the kill-switch is on)
  const loadSlackChannels = useCallback(async () => {
    try {
      const r = await fetch('/api/team/slack/channels')
      const d = await r.json()
      setSlackEnabled(!!d.enabled)
      setSlackChannels(d.channels ?? [])
    } catch { /* mirror off / unreachable — leave hidden */ }
  }, [])
  useEffect(() => { loadSlackChannels() }, [loadSlackChannels])

  const selectSlack = useCallback(async (channelId: string) => {
    setSelectedSlackId(channelId)
    setSelectedId(null)
    setLoadingSlack(true)
    try {
      const r = await fetch(`/api/team/slack/channels/${channelId}/messages`)
      const d = await r.json()
      setSlackMessages(d.messages ?? [])
    } catch { setSlackMessages([]) } finally { setLoadingSlack(false) }
  }, [])

  // Selecting a native thread leaves the Slack view.
  useEffect(() => { if (selectedId) setSelectedSlackId(null) }, [selectedId])

  // Deep link: /team-chat?thread=<id> selects that thread once loaded (used by
  // push notifications and the "New conversation" channel card).
  const searchParams = useSearchParams()
  const deepLinkThread = searchParams.get('thread')
  // ONE-SHOT: apply the URL's thread once. Re-asserting it on every threads
  // refresh would fight any later channel switch — e.g. opening a thread from
  // the Board would snap straight back to the deep-linked channel.
  const deepThreadDoneRef = useRef(false)
  useEffect(() => {
    if (deepThreadDoneRef.current) return
    if (deepLinkThread && threads.some(t => t.id === deepLinkThread)) {
      deepThreadDoneRef.current = true
      setSelectedId(deepLinkThread)
    }
  }, [deepLinkThread, threads])

  // Load messages when a thread is selected (and close any open thread pane).
  //
  // A CHANNEL now opens on its LIST OF THREADS, not the flat stream. Antonio,
  // 2026-07-24, on td-bug: "it is a mess because I can't control the single bug,
  // I have to go back and forth to each one." The per-bug list already existed —
  // titles, status, who is on it, what is new — but it was behind a button, so
  // the thing you landed on was the one long scroll. The stream is one click
  // away (the panel's Close), and any deep link straight to a bug still wins:
  // openThread() closes the panel.
  // DMs and client conversations are real conversations, not lists of work, so
  // they still open on their messages.
  useEffect(() => {
    if (!selectedId) return
    setOpenRootId(null)
    const t = threadsRef.current.find(x => x.id === selectedId)
    // ⚠️ 'channel' ONLY, never 'general'. General is a flat room — 48 top-level
    // messages, zero threads — so opening it on the panel shows "No threads
    // here" as a full-cover overlay. And general is what a cold load
    // auto-selects, so that would be the FIRST thing seen on every visit.
    const isChannel = t?.thread_type === 'channel'
    // Don't cover a bug the user was deep-linked to (notification / copied
    // link). Scoped to the deep-linked channel itself: a root that never
    // resolves (older than the loaded window, or a stale link) must not leave
    // every later channel opening on the stream for the rest of the session.
    const deepLinkPending = !!searchParams.get('root')
      && !deepRootDoneRef.current
      && selectedId === searchParams.get('thread')
    // Same for a bug opened from the BOARD: that flow sets selectedId first and
    // opens the pane on the next render, so opening the panel here would flash a
    // full-white overlay for one paint — the whole screen on the phone.
    const boardOpenPending = pendingOpenRef.current?.threadId === selectedId
    setShowThreadsPanel(isChannel && !deepLinkPending && !boardOpenPending)
    loadMessages(selectedId)
    // threadsRef/searchParams are read, not tracked: this must run on SELECTION,
    // not every time the thread list refreshes underneath it (that would slam
    // the panel back open while the user is reading the stream).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId, loadMessages])

  // Realtime: messages + thread list
  useEffect(() => {
    const supabase = createClient()
    let debounce: ReturnType<typeof setTimeout> | null = null
    const refreshList = () => { if (debounce) clearTimeout(debounce); debounce = setTimeout(() => loadThreads(), 400) }
    const channel = supabase
      .channel('team-workspace')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'internal_messages' }, (payload) => {
        const m = payload.new as TeamMsg
        if (m.thread_id === selectedIdRef.current) {
          setMessages(prev => prev.some(x => x.id === m.id) ? prev : [...prev, { ...m, reply_to_preview: null }])
          // A reply from someone else bumps its thread's count + unread dot
          // (unless that thread's pane is already open).
          if (m.root_id && m.sender_id !== currentUserIdRef.current) {
            const rid = m.root_id
            const paneOpen = openRootIdRef.current === rid
            setThreadMeta(prev => {
              const cur = prev[rid]
              return {
                ...prev,
                [rid]: cur
                  ? { ...cur, reply_count: cur.reply_count + 1, last_reply_at: m.created_at, last_reply_sender: m.sender_name, unread: cur.unread || !paneOpen }
                  : { reply_count: 1, last_reply_at: m.created_at, last_reply_sender: m.sender_name, unread: !paneOpen },
              }
            })
          }
        }
        refreshList()
      })
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'internal_messages' }, (payload) => {
        const m = payload.new as TeamMsg
        if (m.thread_id === selectedIdRef.current) {
          setMessages(prev => prev.map(x => x.id === m.id ? { ...x, ...m } : x))
        }
        refreshList()
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'internal_threads' }, () => refreshList())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'internal_thread_state' }, (payload) => {
        // A status/assignee change (possibly by another user) → refresh the open
        // channel's thread list so the panel + pills stay in sync (no double-grab).
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const row = (payload.new ?? payload.old) as any
        if (row?.thread_id === selectedIdRef.current) loadMessages(selectedIdRef.current!, { silent: true })
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'internal_root_follows' }, (payload) => {
        // A follow/unfollow (by me on another device, or affecting my view) →
        // refresh so bells + the followed-unread dot stay in sync.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const row = (payload.new ?? payload.old) as any
        if (row?.user_id === currentUserIdRef.current && selectedIdRef.current) loadMessages(selectedIdRef.current, { silent: true })
      })
      .subscribe()
    return () => { if (debounce) clearTimeout(debounce); supabase.removeChannel(channel) }
  }, [loadThreads, loadMessages])

  // Scroll to bottom only when a genuinely-new message arrives (not on every
  // poll refresh, which would fight the user's scroll position).
  const lastMsgIdRef = useRef<string | null>(null)
  useEffect(() => {
    const lastId = messages[messages.length - 1]?.id ?? null
    if (lastId && lastId !== lastMsgIdRef.current) {
      lastMsgIdRef.current = lastId
      bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
    }
  }, [messages])

  // Polling fallback — realtime is best-effort (WebSocket can drop, or the
  // changefeed can lag). Poll the open thread + the sidebar so the workspace
  // stays correct even when realtime delivers nothing. Pauses when the tab is
  // hidden to avoid waste. Mirrors the portal-chats staff inbox pattern.
  useEffect(() => {
    const msgTimer = setInterval(() => {
      if (document.visibilityState === 'visible' && selectedIdRef.current) {
        loadMessages(selectedIdRef.current, { silent: true })
      }
    }, 8000)
    const listTimer = setInterval(() => {
      if (document.visibilityState === 'visible') loadThreads()
    }, 20000)
    return () => { clearInterval(msgTimer); clearInterval(listTimer) }
  }, [loadMessages, loadThreads])

  // Auto-grow textarea
  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = '0px'
    el.style.height = Math.max(44, Math.min(el.scrollHeight, 240)) + 'px'
  }, [text])

  // Close emoji picker on outside click
  useEffect(() => {
    const h = (e: MouseEvent) => { if (emojiRef.current && !emojiRef.current.contains(e.target as Node)) setShowEmoji(false) }
    document.addEventListener('mousedown', h)
    return () => document.removeEventListener('mousedown', h)
  }, [])

  // Detect @mention and /command typing for autocomplete
  const onTextChange = (val: string) => {
    setText(val)
    const el = inputRef.current
    const caret = el?.selectionStart ?? val.length
    const upto = val.slice(0, caret)
    const m = upto.match(/(?:^|\s)@([a-zA-Z0-9._-]*)$/)
    setMentionQuery(m ? m[1].toLowerCase() : null)
    // Slash-command menu: only when the whole message starts with "/"
    const c = val.match(/^\/([a-zA-Z]*)$/)
    setCommandQuery(c ? c[1].toLowerCase() : null)
  }

  const SLASH_COMMANDS = useMemo(() => [
    { key: 'client', label: 'New conversation', hint: 'client + topic discussion', run: () => setShowNewConversation(true) },
    { key: 'channel', label: 'New channel', hint: 'create a channel folder', run: () => setShowNewChannel(true) },
    { key: 'dm', label: 'New direct message', hint: 'message a teammate', run: () => setShowNewDm(true) },
    { key: 'board', label: 'Open board', hint: 'kanban view of all threads', run: () => setView('board') },
  ], [])

  const commandCandidates = useMemo(() => {
    if (commandQuery === null) return []
    return SLASH_COMMANDS.filter(c => c.key.startsWith(commandQuery) || c.label.toLowerCase().includes(commandQuery))
  }, [commandQuery, SLASH_COMMANDS])

  const runCommand = (cmd: { run: () => void }) => {
    setText('')
    setCommandQuery(null)
    cmd.run()
  }

  const mentionCandidates = useMemo(() => {
    if (mentionQuery === null) return []
    const claude = { id: CLAUDE_SENDER_UUID, name: 'Claude (AI)', role: 'ai' as const, handle: 'claude' }
    const list: { id: string; name: string; role: string; handle: string }[] = [
      ...members.filter(m => m.id !== currentUserId).map(m => ({ id: m.id, name: m.name, role: m.role, handle: m.handles[0] ?? m.name.toLowerCase() })),
      claude,
    ]
    if (!mentionQuery) return list.slice(0, 6)
    return list.filter(c => c.handle.includes(mentionQuery) || c.name.toLowerCase().includes(mentionQuery)).slice(0, 6)
  }, [mentionQuery, members, currentUserId])

  const insertMention = (handle: string) => {
    const el = inputRef.current
    const caret = el?.selectionStart ?? text.length
    const upto = text.slice(0, caret)
    const rest = text.slice(caret)
    const replaced = upto.replace(/@([a-zA-Z0-9._-]*)$/, `@${handle} `)
    // Put the caret right AFTER the inserted "@handle " (past the trailing
    // space), not where it used to be — otherwise a controlled textarea restores
    // the old offset, which now sits behind the name we just inserted.
    const newCaret = replaced.length
    setText(replaced + rest)
    setMentionQuery(null)
    requestAnimationFrame(() => {
      const e = inputRef.current
      if (!e) return
      e.focus()
      try { e.setSelectionRange(newCaret, newCaret) } catch { /* setSelectionRange unsupported — focus alone */ }
    })
  }

  // Keep the ref in sync so file-intake reads the live staged list.
  useEffect(() => { pendingFilesRef.current = pendingFiles }, [pendingFiles])

  // Single intake path for the paperclip, drag-drop, and paste. Validates + caps
  // at add-time and tells the user what was rejected or dropped (never fails
  // silently), then stages the survivors. The final slice is a concurrency
  // safety net so two near-simultaneous batches can't exceed the cap.
  const addPendingFiles = useCallback((incoming: File[]) => {
    if (!incoming.length) return
    const { accepted, rejected, overflow } = prepareChatFiles(incoming, pendingFilesRef.current.length)
    if (rejected.length) toast.error(`Couldn't attach ${rejected.join(', ')} — programs, scripts, and empty items aren't allowed.`)
    if (overflow > 0) toast.error(`Only ${CHAT_ATTACHMENT_MAX_COUNT} files per message — ${overflow} not added.`)
    if (accepted.length) setPendingFiles(prev => [...prev, ...accepted].slice(0, CHAT_ATTACHMENT_MAX_COUNT))
  }, [])

  // Paste a screenshot/file into the composer. Only intercept when the clipboard
  // actually carries files AND no real text — otherwise a normal (or spreadsheet)
  // text paste would be swallowed.
  const handlePaste = useCallback((e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    if (sending || uploading || editing) return
    const dt = e.clipboardData
    const files = Array.from(dt?.files ?? [])
    if (!files.length) return
    const hasText = Array.from(dt?.types ?? []).some(t => t === 'text/plain' || t === 'text/html')
    if (hasText) return
    e.preventDefault()
    addPendingFiles(files)
  }, [sending, uploading, editing, addPendingFiles])

  const handleSend = useCallback(async () => {
    const msg = text.trim()
    // Slash-command parity with Slack: "/client" opens the native New
    // conversation modal (client + topic + channel) instead of sending.
    if (/^\/client\b/i.test(msg)) {
      setText('')
      setShowNewConversation(true)
      return
    }
    if ((!msg && pendingFiles.length === 0) || !selectedId || sending || uploading) return
    if (isRecording) stopRecording()

    // Edit mode
    if (editing) {
      setSending(true)
      try {
        const r = await fetch(`/api/team/messages/${editing.id}`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ message: msg }),
        })
        if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d.error || 'Edit failed') }
        const d = await r.json().catch(() => null)
        if (d?.message) setMessages(prev => prev.map(x => x.id === d.message.id ? { ...x, ...d.message } : x))
        setEditing(null); setText('')
      } catch (e) {
        toast.error(e instanceof Error ? e.message : 'Edit failed')
      } finally { setSending(false) }
      return
    }

    setSending(true)
    const sentText = msg
    const sentReply = replyTo
    const files = [...pendingFiles]
    setText(''); setReplyTo(null); setPendingFiles([]); setMentionQuery(null)
    try {
      let attachments: ChatAttachment[] | null = null
      if (files.length) {
        setUploading(true)
        try {
          attachments = await Promise.all(files.map(f => uploadTeamAttachment(f, selectedId)))
        } finally { setUploading(false) }
      }
      // Reply target: a quoted message, else the open thread's root, else a
      // top-level channel post. The server flattens to the correct thread root.
      const replyTargetId = sentReply?.id ?? openRootId ?? null
      const r = await fetch(`/api/team/threads/${selectedId}/messages`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: sentText, reply_to_id: replyTargetId, attachments }),
      })
      if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d.error || 'Failed to send') }
      // Optimistically render the sender's own message immediately, instead of
      // waiting for the realtime round-trip (which can lag or drop). The realtime
      // INSERT handler dedups by id, so no double render. If @claude was pinged,
      // its placeholder arrives via realtime/poll.
      const d = await r.json().catch(() => null)
      if (d?.message) {
        setMessages(prev => prev.some(x => x.id === d.message.id) ? prev : [...prev, {
          ...d.message,
          reply_to_preview: sentReply
            ? { id: sentReply.id, message: sentReply.message, sender_name: sentReply.sender_name, deleted_at: sentReply.deleted_at }
            : null,
        }])
        // If this was a thread reply, bump the root's reply count locally.
        if (d.message.root_id) {
          const rid: string = d.message.root_id
          setThreadMeta(prev => {
            const cur = prev[rid]
            return {
              ...prev,
              [rid]: cur
                ? { ...cur, reply_count: cur.reply_count + 1, last_reply_at: d.message.created_at, last_reply_sender: d.message.sender_name, unread: false }
                : { reply_count: 1, last_reply_at: d.message.created_at, last_reply_sender: d.message.sender_name, unread: false },
            }
          })
        }
      }
    } catch (e) {
      toast.error(e instanceof Error && e.message ? e.message : 'Failed to send')
      setText(sentText); setReplyTo(sentReply)
      // Keep the staged files so the send can be retried. Merge (not overwrite)
      // in case the user staged another file during the in-flight upload; the
      // slice keeps the per-message cap intact.
      if (files.length) setPendingFiles(prev => [...files, ...prev].slice(0, CHAT_ATTACHMENT_MAX_COUNT))
    } finally { setSending(false); inputRef.current?.focus() }
  }, [text, pendingFiles, selectedId, sending, uploading, replyTo, editing, openRootId, isRecording, stopRecording])

  // Open a Slack thread pane on a root message: mark it read (per-thread), clear
  // its local unread dot, and default the composer to reply to the root.
  /**
   * Advance MY read pointer on one thread. Throttled per root — engagement
   * gestures arrive in bursts and each call is a POST.
   *
   * ⚠️ CALL THIS ONLY ON A REAL HUMAN GESTURE (opening the thread, a pointer /
   * key inside its pane, sending into it). NEVER on a message arriving, a poll,
   * or a programmatic scroll — that is the "a message marked itself read" defect
   * this workspace has already shipped once (see the 2026-07-23 entry in
   * docs/systems/team-workspace.md). A badge cleared for a message nobody saw is
   * unrecoverable: the push has already gone.
   */
  const lastReadPostRef = useRef<Record<string, number>>({})
  const markThreadRead = useCallback((rootId: string) => {
    const tid = selectedIdRef.current
    if (!tid || !rootId) return
    const now = Date.now()
    if (now - (lastReadPostRef.current[rootId] ?? 0) < 3000) return
    lastReadPostRef.current[rootId] = now
    fetch(`/api/team/threads/${tid}/thread-read`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ root_id: rootId }),
    }).catch(() => {})
  }, [])

  /**
   * A reply that lands WHILE the pane is open is read by a human who is sitting
   * there — but only when they actually do something. Without this the reply
   * stays counted in the channel badge until the user clicks that same bug a
   * second time, which nobody thinks to do while already reading it.
   */
  const onPaneEngagement = useCallback(() => {
    const rid = openRootIdRef.current
    if (rid) {
      markThreadRead(rid)
      setThreadMeta(prev => prev[rid] ? { ...prev, [rid]: { ...prev[rid], unread: false } } : prev)
      setThreadsList(prev => prev.map(t => t.root_id === rid ? { ...t, unread: false } : t))
    }
  }, [markThreadRead])

  const openThread = useCallback((rootId: string) => {
    setOpenRootId(rootId)
    setReplyTo(null)
    // The threads panel is a full-cover overlay and a channel now opens on it,
    // so opening a bug must always uncover it — from the panel, from the stream,
    // and from a deep link arriving after the panel has been shown.
    setShowThreadsPanel(false)
    setThreadMeta(prev => prev[rootId] ? { ...prev, [rootId]: { ...prev[rootId], unread: false } } : prev)
    // The panel's own row also carries the dot — clear it there or a thread the
    // user just opened stays bold behind the pane.
    setThreadsList(prev => prev.map(t => t.root_id === rootId ? { ...t, unread: false } : t))
    // Opening a thread IS the gesture — bypass the throttle window so a fresh
    // open always records, even right after a pane gesture on the same root.
    lastReadPostRef.current[rootId] = 0
    markThreadRead(rootId)
    requestAnimationFrame(() => inputRef.current?.focus())
  }, [markThreadRead])

  const closeThread = useCallback(() => { setOpenRootId(null); setReplyTo(null) }, [])

  // Back out of the full-width thread view to the channel's list of threads
  // (the drill-in "back" gesture). For a channel that means re-opening the
  // Threads panel; other threaded surfaces just reveal their stream.
  const backFromThread = useCallback(() => {
    setOpenRootId(null); setReplyTo(null)
    const t = threadsRef.current.find(x => x.id === selectedIdRef.current)
    if (t?.thread_type === 'channel') setShowThreadsPanel(true)
  }, [])

  // Select a sidebar thread. Clicking the channel you're ALREADY in returns you
  // to its thread list and closes any open thread — otherwise setSelectedId with
  // the same value is a React no-op, the selection effect never re-runs, and the
  // click appears to do nothing while a thread is open (Antonio, 2026-07-26: "I
  // click td-bug and it doesn't go back in the list").
  const onSelectThread = useCallback((id: string) => {
    if (selectedIdRef.current !== id) { setSelectedId(id); return }
    setOpenRootId(null)
    const t = threadsRef.current.find(x => x.id === id)
    if (t?.thread_type === 'channel') setShowThreadsPanel(true)
  }, [])

  // Set a thread's management status and/or assignee (Threads panel + pane).
  const setThreadState = useCallback(async (rootId: string, patch: { status?: TeamWorkStatus; assignee_id?: string | null; title?: string | null }, channelId?: string) => {
    // Optimistic local update. A cleared title falls back to the opening
    // message, which only the server knows — so on a clear we reconcile from
    // the reload rather than guessing a title here.
    const titlePatch = patch.title ? { title: patch.title } : {}
    setThreadsList(prev => prev.map(t => t.root_id === rootId ? { ...t, ...(patch.status !== undefined ? { status: patch.status } : {}), ...(patch.assignee_id !== undefined ? { assignee_id: patch.assignee_id } : {}), ...titlePatch } : t))
    setAllThreads(prev => prev.map(t => t.root_message_id === rootId ? { ...t, ...(patch.status !== undefined ? { status: patch.status } : {}), ...(patch.assignee_id !== undefined ? { assignee_id: patch.assignee_id } : {}), ...titlePatch } : t))
    setThreadMeta(prev => prev[rootId] ? { ...prev, [rootId]: { ...prev[rootId], ...(patch.status !== undefined ? { status: patch.status } : {}), ...(patch.assignee_id !== undefined ? { assignee_id: patch.assignee_id } : {}) } } : prev)
    // Target the thread's OWN channel (Board rows come from other channels).
    const tid = channelId ?? selectedIdRef.current
    if (!tid) return
    try {
      const r = await fetch(`/api/team/threads/${tid}/thread-state`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ root_id: rootId, ...patch }),
      })
      if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d.error || 'Could not update the thread.') }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not update the thread.')
      loadMessages(tid, { silent: true }) // reconcile from the server on failure
    }
  }, [loadMessages])

  // Deliberately start a thread in this channel (the "+ New thread" button).
  // The thread gets its own title and is registered immediately, so it shows in
  // the lists straight away — no waiting for someone to reply.
  const createThread = useCallback(async (title: string, note: string) => {
    const tid = selectedIdRef.current
    if (!tid) return
    try {
      const r = await fetch(`/api/team/threads/${tid}/new-thread`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title, body: note }),
      })
      if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d.error || 'Could not create the thread.') }
      const d = await r.json()
      setShowNewThread(false)
      await loadMessages(tid)
      if (d.root_id) openThread(d.root_id)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not create the thread.')
    }
  }, [loadMessages, openThread])

  // Every thread across every channel (the Board).
  // Failures are SURFACED (R099), not swallowed: an empty board and a broken
  // board looked identical before, which is exactly how a missing database
  // change would ship unnoticed.
  const loadAllThreads = useCallback(async (includeArchived = false) => {
    try {
      const r = await fetch(`/api/team/all-threads${includeArchived ? '?include_archived=1' : ''}`)
      if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d.error || 'Could not load the thread board.') }
      const d = await r.json()
      setAllThreads(d.threads ?? [])
    } catch (e) {
      toast.error(e instanceof Error && e.message ? e.message : 'Could not load the thread board.')
    }
  }, [])

  // The Board is cross-channel — load it whenever it's shown. ONE archive view
  // is shared with the Threads panel, so the Board is also where you restore a
  // thread you archived in a channel you're no longer sitting in.
  useEffect(() => { if (view === 'board') loadAllThreads(showArchived) }, [view, loadAllThreads, showArchived])


  // Flipping the archive view changes what the SERVER returns, so refetch once.
  // Deliberately keyed on showArchived alone — adding selectedId/loadMessages
  // would refire this on every channel switch and message load.
  useEffect(() => {
    const tid = selectedIdRef.current
    if (tid) loadMessages(tid, { silent: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showArchived])

  // Open a thread that may live in ANOTHER channel (clicked on the Board).
  // Switching channel resets the pane, so the request is parked in a ref and
  // replayed once that channel's messages have loaded.
  const openThreadInChannel = useCallback((threadId: string, rootId: string) => {
    setView('list')
    if (selectedIdRef.current === threadId) {
      pendingOpenRef.current = { threadId, rootId }
    } else {
      pendingOpenRef.current = { threadId, rootId }
      setSelectedId(threadId)
    }
  }, [])

  // Follow / unfollow a thread (per-person). Presence = following; unfollow truly
  // stops the pings. Never touches read state. `channelId` targets the thread's
  // OWN channel — the Board shows threads from channels you aren't viewing.
  const setThreadFollow = useCallback(async (rootId: string, follow: boolean, channelId?: string) => {
    setThreadsList(prev => prev.map(t => t.root_id === rootId ? { ...t, following: follow } : t))
    setAllThreads(prev => prev.map(t => t.root_message_id === rootId ? { ...t, following: follow } : t))
    const tid = channelId ?? selectedIdRef.current
    if (!tid) return
    try {
      const r = await fetch(`/api/team/threads/${tid}/thread-follow`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ root_id: rootId, follow }),
      })
      if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d.error || 'Could not update follow.') }
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not update follow.')
      loadMessages(tid, { silent: true })
    }
  }, [loadMessages])

  // The personal "bring forward" list, across every channel.
  const loadLaterThreads = useCallback(async () => {
    try {
      const r = await fetch('/api/team/later-threads')
      if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d.error || 'Could not load your Later list.') }
      const d = await r.json()
      setLaterRoots(d.threads ?? [])
    } catch (e) {
      toast.error(e instanceof Error && e.message ? e.message : 'Could not load your Later list.')
    }
  }, [])

  // The personal Later list lives in the sidebar, so load it once on mount.
  useEffect(() => { loadLaterThreads() }, [loadLaterThreads])

  /** Personal "bring forward" — flag a thread onto (or off) your Later list. */
  const setThreadLater = useCallback(async (rootId: string, later: boolean, channelId?: string) => {
    const tid = channelId ?? selectedIdRef.current
    if (!tid) return
    setThreadsList(prev => prev.map(t => t.root_id === rootId ? { ...t, later } : t))
    setAllThreads(prev => prev.map(t => t.root_message_id === rootId ? { ...t, later } : t))
    if (!later) setLaterRoots(prev => prev.filter(l => l.root_message_id !== rootId))
    try {
      const r = await fetch(`/api/team/threads/${tid}/thread-later`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ root_id: rootId, later }),
      })
      if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d.error || 'Could not update the list.') }
      toast.success(later ? 'Brought forward.' : 'Removed from Later.')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not update the list.')
    }
    loadLaterThreads()
  }, [loadLaterThreads])

  /**
   * Personal "mark unread". With a message id this is Slack's mark-unread-FROM-
   * HERE: everything from that message down reads as new again.
   */
  const markThreadUnread = useCallback(async (rootId: string, fromMessageId?: string, channelId?: string) => {
    const tid = channelId ?? selectedIdRef.current
    if (!tid) return
    setThreadsList(prev => prev.map(t => t.root_id === rootId ? { ...t, unread: true } : t))
    setThreadMeta(prev => prev[rootId] ? { ...prev, [rootId]: { ...prev[rootId], unread: true } } : prev)
    // Close the pane: leaving it open would immediately re-read the thread and
    // undo the very thing that was just asked for.
    if (openRootIdRef.current === rootId) setOpenRootId(null)
    try {
      const r = await fetch(`/api/team/threads/${tid}/thread-unread`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ root_id: rootId, ...(fromMessageId ? { from_message_id: fromMessageId } : {}) }),
      })
      if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d.error || 'Could not mark it unread.') }
      toast.success('Marked unread.')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not mark it unread.')
    }
  }, [])

  // Rename a thread. Blank clears the name, falling back to the opening message.
  const renameThread = useCallback(async (rootId: string, title: string, channelId?: string) => {
    await setThreadState(rootId, { title: title.trim() || null }, channelId)
    const tid = channelId ?? selectedIdRef.current
    if (tid) loadMessages(tid, { silent: true })
    loadAllThreads(showArchivedRef.current)
  }, [setThreadState, loadMessages, loadAllThreads])

  /**
   * Archive (hide) a thread or bring it back. Reversible and destroys nothing —
   * the default way to get a thread off the boards.
   */
  const setThreadArchived = useCallback(async (rootId: string, archived: boolean, channelId?: string) => {
    const tid = channelId ?? selectedIdRef.current
    if (!tid) return
    // Drop it from view immediately; close its pane if it was open. The
    // archived set drives the CHANNEL stream, so it has to move optimistically
    // too or the thread lingers there until the refetch lands.
    setArchivedRoots(prev => archived ? Array.from(new Set([...prev, rootId])) : prev.filter(id => id !== rootId))
    setThreadsList(prev => prev.map(t => t.root_id === rootId ? { ...t, archived } : t))
    setAllThreads(prev => prev.map(t => t.root_message_id === rootId ? { ...t, archived } : t))
    if (archived && openRootIdRef.current === rootId) setOpenRootId(null)
    try {
      const r = await fetch(`/api/team/threads/${tid}/thread-remove`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ root_id: rootId, archived }),
      })
      if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d.error || 'Could not archive the thread.') }
      toast.success(archived ? 'Thread archived.' : 'Thread restored.')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not archive the thread.')
    }
    loadMessages(tid, { silent: true })
    loadAllThreads(showArchivedRef.current)
  }, [loadMessages, loadAllThreads])

  /**
   * Delete a thread outright. The server only allows this while you are the
   * only person who has posted in it — anything else comes back as a refusal
   * telling you to archive instead, which we surface verbatim (R099).
   */
  const deleteThread = useCallback(async (rootId: string, channelId?: string) => {
    const tid = channelId ?? selectedIdRef.current
    if (!tid) return
    // A second tap would hit an already-deleted root and toast "not found"
    // straight after "Thread deleted."
    if (deletingRef.current.has(rootId)) return
    deletingRef.current.add(rootId)
    try {
      const r = await fetch(`/api/team/threads/${tid}/thread-remove?root_id=${encodeURIComponent(rootId)}`, { method: 'DELETE' })
      if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d.error || 'Could not delete the thread.') }
      if (openRootIdRef.current === rootId) setOpenRootId(null)
      setThreadsList(prev => prev.filter(t => t.root_id !== rootId))
      setAllThreads(prev => prev.filter(t => t.root_message_id !== rootId))
      setMessages(prev => prev.filter(m => m.id !== rootId && m.root_id !== rootId))
      toast.success('Thread deleted.')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Could not delete the thread.')
    } finally {
      deletingRef.current.delete(rootId)
    }
    loadMessages(tid, { silent: true })
    loadAllThreads(showArchivedRef.current)
  }, [loadMessages, loadAllThreads])

  // Replay a Board click: once the thread's channel has loaded, open its pane —
  // fetching that one thread on demand when its opening message is older than the
  // loaded window (otherwise the pane would render empty).
  useEffect(() => {
    const p = pendingOpenRef.current
    if (!p || p.threadId !== selectedId || loadingMsgs) return
    if (messages.some(m => m.id === p.rootId)) {
      pendingOpenRef.current = null
      openThread(p.rootId)
      return
    }
    let cancelled = false
    ;(async () => {
      try {
        const r = await fetch(`/api/team/threads/${p.threadId}/thread-messages?root=${p.rootId}`)
        if (!r.ok) throw new Error('failed')
        const d = await r.json()
        if (cancelled) return
        setMessages(prev => {
          const seen = new Set(prev.map(m => m.id))
          const add = ((d.messages ?? []) as TeamMsg[]).filter(m => !seen.has(m.id))
          return [...prev, ...add].sort((a, b) => (a.created_at < b.created_at ? -1 : 1))
        })
        pendingOpenRef.current = null
        openThread(p.rootId)
      } catch {
        pendingOpenRef.current = null
        toast.error("Couldn't open that thread.")
      }
    })()
    return () => { cancelled = true }
  }, [selectedId, messages, loadingMsgs, openThread])

  // Deep link to a specific thread pane: /team-chat?thread=<ch>&root=<rootId>.
  // One-shot (a ref guard) so it doesn't re-open on every poll refresh.
  const deepLinkRoot = searchParams.get('root')
  useEffect(() => {
    if (!deepLinkRoot || deepRootDoneRef.current) return
    if (selectedId === deepLinkThread && messages.some(m => m.id === deepLinkRoot)) {
      deepRootDoneRef.current = true
      openThread(deepLinkRoot)
    }
  }, [deepLinkRoot, deepLinkThread, selectedId, messages, openThread])

  // ── Make every Team Workspace selection a real Back step ──────────────────
  // Picking a channel / DM / conversation, opening a thread, switching to the
  // Board, or opening a Slack channel are all pure state — the URL never moved,
  // so the global Back arrow skipped the whole page and landed on the dashboard
  // (Antonio, 2026-07-26, on Portal Chats; identical here). Recording them in
  // the query string makes Back walk: thread → channel → previous channel → the
  // page before. Reuses the SAME `?thread=`/`?root=` keys the existing deep
  // links use, so a copied URL and a Back step mean exactly the same thing.
  useSelectionHistory(
    {
      thread: selectedId,
      root: openRootId,
      slack: selectedSlackId,
      view: view === 'board' ? 'board' : null,
    },
    (v) => {
      setView(v.view === 'board' ? 'board' : 'list')
      if (v.slack) { selectSlack(v.slack); return }
      if (!v.thread) {
        pendingOpenRef.current = null
        setSelectedId(null); setOpenRootId(null); setReplyTo(null)
        return
      }
      if (v.root) {
        // Go through the Board's proven path: it parks the request and replays
        // it once that channel's messages have loaded — and fetches the thread
        // on demand when it's older than the loaded window. Setting openRootId
        // directly would be WIPED by the selection effect, which resets the open
        // thread whenever the channel changes.
        openThreadInChannel(v.thread, v.root)
        return
      }
      // Channel with no thread open.
      pendingOpenRef.current = null
      if (selectedIdRef.current === v.thread) {
        // Same channel — this is "close the thread". setSelectedId would be a
        // no-op here, so the selection effect never runs and the thread would
        // stay open; mirror what the in-thread back arrow does.
        setOpenRootId(null); setReplyTo(null)
        const t = threadsRef.current.find(x => x.id === v.thread)
        if (t?.thread_type === 'channel') setShowThreadsPanel(true)
      } else {
        setSelectedId(v.thread)
      }
    },
  )

  const toggleReaction = async (msgId: string, emoji: string) => {
    setReactFor(null)
    try {
      const r = await fetch(`/api/team/messages/${msgId}/react`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ emoji }),
      })
      if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d.error || 'Failed') }
      const data = await r.json()
      setMessages(prev => prev.map(m => m.id === msgId ? { ...m, reactions: data.reactions } : m))
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Reaction failed') }
  }

  const togglePin = async (m: TeamMsg) => {
    try {
      const r = await fetch(`/api/team/messages/${m.id}/pin`, { method: 'POST' })
      if (!r.ok) { const d = await r.json().catch(() => ({})); throw new Error(d.error || 'Failed') }
      const data = await r.json()
      setMessages(prev => prev.map(x => x.id === m.id ? { ...x, pinned_at: data.message.pinned_at, pinned_by: data.message.pinned_by } : x))
    } catch (e) { toast.error(e instanceof Error ? e.message : 'Pin failed') }
  }

  const deleteMsg = async (m: TeamMsg) => {
    setMessages(prev => prev.map(x => x.id === m.id ? { ...x, deleted_at: new Date().toISOString(), deleted_by: currentUserId } : x))
    const r = await fetch(`/api/team/messages/${m.id}`, { method: 'DELETE' })
    if (!r.ok) { const d = await r.json().catch(() => ({})); toast.error(d.error || 'Delete failed'); loadMessages(selectedId!) }
  }

  const runSearch = async (q: string) => {
    setSearchQ(q)
    if (q.trim().length < 2) { setSearchResults(null); return }
    try {
      const r = await fetch(`/api/team/search?q=${encodeURIComponent(q)}`)
      const d = await r.json()
      setSearchResults(d.results ?? [])
    } catch { setSearchResults([]) }
  }

  const createChannel = async (name: string, color: string) => {
    const r = await fetch('/api/team/channels', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name, color }),
    })
    const d = await r.json().catch(() => ({}))
    if (!r.ok) { toast.error(d.error || 'Failed to create channel'); return }
    setShowNewChannel(false)
    await loadThreads()
    setSelectedId(d.thread.id)
  }

  const startDm = async (userId: string) => {
    const r = await fetch('/api/team/dms', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ user_id: userId }),
    })
    const d = await r.json().catch(() => ({}))
    if (!r.ok) { toast.error(d.error || 'Failed to open DM'); return }
    setShowNewDm(false)
    await loadThreads()
    setSelectedId(d.thread.id)
  }

  const createConversation = async (client: string, topic: string, channelId: string | null) => {
    const r = await fetch('/api/team/conversations', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ client, topic: topic || undefined, channel_id: channelId || undefined }),
    })
    const d = await r.json().catch(() => ({}))
    if (!r.ok) { toast.error(d.error || 'Failed to start conversation'); return }
    setShowNewConversation(false)
    await loadThreads()
    setSelectedId(d.thread.id)
    if (d.reused) toast.info('Opened the existing conversation for this client + topic.')
  }

  // (The whole-conversation kanban status setter was retired with the old board —
  // the Board now tracks THREADS. The PATCH endpoint remains for any future use.)

  const moveToChannel = useCallback(async (threadId: string, channelId: string | null) => {
    setMenuThreadId(null)
    const r = await fetch(`/api/team/threads/${threadId}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ channel_id: channelId }),
    })
    if (!r.ok) { toast.error('Failed to move'); return }
    loadThreads()
  }, [loadThreads])

  const markUnread = useCallback(async (threadId: string) => {
    setMenuThreadId(null)
    setThreads(prev => prev.map(t => t.id === threadId ? { ...t, unread_count: Math.max(1, t.unread_count) } : t))
    await fetch(`/api/team/threads/${threadId}/mark-unread`, { method: 'POST' }).catch(() => {})
    loadThreads()
  }, [loadThreads])

  const toggleLater = useCallback(async (threadId: string, later: boolean) => {
    setMenuThreadId(null)
    setThreads(prev => prev.map(t => t.id === threadId ? { ...t, later } : t))
    await fetch(`/api/team/threads/${threadId}/later`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ later }),
    }).catch(() => {})
    loadThreads()
  }, [loadThreads])

  const setResolution = async (resolution: 'solved' | 'closed' | null) => {
    if (!selected) return
    const r = await fetch(`/api/team/threads/${selected.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ resolution }),
    })
    if (r.ok) loadThreads()
  }

  // Sidebar sections
  const generalThread = threads.find(t => t.thread_type === 'general')
  const channels = threads.filter(t => t.thread_type === 'channel')
  const dms = threads.filter(t => t.thread_type === 'dm')
  const discussions = threads.filter(t => t.thread_type === 'discussion')
  const laterThreads = threads.filter(t => t.later && !t.archived_at)
  const mentionThreads = threads.filter(t => t.mention_count > 0 && !t.archived_at)
  const totalMentions = mentionThreads.reduce((n, t) => n + t.mention_count, 0)
  const unfiledDiscussions = discussions.filter(t => !t.parent_channel_id)

  // Distinct topics present, for the topic filter dropdown.
  const convTopics = useMemo(() => {
    const set = new Set<string>()
    for (const t of unfiledDiscussions) if (t.topic) set.add(t.topic)
    return Array.from(set).sort()
  }, [unfiledDiscussions])

  // Group the (unfiled) client conversations by client, after applying the topic
  // + state filters. Threads arrive newest-activity-first from the RPC, so
  // preserving insertion order gives newest client first AND newest topic first
  // within each group.
  const clientGroups = useMemo(() => {
    const groups = new Map<string, { key: string; label: string; threads: TeamThread[] }>()
    for (const t of unfiledDiscussions) {
      if (!matchesConversationFilter(t, { topic: convTopicFilter, state: convStateFilter })) continue
      const key = t.client_key ?? 'internal'
      const label = t.client_label ?? 'Internal / No client'
      const g = groups.get(key)
      if (g) g.threads.push(t)
      else groups.set(key, { key, label, threads: [t] })
    }
    return Array.from(groups.values())
  }, [unfiledDiscussions, convTopicFilter, convStateFilter])

  // Split the per-client groups into ordered top-level sections by client bucket
  // (Active clients / Leads / Partners / Individuals / Suspended / Cancelled /
  // Off-boarded / Internal). Bucket is server-computed on each thread.
  const convSections = useMemo(() => groupIntoSections(clientGroups), [clientGroups])
  const threadsInChannel = (cid: string) => threads.filter(t => t.thread_type !== 'channel' && t.parent_channel_id === cid)
  const toggleExpand = (cid: string) => setExpandedChannels(prev => { const n = new Set(prev); if (n.has(cid)) n.delete(cid); else n.add(cid); return n })

  const dmLabel = (t: TeamThread): string => {
    if (!t.dm_key || !currentUserId) return t.label
    const otherId = t.dm_key.split(':').find(id => id !== currentUserId) ?? ''
    return members.find(m => m.id === otherId)?.name ?? 'Direct message'
  }
  const labelFor = (t: TeamThread): string =>
    t.thread_type === 'channel' ? `#${t.channel_slug ?? t.label}`
    : t.thread_type === 'dm' ? dmLabel(t)
    : t.thread_type === 'general' ? 'general'
    : t.label

  const pinned = messages.filter(m => m.pinned_at && !m.deleted_at)

  if (view === 'board') {
    return (
      <div className="flex flex-col h-full lg:h-[calc(100%_-_3.5rem)] overflow-hidden">
        <div className="flex items-center gap-3 px-5 py-2 border-b border-zinc-200 bg-white shrink-0">
          <ViewToggle view={view} setView={setView} />
          <span className="text-sm font-semibold text-zinc-800">Team Workspace</span>
          <span className="text-[11px] text-zinc-400">drag a card to change its status</span>
        </div>
        <TeamBoard threads={allThreads}
          onStatusChange={(rootId, status, channelId) => setThreadState(rootId, { status }, channelId)}
          onOpenThread={(threadId, rootId) => openThreadInChannel(threadId, rootId)}
          showArchived={showArchived}
          onToggleArchived={setShowArchived}
          onRestore={(rootId, channelId) => setThreadArchived(rootId, false, channelId)} />
      </div>
    )
  }

  return (
    <div className="flex h-full lg:h-[calc(100%_-_3.5rem)] overflow-hidden">
      {/* Sidebar — full-screen pane on mobile until a conversation is open */}
      <div className={`${(selectedId || selectedSlackId) ? 'hidden md:flex' : 'flex'} w-full md:w-64 md:shrink-0 border-r border-zinc-200 bg-zinc-50 flex-col`}>
        <div className="px-4 py-3 border-b border-zinc-200">
          <div className="flex items-center justify-between">
            <h1 className="text-sm font-semibold text-zinc-900 flex items-center gap-2"><Users className="h-4 w-4" /> Team Workspace</h1>
            <ViewToggle view={view} setView={setView} />
          </div>
          <p className="text-[11px] text-zinc-500">Internal — never visible to clients</p>
        </div>
        <div className="px-3 py-2">
          <div className="relative">
            <Search className="h-3.5 w-3.5 text-zinc-400 absolute left-2 top-1/2 -translate-y-1/2" />
            <input value={searchQ} onChange={e => runSearch(e.target.value)} placeholder="Search messages…"
              className="w-full pl-7 pr-2 py-1.5 text-xs rounded-lg border border-zinc-200 bg-white focus:outline-none focus:ring-1 focus:ring-zinc-300" />
          </div>
        </div>

        <div className="flex-1 overflow-y-auto px-2 pb-4">
          {loadingThreads ? (
            <div className="flex justify-center py-8"><Loader2 className="h-5 w-5 animate-spin text-zinc-400" /></div>
          ) : searchResults !== null ? (
            <div className="mt-2">
              {/* Chats whose NAME matches (Luca's "search client" — instant, client-side) */}
              {(() => {
                const q = searchQ.trim().toLowerCase()
                const nameHits = q.length < 2 ? [] : threads.filter(t => !t.archived_at && labelFor(t).toLowerCase().includes(q)).slice(0, 8)
                return nameHits.length > 0 ? (
                  <>
                    <p className="px-2 text-[11px] font-semibold text-zinc-400 uppercase mb-1">Chats</p>
                    {nameHits.map(t => (
                      <button key={'hit-' + t.id} onClick={() => { setSelectedId(t.id); setSearchQ(''); setSearchResults(null) }}
                        className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-zinc-100 text-left">
                        {t.thread_type === 'channel' ? <Hash className="h-3.5 w-3.5 text-zinc-400 shrink-0" /> : <Building2 className="h-3.5 w-3.5 text-zinc-400 shrink-0" />}
                        <span className="flex-1 truncate text-sm text-zinc-700">{labelFor(t)}</span>
                        <StatusDot status={t.work_status} />
                      </button>
                    ))}
                  </>
                ) : null
              })()}
              <p className="px-2 text-[11px] font-semibold text-zinc-400 uppercase mb-1 mt-2">Messages</p>
              {searchResults.length === 0 ? <p className="px-2 text-xs text-zinc-400">No matches.</p> :
                searchResults.map(r => (
                  <button key={r.id} onClick={() => { setSelectedId(r.thread_id); setSearchQ(''); setSearchResults(null) }}
                    className="w-full text-left px-2 py-1.5 rounded-lg hover:bg-zinc-100">
                    <p className="text-[11px] font-semibold text-zinc-500 truncate">{r.thread_label}</p>
                    <p className="text-xs text-zinc-700 truncate"><span className="font-medium">{r.sender_name}:</span> {r.message}</p>
                  </button>
                ))}
            </div>
          ) : (
            <>
              {mentionThreads.length > 0 && (
                <>
                  <div className="flex items-center justify-between px-2 mt-1 mb-1">
                    <p className="text-[11px] font-semibold text-violet-500 uppercase tracking-wide">Mentions</p>
                    <span className="min-w-[18px] h-[18px] px-1 rounded-full bg-violet-600 text-white text-[10px] font-bold flex items-center justify-center">{totalMentions}</span>
                  </div>
                  {mentionThreads.map(t => (
                    <SidebarThread key={'mention-' + t.id} t={t} selected={selectedId === t.id} onClick={() => setSelectedId(t.id)}
                      icon={<span className="text-violet-500 text-xs font-bold">@</span>} label={labelFor(t)}
                      channels={channels} onMove={moveToChannel} onMarkUnread={markUnread} onToggleLater={toggleLater}
                      menuOpen={menuThreadId === 'mention-' + t.id} onMenuToggle={o => setMenuThreadId(o ? 'mention-' + t.id : null)} />
                  ))}
                </>
              )}

              {(laterThreads.length > 0 || laterRoots.length > 0) && (
                <>
                  <SectionHeader label="Later" />
                  {laterThreads.map(t => (
                    <SidebarThread key={'later-' + t.id} t={t} selected={selectedId === t.id} onClick={() => setSelectedId(t.id)}
                      icon={<Clock className="h-3.5 w-3.5 text-amber-500" />} label={labelFor(t)}
                      channels={channels} onMove={moveToChannel} onMarkUnread={markUnread} onToggleLater={toggleLater}
                      menuOpen={menuThreadId === 'later-' + t.id} onMenuToggle={o => setMenuThreadId(o ? 'later-' + t.id : null)} />
                  ))}
                  {/* Single THREADS brought forward. The Later list deliberately
                      mixes two grains — whole conversations above, individual
                      threads here — so every thread row states the channel it
                      lives in. Mixing grains WITHOUT that label is exactly what
                      made the Board confusing (2026-07-18). */}
                  {laterRoots.map(l => (
                    <button key={'laterRoot-' + l.root_message_id}
                      onClick={() => openThreadInChannel(l.thread_id, l.root_message_id)}
                      className="w-full flex items-start gap-2 px-2 py-1.5 rounded-lg text-left hover:bg-zinc-200/60 group">
                      <Clock className="h-3.5 w-3.5 text-amber-500 shrink-0 mt-0.5" />
                      <span className="flex-1 min-w-0">
                        <span className={cn('block text-sm truncate flex items-center gap-1.5', l.unread ? 'font-semibold text-zinc-900' : 'text-zinc-700')}>
                          {l.unread && <span className="w-2 h-2 rounded-full bg-blue-500 shrink-0" />}{l.title}
                        </span>
                        <span className="block text-[11px] text-zinc-400 truncate">#{l.channel_label} · {TEAM_WORK_STATUS_LABELS[l.status]}</span>
                        {l.read_state && l.read_state !== 'none' && (
                          <TurnBadge state={l.read_state} name={l.waiting_name} className="mt-0.5" />
                        )}
                      </span>
                      <span onClick={e => { e.stopPropagation(); setThreadLater(l.root_message_id, false, l.thread_id) }}
                        title="Remove from Later"
                        className="shrink-0 p-1 rounded text-zinc-300 hover:text-zinc-600 opacity-0 group-hover:opacity-100">
                        <X className="h-3 w-3" />
                      </span>
                    </button>
                  ))}
                </>
              )}

              {generalThread && <ThreadRow t={generalThread} selected={selectedId === generalThread.id} onClick={() => onSelectThread(generalThread.id)} icon={<Hash className="h-3.5 w-3.5" />} label="general" />}

              <SectionHeader label="Channels" onAdd={() => setShowNewChannel(true)} />
              {channels.length === 0 && <p className="px-2 text-[11px] text-zinc-400 mb-2">No channels yet.</p>}
              {channels.map(ch => {
                const filed = threadsInChannel(ch.id)
                const expanded = expandedChannels.has(ch.id)
                return (
                  <div key={ch.id}>
                    <div className="flex items-center">
                      <button onClick={() => toggleExpand(ch.id)} className="p-1 text-zinc-400 hover:text-zinc-700 shrink-0">
                        {filed.length > 0 ? (expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />) : <span className="w-3.5 inline-block" />}
                      </button>
                      <div className="flex-1 min-w-0">
                        <ThreadRow t={ch} selected={selectedId === ch.id} onClick={() => onSelectThread(ch.id)} icon={<Hash className="h-3.5 w-3.5" style={ch.color ? { color: ch.color } : undefined} />} label={ch.channel_slug ?? ch.label} />
                      </div>
                    </div>
                    {expanded && filed.map(t => (
                      <div key={t.id} className="pl-5">
                        <SidebarThread t={t} selected={selectedId === t.id} onClick={() => setSelectedId(t.id)}
                          icon={<Building2 className="h-3 w-3 text-zinc-400" />} label={labelFor(t)}
                          channels={channels} onMove={moveToChannel} onMarkUnread={markUnread} onToggleLater={toggleLater}
                          menuOpen={menuThreadId === t.id} onMenuToggle={o => setMenuThreadId(o ? t.id : null)} />
                      </div>
                    ))}
                  </div>
                )
              })}

              <SectionHeader label="Direct Messages" dot={dms.some(d => d.unread_count > 0)} onAdd={() => setShowNewDm(true)} />
              {dms.length === 0 && <p className="px-2 text-[11px] text-zinc-400 mb-2">No DMs yet.</p>}
              {dms.map(t => <ThreadRow key={t.id} t={t} selected={selectedId === t.id} onClick={() => onSelectThread(t.id)} icon={<span className={cn('w-4 h-4 rounded-full flex items-center justify-center text-[8px] font-bold text-white', senderColor(t.id))}>{initials(dmLabel(t))}</span>} label={dmLabel(t)} />)}

              <SectionHeader label="Conversations" onAdd={() => setShowNewConversation(true)} />

              {/* Topic + state filters */}
              <div className="flex items-center gap-1.5 px-2 pb-1.5">
                <select
                  value={convTopicFilter}
                  onChange={e => setConvTopicFilter(e.target.value)}
                  className="flex-1 min-w-0 text-[11px] border rounded-md px-1.5 py-1 bg-white text-zinc-600 outline-none"
                  title="Filter by topic"
                >
                  <option value="">All topics</option>
                  {convTopics.map(t => <option key={t} value={t}>{t}</option>)}
                </select>
                <select
                  value={convStateFilter}
                  onChange={e => setConvStateFilter(e.target.value as typeof convStateFilter)}
                  className="text-[11px] border rounded-md px-1.5 py-1 bg-white text-zinc-600 outline-none"
                  title="Filter by state"
                >
                  <option value="all">All</option>
                  <option value="open">Open</option>
                  <option value="solved">Solved</option>
                  <option value="closed">Closed</option>
                </select>
              </div>

              {clientGroups.length === 0 && <p className="px-2 text-[11px] text-zinc-400">None.</p>}
              {/* A topic/state filter is active → open every section + group so the
                  narrowed results are visible without clicking each one open. */}
              {(() => { const filtering = convTopicFilter !== '' || convStateFilter !== 'all'; return convSections.map(({ meta, groups }) => {
                const sectionOpen = filtering || expandedBuckets.has(meta.key)
                const sectionUnread = groups.some(g => g.threads.some(t => t.unread_count > 0))
                const convCount = groups.reduce((n, g) => n + g.threads.length, 0)
                return (
                  <div key={meta.key} className="mt-1">
                    <button
                      onClick={() => setExpandedBuckets(prev => {
                        const next = new Set(prev)
                        if (next.has(meta.key)) next.delete(meta.key); else next.add(meta.key)
                        return next
                      })}
                      className="w-full flex items-center gap-1.5 px-2 py-1 text-left"
                    >
                      {sectionOpen ? <ChevronDown className="h-3 w-3 text-zinc-400 shrink-0" /> : <ChevronRight className="h-3 w-3 text-zinc-400 shrink-0" />}
                      <span className="flex-1 text-[11px] font-semibold text-zinc-500 uppercase tracking-wide truncate">{meta.section}</span>
                      {sectionUnread && <span className="w-1.5 h-1.5 rounded-full bg-red-500 shrink-0" title="New activity" />}
                      <span className="text-[10px] text-zinc-400 shrink-0">{convCount}</span>
                    </button>
                    {sectionOpen && groups.map(g => {
                      const open = filtering || expandedClients.has(g.key)
                      const groupUnread = g.threads.some(t => t.unread_count > 0)
                      return (
                        <div key={g.key}>
                          <button
                            onClick={() => setExpandedClients(prev => {
                              const next = new Set(prev)
                              if (next.has(g.key)) next.delete(g.key); else next.add(g.key)
                              return next
                            })}
                            className="w-full flex items-center gap-1.5 px-2 py-1.5 rounded-lg hover:bg-zinc-100 text-left"
                          >
                            {open ? <ChevronDown className="h-3.5 w-3.5 text-zinc-400 shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 text-zinc-400 shrink-0" />}
                            <Building2 className="h-3.5 w-3.5 text-zinc-500 shrink-0" />
                            <span className={cn('flex-1 truncate text-sm', groupUnread ? 'font-semibold text-zinc-900' : 'text-zinc-600')}>{g.label}</span>
                            <span className={cn('px-1.5 py-0.5 rounded text-[9px] font-semibold shrink-0', meta.badgeClass)}>{badgeTextFor(g)}</span>
                            {groupUnread && <span className="w-2 h-2 rounded-full bg-red-500 shrink-0" title="New activity" />}
                            <span className="text-[10px] text-zinc-400 shrink-0">{g.threads.length}</span>
                          </button>
                          {open && g.threads.map(t => (
                            <div key={t.id} className="ml-4">
                              <SidebarThread t={t} selected={selectedId === t.id} onClick={() => setSelectedId(t.id)}
                                icon={<span className={cn('w-1.5 h-1.5 rounded-full shrink-0', t.unread_count > 0 ? 'bg-red-500' : 'bg-zinc-300')} />}
                                label={t.topic || 'General'} resolved={!!t.resolved_at}
                                channels={channels} onMove={moveToChannel} onMarkUnread={markUnread} onToggleLater={toggleLater}
                                menuOpen={menuThreadId === t.id} onMenuToggle={o => setMenuThreadId(o ? t.id : null)} />
                            </div>
                          ))}
                        </div>
                      )
                    })}
                  </div>
                )
              }) })()}

              {slackEnabled && (
                <>
                  <div className="flex items-center gap-1 px-2 mt-4 mb-1">
                    <Slack className="h-3 w-3 text-zinc-400" />
                    <p className="text-[11px] font-semibold text-zinc-400 uppercase tracking-wide">Slack</p>
                  </div>
                  {slackChannels.length === 0 && <p className="px-2 text-[11px] text-zinc-400">No channels synced yet.</p>}
                  {slackChannels.map(c => (
                    <button key={c.id} onClick={() => selectSlack(c.id)} className={cn('w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-left', selectedSlackId === c.id ? 'bg-zinc-200' : 'hover:bg-zinc-100')}>
                      <Hash className="h-3.5 w-3.5 text-zinc-500 shrink-0" />
                      <span className="flex-1 truncate text-sm text-zinc-600">{c.name ?? c.id}</span>
                    </button>
                  ))}
                </>
              )}
            </>
          )}
        </div>
      </div>

      {/* Main pane — hidden on mobile until a conversation is open */}
      <div className={`${(selectedId || selectedSlackId) ? 'flex' : 'hidden md:flex'} flex-1 flex-col min-w-0`}>
        {(selectedId || selectedSlackId) && (
          <button
            onClick={() => { setSelectedId(null); setSelectedSlackId(null) }}
            className="md:hidden flex items-center gap-1.5 px-4 py-2 text-sm text-zinc-600 border-b border-zinc-200 bg-white shrink-0"
          >
            <ChevronLeft className="h-4 w-4" />
            All conversations
          </button>
        )}
        {selectedSlackId ? (
          <SlackFeedView channel={slackChannels.find(c => c.id === selectedSlackId) ?? null} channelId={selectedSlackId} messages={slackMessages} loading={loadingSlack} />
        ) : !selected ? (
          <div className="flex-1 flex flex-col items-center justify-center text-zinc-400 gap-2">
            <MessageSquare className="h-10 w-10" />
            <p className="text-sm">Select a channel or conversation</p>
          </div>
        ) : (
          <>
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-3 border-b border-zinc-200 bg-white shrink-0">
              <div className="min-w-0">
                <h2 className="text-sm font-semibold text-zinc-900 flex items-center gap-2 truncate">
                  {selected.thread_type === 'channel' && <Hash className="h-4 w-4" style={selected.color ? { color: selected.color } : undefined} />}
                  {selected.thread_type === 'dm' && <MessageSquare className="h-4 w-4" />}
                  {selected.thread_type === 'discussion' && <Building2 className="h-4 w-4" />}
                  {selected.thread_type === 'channel' ? (selected.channel_slug ?? selected.label) : selected.thread_type === 'dm' ? dmLabel(selected) : selected.label}
                </h2>
                {selected.description && <p className="text-[11px] text-zinc-500 truncate">{selected.description}</p>}
              </div>
              {isThreadedChannel && (
                <div className="flex items-center gap-2 shrink-0">
                  <button
                    onClick={() => setShowNewThread(true)}
                    className="text-xs px-2.5 py-1 rounded-full border bg-white border-zinc-200 text-zinc-600 hover:bg-zinc-50 flex items-center gap-1"
                    title="Start a new thread on a topic"
                  >
                    <Plus className="h-3.5 w-3.5" /> New thread
                  </button>
                  <button
                    onClick={() => { setShowThreadsPanel(v => !v); setOpenRootId(null) }}
                    className={cn('text-xs px-2.5 py-1 rounded-full border flex items-center gap-1.5',
                      showThreadsPanel ? 'bg-zinc-800 text-white border-zinc-800' : 'bg-white border-zinc-200 text-zinc-600 hover:bg-zinc-50')}
                    title="Manage this channel's threads by status"
                  >
                    <ListIcon className="h-3.5 w-3.5" /> Threads
                    {threadsList.some(t => t.following && t.unread) && <span className="w-1.5 h-1.5 rounded-full bg-blue-500" />}
                  </button>
                </div>
              )}
              {selected.thread_type === 'discussion' && (
                selected.resolution === 'solved' ? (
                  <button onClick={() => setResolution(null)} title="Reopen this conversation" className="text-xs px-2.5 py-1 rounded-full border flex items-center gap-1 bg-emerald-50 border-emerald-200 text-emerald-700">
                    <Check className="h-3 w-3" /> Solved
                  </button>
                ) : selected.resolution === 'closed' ? (
                  <button onClick={() => setResolution(null)} title="Reopen this conversation" className="text-xs px-2.5 py-1 rounded-full border flex items-center gap-1 bg-zinc-100 border-zinc-300 text-zinc-500">
                    <X className="h-3 w-3" /> Closed
                  </button>
                ) : (
                  <div className="flex items-center gap-1.5">
                    <button onClick={() => setResolution('solved')} title="Mark the work done" className="text-xs px-2.5 py-1 rounded-full border flex items-center gap-1 bg-white border-emerald-200 text-emerald-700 hover:bg-emerald-50">
                      <Check className="h-3 w-3" /> Solved
                    </button>
                    <button onClick={() => setResolution('closed')} title="Drop this — no action needed" className="text-xs px-2.5 py-1 rounded-full border flex items-center gap-1 bg-white border-zinc-200 text-zinc-600 hover:bg-zinc-50">
                      <X className="h-3 w-3" /> Closed
                    </button>
                  </div>
                )
              )}
            </div>

            {/* Pinned bar */}
            {pinned.length > 0 && (
              <div className="shrink-0 px-5 py-2 bg-amber-50 border-b border-amber-100">
                {pinned.map(p => (
                  <div key={p.id} className="flex items-center gap-2 text-xs text-amber-800">
                    <Pin className="h-3 w-3 shrink-0" />
                    <span className="font-medium">{p.sender_name}:</span>
                    <span className="truncate">{p.message.slice(0, 120)}</span>
                  </div>
                ))}
              </div>
            )}

            <WorkerDropZone onFiles={addPendingFiles} disabled={sending || uploading || !!editing} label="Drop to attach" className="flex-1 flex flex-col min-h-0">
            {/* Messages + optional Slack-style thread pane */}
            <div className="flex-1 flex min-h-0">
              {/* Channel stream (roots only in threaded channels) — hidden on
                  mobile while a thread pane is open */}
              <div className={cn('flex-1 overflow-y-auto px-4 py-4 space-y-1', isThreadedChannel && openRootId && 'hidden')}>
                {loadingMsgs ? (
                  <div className="flex justify-center py-8"><Loader2 className="h-6 w-6 animate-spin text-zinc-400" /></div>
                ) : streamMessages.length === 0 ? (
                  <div className="flex flex-col items-center justify-center h-full text-zinc-400 gap-2">
                    <MessageSquare className="h-9 w-9" /><p className="text-sm">No messages yet.</p>
                  </div>
                ) : (
                  streamMessages.map(m => {
                    const meta = isThreadedChannel ? threadMeta[m.id] : undefined
                    return (
                      <div key={m.id}>
                        <MessageRow m={m} isMe={m.sender_id === currentUserId} isClaude={m.sender_id === CLAUDE_SENDER_UUID}
                          canDelete={m.sender_id === currentUserId || isAdmin} currentUserId={currentUserId}
                          onReply={() => { if (isThreadedChannel) { openThread(m.root_id ?? m.id) } else { setReplyTo(m); inputRef.current?.focus() } }}
                          onEdit={() => { setEditing(m); setText(m.message); inputRef.current?.focus() }}
                          onDelete={() => deleteMsg(m)} onPin={() => togglePin(m)}
                          onReact={emoji => toggleReaction(m.id, emoji)}
                          reactOpen={reactFor === m.id} setReactOpen={open => setReactFor(open ? m.id : null)}
                          touchMenu={touchMenuFor === m.id} setTouchMenu={open => setTouchMenuFor(open ? m.id : null)}
                        onMarkUnreadFromHere={openRootId ? () => markThreadUnread(openRootId, m.id) : undefined} />
                        {meta && meta.reply_count > 0 && (
                          <button onClick={() => openThread(m.id)} className={cn('ml-11 mb-1 flex items-center gap-2 text-xs text-blue-600 hover:underline', meta.unread ? 'font-bold' : 'font-medium')}>
                            {meta.unread && <span className="w-2 h-2 rounded-full bg-blue-500" />}
                            <MessageSquare className="h-3.5 w-3.5" />
                            {meta.reply_count} {meta.reply_count === 1 ? 'reply' : 'replies'}
                            <span className="text-zinc-400 font-normal">· last reply {format(new Date(meta.last_reply_at), 'MMM d, HH:mm')}</span>
                            <TurnBadge state={meta.read_state} name={meta.waiting_name} />
                          </button>
                        )}
                      </div>
                    )
                  })
                )}
                <div ref={bottomRef} />
              </div>

              {/* Thread view: takes over the whole main area as a full-width
                  drill-in (the channel stream steps aside) — the back arrow
                  returns to the thread list. Lives entirely inside Team Workspace
                  (no browser navigation). Mobile already did this; desktop now
                  matches instead of the old cramped resizable split pane. */}
              {isThreadedChannel && openRootId && (
                <div
                  className="flex-1 border-zinc-200 flex flex-col min-h-0 bg-white"
                  onPointerDown={onPaneEngagement}
                  onKeyDown={onPaneEngagement}
                  onWheel={onPaneEngagement}
                >
                  <div className="shrink-0 flex items-center justify-between px-4 py-2.5 border-b border-zinc-200">
                    {/* The thread's NAME is the header — renaming it here is the
                        obvious place to look for it. The back arrow returns to
                        the channel's list of threads. */}
                    <span className="text-sm font-semibold text-zinc-800 flex items-center gap-1.5 min-w-0">
                      <button onClick={backFromThread} className="p-1 -ml-1 rounded-full text-zinc-500 hover:bg-zinc-100 shrink-0" title="Back to threads" aria-label="Back to threads">
                        <ChevronLeft className="h-4 w-4" />
                      </button>
                      <MessageSquare className="h-4 w-4 shrink-0" />
                      <span className="truncate">{threadsList.find(t => t.root_id === openRootId)?.title ?? 'Thread'}</span>
                    </span>
                    <div className="flex items-center gap-2 shrink-0">
                      {/* Follow bell — follow/unfollow this thread from inside it. */}
                      {(() => { const ti = threadsList.find(t => t.root_id === openRootId); const following = ti?.following ?? false; return (
                        <button onClick={() => { if (openRootId) setThreadFollow(openRootId, !following) }}
                          className={cn('p-1 rounded-full', following ? 'text-blue-600 hover:bg-blue-50' : 'text-zinc-400 hover:bg-zinc-100')}
                          title={following ? 'Following — click to unfollow' : 'Follow this thread'}>
                          {following ? <Bell className="h-4 w-4" /> : <BellOff className="h-4 w-4" />}
                        </button>
                      ) })()}
                      {/* Status control — set Working / Pending / Done from inside the thread. */}
                      <div className="relative">
                        <button onClick={() => setPaneStatusMenu(v => !v)}
                          className={cn('text-[10px] font-medium px-2 py-0.5 rounded-full border', TEAM_STATUS_COLORS[(threadMeta[openRootId]?.status ?? 'todo') as TeamWorkStatus].pill)}>
                          {TEAM_WORK_STATUS_LABELS[(threadMeta[openRootId]?.status ?? 'todo') as TeamWorkStatus]}
                        </button>
                        {paneStatusMenu && (
                          <div className="absolute top-full right-0 mt-1 w-32 bg-white border border-zinc-200 rounded-lg shadow-lg z-40 py-1">
                            {TEAM_WORK_STATUSES.map(s => (
                              <button key={s} onClick={() => { if (openRootId) setThreadState(openRootId, { status: s }); setPaneStatusMenu(false) }}
                                className="w-full flex items-center gap-2 px-2.5 py-1.5 text-xs text-left hover:bg-zinc-100">
                                <span className={cn('w-2 h-2 rounded-full', TEAM_STATUS_COLORS[s].dot)} />{TEAM_WORK_STATUS_LABELS[s]}
                                {(threadMeta[openRootId]?.status ?? 'todo') === s && <Check className="h-3 w-3 ml-auto text-zinc-400" />}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                      {/* Rename / Archive / Delete — same menu as the panel row. */}
                      {(() => {
                        const ti = threadsList.find(t => t.root_id === openRootId)
                        return ti ? (
                          <ThreadActionsMenu thread={ti} channelId={selectedId!} currentUserId={currentUserId}
                            onRename={(rid, title) => renameThread(rid, title)}
                            onArchive={(rid, archived) => setThreadArchived(rid, archived)}
                            onDelete={rid => deleteThread(rid)}
                            onLater={(rid, later) => setThreadLater(rid, later)}
                            onMarkUnread={rid => markThreadUnread(rid)} />
                        ) : null
                      })()}
                      <button onClick={backFromThread} className="p-1 rounded-full text-zinc-400 hover:bg-zinc-100" title="Close thread"><X className="h-4 w-4" /></button>
                    </div>
                  </div>
                  {/* Comfortable centered reading column so a full-width thread
                      doesn't stretch edge-to-edge on a wide monitor. */}
                  <div className="flex-1 overflow-y-auto px-4 py-4">
                    <div className="mx-auto w-full max-w-3xl space-y-1">
                    {paneRoot ? (
                      <MessageRow m={paneRoot} isMe={paneRoot.sender_id === currentUserId} isClaude={paneRoot.sender_id === CLAUDE_SENDER_UUID}
                        canDelete={paneRoot.sender_id === currentUserId || isAdmin} currentUserId={currentUserId}
                        onReply={() => { setReplyTo(paneRoot); inputRef.current?.focus() }}
                        onEdit={() => { setEditing(paneRoot); setText(paneRoot.message); inputRef.current?.focus() }}
                        onDelete={() => deleteMsg(paneRoot)} onPin={() => togglePin(paneRoot)}
                        onReact={emoji => toggleReaction(paneRoot.id, emoji)}
                        reactOpen={reactFor === paneRoot.id} setReactOpen={open => setReactFor(open ? paneRoot.id : null)}
                        touchMenu={touchMenuFor === paneRoot.id} setTouchMenu={open => setTouchMenuFor(open ? paneRoot.id : null)}
                        onMarkUnreadFromHere={openRootId ? () => markThreadUnread(openRootId, paneRoot.id) : undefined} />
                    ) : (
                      <div className="text-xs text-zinc-400 py-4 text-center">This thread&apos;s original message isn&apos;t loaded.</div>
                    )}
                    {paneReplies.length > 0 && (
                      <div className="text-[11px] text-zinc-400 border-b border-zinc-100 pb-1 mb-1">{paneReplies.length} {paneReplies.length === 1 ? 'reply' : 'replies'}</div>
                    )}
                    {paneReplies.map(m => (
                      <MessageRow key={m.id} m={m} isMe={m.sender_id === currentUserId} isClaude={m.sender_id === CLAUDE_SENDER_UUID}
                        canDelete={m.sender_id === currentUserId || isAdmin} currentUserId={currentUserId}
                        onReply={() => { setReplyTo(m); inputRef.current?.focus() }}
                        onEdit={() => { setEditing(m); setText(m.message); inputRef.current?.focus() }}
                        onDelete={() => deleteMsg(m)} onPin={() => togglePin(m)}
                        onReact={emoji => toggleReaction(m.id, emoji)}
                        reactOpen={reactFor === m.id} setReactOpen={open => setReactFor(open ? m.id : null)}
                        touchMenu={touchMenuFor === m.id} setTouchMenu={open => setTouchMenuFor(open ? m.id : null)}
                        onMarkUnreadFromHere={openRootId ? () => markThreadUnread(openRootId, m.id) : undefined} />
                    ))}
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Thread-reply mode: the shared composer posts into the open thread */}
            {isThreadedChannel && openRootId && !replyTo && !editing && (
              <div className="shrink-0 px-4 py-2 border-t border-zinc-100 bg-blue-50 flex items-center gap-2">
                <MessageSquare className="h-4 w-4 text-blue-500 shrink-0" />
                <p className="flex-1 min-w-0 text-[11px] font-semibold text-blue-700 truncate">Replying in thread{paneRoot ? ` — ${paneRoot.sender_name}: ${paneRoot.message.slice(0, 50)}` : ''}</p>
                <button onClick={closeThread} className="p-1 rounded-full text-blue-400 hover:bg-blue-100"><X className="h-3.5 w-3.5" /></button>
              </div>
            )}

            {/* Reply / edit bar */}
            {(replyTo || editing) && (
              <div className="shrink-0 px-4 py-2 border-t border-zinc-100 bg-zinc-50 flex items-center gap-2">
                {editing ? <Pencil className="h-4 w-4 text-zinc-400" /> : <CornerUpLeft className="h-4 w-4 text-zinc-400" />}
                <div className="flex-1 min-w-0">
                  <p className="text-[11px] font-semibold text-zinc-500">{editing ? 'Editing message' : `Replying to ${replyTo?.sender_name}`}</p>
                  <p className="text-xs text-zinc-600 truncate">{(editing ?? replyTo)?.message.slice(0, 90) || '📎 Attachment'}</p>
                </div>
                <button onClick={() => { setReplyTo(null); setEditing(null); if (editing) setText('') }} className="p-1 rounded-full text-zinc-400 hover:bg-zinc-200"><X className="h-3.5 w-3.5" /></button>
              </div>
            )}

            {/* File strip */}
            {pendingFiles.length > 0 && (
              <div className="shrink-0 px-4 py-2 border-t border-zinc-100 bg-zinc-50 flex flex-wrap gap-2">
                {pendingFiles.map((f, i) => (
                  <div key={i} className="flex items-center gap-2 bg-white border border-zinc-200 rounded-lg px-2 py-1.5 max-w-[200px]">
                    <FileText className="h-4 w-4 text-zinc-400 shrink-0" />
                    <div className="min-w-0"><p className="text-[11px] font-medium text-zinc-700 truncate">{f.name}</p><p className="text-[10px] text-zinc-400">{fileSize(f.size)}</p></div>
                    <button onClick={() => setPendingFiles(p => p.filter((_, x) => x !== i))} className="p-0.5 text-zinc-400 hover:text-zinc-600"><X className="h-3 w-3" /></button>
                  </div>
                ))}
              </div>
            )}

            {/* Composer */}
            <div className="shrink-0 px-4 py-3 border-t border-zinc-200 bg-white relative">
              {/* Slash-command menu — type "/" to see it */}
              {commandCandidates.length > 0 && (
                <div className="absolute bottom-full left-4 mb-1 w-72 bg-white border border-zinc-200 rounded-lg shadow-lg overflow-hidden z-30">
                  {commandCandidates.map((c, i) => (
                    <button key={c.key} onClick={() => runCommand(c)} className={cn('w-full flex items-center justify-between px-3 py-2 text-left hover:bg-zinc-100', i === 0 && 'bg-zinc-50')}>
                      <span className="text-sm text-zinc-800">{c.label}</span>
                      <span className="text-[10px] text-zinc-400">/{c.key} — {c.hint}</span>
                    </button>
                  ))}
                  <p className="px-3 py-1 text-[10px] text-zinc-400 border-t border-zinc-100">Enter runs the first · Esc dismisses</p>
                </div>
              )}
              {/* Mention autocomplete */}
              {mentionQuery !== null && mentionCandidates.length > 0 && (
                <div className="absolute bottom-full left-4 mb-1 w-64 bg-white border border-zinc-200 rounded-lg shadow-lg overflow-hidden z-30">
                  {mentionCandidates.map(c => (
                    <button key={c.id} onClick={() => insertMention(c.handle)} className="w-full flex items-center gap-2 px-3 py-2 hover:bg-zinc-100 text-left">
                      {c.role === 'ai' ? <span className="w-6 h-6 rounded-full bg-violet-600 flex items-center justify-center"><Bot className="h-3.5 w-3.5 text-white" /></span>
                        : <span className={cn('w-6 h-6 rounded-full flex items-center justify-center text-[9px] font-bold text-white', senderColor(c.id))}>{initials(c.name)}</span>}
                      <div><p className="text-xs font-medium text-zinc-800">{c.name}</p><p className="text-[10px] text-zinc-400">@{c.handle}</p></div>
                    </button>
                  ))}
                </div>
              )}
              <div className="flex items-end gap-2">
                <div className="flex items-end flex-1 min-w-0 bg-white border border-zinc-200 rounded-[24px] px-1 py-1 gap-0.5 min-h-[48px]">
                  <div className="relative shrink-0" ref={emojiRef}>
                    <button onClick={() => setShowEmoji(v => !v)} className="p-2 rounded-full text-zinc-400 hover:bg-zinc-100"><Smile className="h-5 w-5" /></button>
                    {showEmoji && (
                      <div className="absolute bottom-12 left-0 z-30">
                        <EmojiPicker onEmojiClick={(e: { emoji: string }) => { setText(t => t + e.emoji); setShowEmoji(false) }} width={320} height={380} lazyLoadEmojis skinTonesDisabled previewConfig={{ showPreview: false }} />
                      </div>
                    )}
                  </div>
                  <button onClick={() => fileRef.current?.click()} disabled={uploading} className={cn('p-2 rounded-full shrink-0', pendingFiles.length ? 'text-blue-600 bg-blue-100' : 'text-zinc-400 hover:bg-zinc-100')}>
                    {uploading ? <Loader2 className="h-5 w-5 animate-spin" /> : <Paperclip className="h-5 w-5" />}
                  </button>
                  <input ref={fileRef} type="file" multiple onChange={e => { addPendingFiles(Array.from(e.target.files ?? [])); e.target.value = '' }} className="hidden" />
                  <textarea ref={inputRef} value={text} onChange={e => onTextChange(e.target.value)}
                    onPaste={handlePaste}
                    onKeyDown={e => {
                      if (e.key === 'Enter' && !e.shiftKey) {
                        if (commandCandidates.length > 0) { e.preventDefault(); runCommand(commandCandidates[0]); return }
                        if (mentionQuery === null) { e.preventDefault(); handleSend() }
                      }
                      if (e.key === 'Escape' && commandQuery !== null) setCommandQuery(null)
                    }}
                    placeholder={editing ? 'Edit message…' : isRecording ? 'Recording…' : (isThreadedChannel && openRootId) ? 'Reply in thread…' : `Message ${selected.thread_type === 'channel' ? '#' + (selected.channel_slug ?? '') : selected.thread_type === 'dm' ? dmLabel(selected) : selected.label}… (@ to mention · @claude for AI · / for commands)`}
                    rows={1} className="flex-1 min-w-0 px-1 py-2.5 text-base bg-transparent border-none focus:outline-none resize-none max-h-[240px] placeholder:text-zinc-400" />
                </div>
                {sending || uploading ? (
                  <button disabled className="w-12 h-12 rounded-full bg-zinc-800 text-white flex items-center justify-center shrink-0"><Loader2 className="h-5 w-5 animate-spin" /></button>
                ) : (text.trim() || pendingFiles.length) ? (
                  <button onClick={handleSend} className="w-12 h-12 rounded-full bg-zinc-800 text-white hover:bg-zinc-700 flex items-center justify-center shrink-0">{editing ? <Check className="h-5 w-5" /> : <Send className="h-5 w-5" />}</button>
                ) : voiceSupported ? (
                  <button onPointerDown={startRecording} onPointerUp={stopRecording} className={cn('w-12 h-12 rounded-full flex items-center justify-center shrink-0', isRecording ? 'bg-red-500 text-white animate-pulse' : isTranscribing ? 'bg-violet-500 text-white' : 'bg-zinc-100 text-zinc-600 hover:bg-zinc-200')}>
                    {isTranscribing ? <Loader2 className="h-5 w-5 animate-spin" /> : isRecording ? <MicOff className="h-5 w-5" /> : <Mic className="h-5 w-5" />}
                  </button>
                ) : null}
              </div>
            </div>

            {/* Threads management panel — overlays the channel, stays inside Team
                Workspace. Opening a thread closes it and opens that thread's pane. */}
            {isThreadedChannel && showThreadsPanel && (
              <div className="absolute inset-0 z-30 bg-white flex flex-col">
                <ThreadsPanel
                  channelId={selectedId!}
                  channelName={selected.channel_slug ?? selected.label}
                  threads={threadsList}
                  members={members}
                  onClose={() => setShowThreadsPanel(false)}
                  onOpen={(rid) => { setShowThreadsPanel(false); openThread(rid) }}
                  onSetStatus={(rid, status) => setThreadState(rid, { status })}
                  onSetAssignee={(rid, aid) => setThreadState(rid, { assignee_id: aid })}
                  onSetFollow={(rid, f) => setThreadFollow(rid, f)}
                  currentUserId={currentUserId}
                  showArchived={showArchived}
                  onToggleArchived={setShowArchived}
                  onRename={(rid, title) => renameThread(rid, title)}
                  onArchive={(rid, archived) => setThreadArchived(rid, archived)}
                  onDelete={rid => deleteThread(rid)}
                  onLater={(rid, later) => setThreadLater(rid, later)}
                  onMarkUnread={rid => markThreadUnread(rid)}
                />
              </div>
            )}
            </WorkerDropZone>
          </>
        )}
      </div>

      {showNewChannel && <NewChannelModal onClose={() => setShowNewChannel(false)} onCreate={createChannel} />}
      {showNewDm && <NewDmModal members={members.filter(m => m.id !== currentUserId)} onClose={() => setShowNewDm(false)} onPick={startDm} />}
      {showNewConversation && <NewConversationModal channels={channels} generalThread={generalThread ?? null} onClose={() => setShowNewConversation(false)} onCreate={createConversation} />}
      {showNewThread && <NewThreadModal channelName={selected ? (selected.channel_slug ?? selected.label) : ''} onClose={() => setShowNewThread(false)} onCreate={createThread} />}
    </div>
  )
}

const THREAD_STAGE_FILTERS: { key: string; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'new', label: 'New' },
  { key: 'todo', label: 'Open' },
  { key: 'in_progress', label: 'Working' },
  { key: 'waiting', label: 'Pending' },
  { key: 'handled', label: 'Done' },
]

function NewThreadModal({ channelName, onClose, onCreate }: {
  channelName: string
  onClose: () => void
  onCreate: (title: string, note: string) => Promise<void>
}) {
  const [title, setTitle] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const submit = async () => {
    if (!title.trim() || busy) return
    setBusy(true)
    try { await onCreate(title.trim(), note.trim()) } finally { setBusy(false) }
  }
  return (
    <div className="fixed inset-0 z-50 bg-black/30 flex items-center justify-center p-4" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md p-4" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-semibold text-zinc-900">New thread in #{channelName}</h3>
          <button onClick={onClose} className="p-1 rounded-full text-zinc-400 hover:bg-zinc-100"><X className="h-4 w-4" /></button>
        </div>
        <label className="block text-[11px] font-semibold text-zinc-500 mb-1">Topic</label>
        <input autoFocus value={title} onChange={e => setTitle(e.target.value)} maxLength={200}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit() } }}
          placeholder="e.g. Problem with Inbox"
          className="w-full text-sm border border-zinc-200 rounded-lg px-3 py-2 mb-3 focus:outline-none focus:border-zinc-400" />
        <label className="block text-[11px] font-semibold text-zinc-500 mb-1">First message (optional)</label>
        <textarea value={note} onChange={e => setNote(e.target.value)} rows={3}
          placeholder="Add detail — screenshots can be dropped in once it's open."
          className="w-full text-sm border border-zinc-200 rounded-lg px-3 py-2 resize-none focus:outline-none focus:border-zinc-400" />
        <div className="flex justify-end gap-2 mt-3">
          <button onClick={onClose} className="text-xs px-3 py-1.5 rounded-lg border border-zinc-200 text-zinc-600 hover:bg-zinc-50">Cancel</button>
          <button onClick={submit} disabled={!title.trim() || busy}
            className="text-xs px-3 py-1.5 rounded-lg bg-zinc-800 text-white hover:bg-zinc-700 disabled:opacity-50 flex items-center gap-1.5">
            {busy && <Loader2 className="h-3 w-3 animate-spin" />} Start thread
          </button>
        </div>
      </div>
    </div>
  )
}

function ThreadsPanel({ channelId, channelName, threads, members, currentUserId, showArchived, onToggleArchived, onClose, onOpen, onSetStatus, onSetAssignee, onSetFollow, onRename, onArchive, onDelete, onLater, onMarkUnread }: {
  channelId: string
  channelName: string
  threads: ThreadListItem[]
  members: TeamMember[]
  currentUserId: string | null
  showArchived: boolean
  onToggleArchived: (show: boolean) => void
  onClose: () => void
  onOpen: (rootId: string) => void
  onSetStatus: (rootId: string, status: TeamWorkStatus) => void
  onSetAssignee: (rootId: string, assigneeId: string | null) => void
  onSetFollow: (rootId: string, follow: boolean) => void
  onRename: (rootId: string, title: string) => void
  onArchive: (rootId: string, archived: boolean) => void
  onDelete: (rootId: string) => void
  onLater: (rootId: string, later: boolean) => void
  onMarkUnread: (rootId: string) => void
}) {
  const [stage, setStage] = useState<string>('all')
  const [followingOnly, setFollowingOnly] = useState(false)
  const [menu, setMenu] = useState<string | null>(null)
  // Stage filter: 'all' = everything, 'new' = unread only, a status = only
  // threads actually in that status. Plus a Following-only view. Archived
  // threads are out unless the archive view is on — and then they are ALL
  // you see, so restoring one is a short list, not a hunt.
  const filtered = sortPanelThreads(threads, false).filter(t => {
    if (showArchived !== !!t.archived) return false
    if (followingOnly && !t.following) return false
    if (stage === 'all') return true
    if (stage === 'new') return t.unread
    return t.status === stage
  })
  const nameFor = (id: string | null) => (id ? (members.find(m => m.id === id)?.name ?? 'Unknown') : null)

  return (
    <>
      <div className="shrink-0 flex items-center justify-between px-4 py-2.5 border-b border-zinc-200">
        <span className="text-sm font-semibold text-zinc-800 flex items-center gap-1.5"><ListIcon className="h-4 w-4" /> Threads in #{channelName}</span>
        <button onClick={onClose} className="p-1 rounded-full text-zinc-400 hover:bg-zinc-100" title="Back to messages"><X className="h-4 w-4" /></button>
      </div>
      {/* Filter bar */}
      <div className="shrink-0 flex items-center gap-1.5 px-3 py-2 border-b border-zinc-100 overflow-x-auto">
        {THREAD_STAGE_FILTERS.map(f => (
          <button key={f.key} onClick={() => setStage(f.key)}
            className={cn('text-[11px] px-2.5 py-1 rounded-full border whitespace-nowrap', stage === f.key ? 'bg-zinc-800 text-white border-zinc-800' : 'bg-white border-zinc-200 text-zinc-600 hover:bg-zinc-50')}>
            {f.label}
          </button>
        ))}
        <button onClick={() => setFollowingOnly(v => !v)}
          className={cn('ml-auto text-[11px] px-2.5 py-1 rounded-full border flex items-center gap-1 whitespace-nowrap', followingOnly ? 'bg-blue-50 text-blue-700 border-blue-200' : 'bg-white border-zinc-200 text-zinc-600 hover:bg-zinc-50')}>
          <Bell className="h-3 w-3" /> Following
        </button>
        <button onClick={() => onToggleArchived(!showArchived)}
          className={cn('text-[11px] px-2.5 py-1 rounded-full border flex items-center gap-1 whitespace-nowrap', showArchived ? 'bg-amber-50 text-amber-700 border-amber-200' : 'bg-white border-zinc-200 text-zinc-600 hover:bg-zinc-50')}
          title={showArchived ? 'Back to active threads' : 'Show archived threads'}>
          <Archive className="h-3 w-3" /> Archived
        </button>
      </div>
      <div className="flex-1 overflow-y-auto p-3 space-y-1.5" onClick={() => setMenu(null)}>
        {filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-zinc-400 gap-2">
            {showArchived ? <><Archive className="h-9 w-9" /><p className="text-sm">No archived threads here.</p></>
              : <><MessageSquare className="h-9 w-9" /><p className="text-sm">No threads here. Reply on a message to start one.</p></>}
          </div>
        ) : filtered.map(t => {
          const assignee = nameFor(t.assignee_id)
          return (
            <div key={t.root_id} className={cn('flex items-center gap-2 rounded-lg border bg-white px-2.5 py-2', t.unread ? 'border-blue-200' : 'border-zinc-200 hover:border-zinc-300')}>
              <div className="relative shrink-0" onClick={e => e.stopPropagation()}>
                <button onClick={() => setMenu(menu === `${t.root_id}:s` ? null : `${t.root_id}:s`)}
                  className={cn('text-[10px] font-medium px-2 py-0.5 rounded-full border', TEAM_STATUS_COLORS[t.status].pill)}>
                  {TEAM_WORK_STATUS_LABELS[t.status]}
                </button>
                {menu === `${t.root_id}:s` && (
                  <div className="absolute top-full left-0 mt-1 w-32 bg-white border border-zinc-200 rounded-lg shadow-lg z-40 py-1">
                    {TEAM_WORK_STATUSES.map(s => (
                      <button key={s} onClick={() => { onSetStatus(t.root_id, s); setMenu(null) }} className="w-full flex items-center gap-2 px-2.5 py-1.5 text-xs text-left hover:bg-zinc-100">
                        <span className={cn('w-2 h-2 rounded-full', TEAM_STATUS_COLORS[s].dot)} />{TEAM_WORK_STATUS_LABELS[s]}{t.status === s && <Check className="h-3 w-3 ml-auto text-zinc-400" />}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              {/* Unread thread = bold title + a blue dot for instant identification. */}
              <button onClick={() => onOpen(t.root_id)} className="flex-1 min-w-0 text-left">
                <p className={cn('text-sm truncate flex items-center gap-1.5', t.unread ? 'font-semibold text-zinc-900' : 'text-zinc-800')}>
                  {t.unread && <span className="w-2 h-2 rounded-full bg-blue-500 shrink-0" />}{t.title}
                </p>
                <p className="text-[11px] text-zinc-400 truncate flex items-center gap-1.5">
                  <span className="truncate">{t.sender_name ? `${t.sender_name} · ` : ''}{t.reply_count} {t.reply_count === 1 ? 'reply' : 'replies'}{t.last_reply_at ? ` · ${format(new Date(t.last_reply_at), 'MMM d, HH:mm')}` : ''}</span>
                  <TurnBadge state={t.read_state} name={t.waiting_name} className="shrink-0" />
                </p>
                {t.archived && (
                  <p className="text-[11px] text-amber-600 truncate flex items-center gap-1">
                    <Archive className="h-3 w-3 shrink-0" />
                    Archived{t.archived_by ? ` by ${nameFor(t.archived_by) ?? 'someone'}` : ''}{t.archived_at ? ` · ${format(new Date(t.archived_at), 'MMM d, HH:mm')}` : ''}
                  </p>
                )}
              </button>
              {/* Follow bell */}
              <button onClick={e => { e.stopPropagation(); onSetFollow(t.root_id, !t.following) }}
                className={cn('shrink-0 p-1 rounded-full', t.following ? 'text-blue-600 hover:bg-blue-50' : 'text-zinc-300 hover:text-zinc-500 hover:bg-zinc-100')}
                title={t.following ? 'Following — click to unfollow' : 'Follow this thread'}>
                {t.following ? <Bell className="h-3.5 w-3.5" /> : <BellOff className="h-3.5 w-3.5" />}
              </button>
              <div className="relative shrink-0" onClick={e => e.stopPropagation()}>
                <button onClick={() => setMenu(menu === `${t.root_id}:a` ? null : `${t.root_id}:a`)} className="text-[10px] px-1.5 py-0.5 rounded-full border border-zinc-200 text-zinc-500 hover:bg-zinc-50">
                  {assignee ? assignee.split(' ')[0] : '+ Assign'}
                </button>
                {menu === `${t.root_id}:a` && (
                  <div className="absolute top-full right-0 mt-1 w-40 bg-white border border-zinc-200 rounded-lg shadow-lg z-40 py-1 max-h-56 overflow-y-auto">
                    <button onClick={() => { onSetAssignee(t.root_id, null); setMenu(null) }} className="w-full px-2.5 py-1.5 text-xs text-left hover:bg-zinc-100 text-zinc-500">Unassign</button>
                    {members.map(m => (
                      <button key={m.id} onClick={() => { onSetAssignee(t.root_id, m.id); setMenu(null) }} className="w-full flex items-center gap-2 px-2.5 py-1.5 text-xs text-left hover:bg-zinc-100">
                        {m.name}{t.assignee_id === m.id && <Check className="h-3 w-3 ml-auto text-zinc-400" />}
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <ThreadActionsMenu thread={t} channelId={channelId} currentUserId={currentUserId}
                onRename={onRename} onArchive={onArchive} onDelete={onDelete}
                onLater={onLater} onMarkUnread={onMarkUnread} />
            </div>
          )
        })}
      </div>
    </>
  )
}

function SectionHeader({ label, onAdd, dot }: { label: string; onAdd?: () => void; dot?: boolean }) {
  return (
    <div className="flex items-center justify-between px-2 mt-4 mb-1">
      <p className="text-[11px] font-semibold text-zinc-400 uppercase tracking-wide flex items-center gap-1.5">
        {label}
        {dot && <span className="w-2 h-2 rounded-full bg-red-500" title="New messages" />}
      </p>
      {onAdd && <button onClick={onAdd} className="p-0.5 rounded text-zinc-400 hover:text-zinc-700 hover:bg-zinc-200"><Plus className="h-3.5 w-3.5" /></button>}
    </div>
  )
}

/** Follow-up dot: surfaces the kanban status in the list (Luca's request).
 *  todo = no dot (default state, avoids noise); handled shows via strikethrough. */
function StatusDot({ status }: { status: TeamThread['work_status'] }) {
  if (status !== 'in_progress' && status !== 'waiting') return null
  return (
    <span
      title={status === 'in_progress' ? 'In Progress' : 'Waiting'}
      className={cn('w-2 h-2 rounded-full shrink-0', status === 'in_progress' ? 'bg-blue-500' : 'bg-amber-500')}
    />
  )
}

function ViewToggle({ view, setView }: { view: 'list' | 'board'; setView: (v: 'list' | 'board') => void }) {
  return (
    <div className="flex items-center bg-zinc-100 rounded-lg p-0.5">
      <button onClick={() => setView('list')} title="Chat list" className={cn('p-1 rounded-md', view === 'list' ? 'bg-white shadow-sm text-zinc-800' : 'text-zinc-400 hover:text-zinc-600')}><ListIcon className="h-3.5 w-3.5" /></button>
      <button onClick={() => setView('board')} title="Kanban board" className={cn('p-1 rounded-md', view === 'board' ? 'bg-white shadow-sm text-zinc-800' : 'text-zinc-400 hover:text-zinc-600')}><LayoutGrid className="h-3.5 w-3.5" /></button>
    </div>
  )
}

function SidebarThread({ t, selected, onClick, icon, label, resolved, channels, onMove, onMarkUnread, onToggleLater, menuOpen, onMenuToggle }: {
  t: TeamThread; selected: boolean; onClick: () => void; icon: React.ReactNode; label: string; resolved?: boolean
  channels: TeamThread[]
  onMove: (id: string, channelId: string | null) => void
  onMarkUnread: (id: string) => void
  onToggleLater: (id: string, later: boolean) => void
  menuOpen: boolean; onMenuToggle: (open: boolean) => void
}) {
  return (
    <div className={cn('group relative flex items-center rounded-lg', selected ? 'bg-zinc-200' : 'hover:bg-zinc-100')}>
      <button onClick={onClick} className="flex-1 min-w-0 flex items-center gap-2 px-2 py-1.5 text-left">
        <span className="shrink-0 text-zinc-500">{icon}</span>
        <span className={cn('flex-1 truncate text-sm', t.unread_count > 0 ? 'font-semibold text-zinc-900' : 'text-zinc-600', resolved && 'line-through opacity-60')}>{label}</span>
        <TurnBadge state={t.read_state} name={t.waiting_name} compact />
        <StatusDot status={t.work_status} />
        {t.later && <Clock className="h-3 w-3 text-amber-400 shrink-0" />}
        {t.unread_count > 0 && <span className="shrink-0 min-w-[18px] h-[18px] px-1 rounded-full bg-red-500 text-white text-[10px] font-bold flex items-center justify-center">{t.unread_count}</span>}
      </button>
      <button onClick={e => { e.stopPropagation(); onMenuToggle(!menuOpen) }} className={cn('shrink-0 p-1 mr-1 rounded text-zinc-400 hover:text-zinc-700 hover:bg-zinc-200', menuOpen ? 'opacity-100' : 'opacity-0 group-hover:opacity-100')}>
        <MoreHorizontal className="h-3.5 w-3.5" />
      </button>
      {menuOpen && (
        <>
          <div className="fixed inset-0 z-20" onClick={() => onMenuToggle(false)} />
          <div className="absolute right-1 top-8 z-30 w-52 bg-white border border-zinc-200 rounded-lg shadow-lg py-1 text-sm">
            <button onClick={() => onMarkUnread(t.id)} className="w-full text-left px-3 py-1.5 hover:bg-zinc-100 text-zinc-700">Mark as unread</button>
            <button onClick={() => onToggleLater(t.id, !t.later)} className="w-full text-left px-3 py-1.5 hover:bg-zinc-100 text-zinc-700">{t.later ? 'Remove from Later' : 'Save for Later'}</button>
            <div className="border-t border-zinc-100 my-1" />
            <p className="px-3 py-1 text-[10px] font-semibold text-zinc-400 uppercase">Move to channel</p>
            <div className="max-h-40 overflow-y-auto">
              {t.parent_channel_id && <button onClick={() => onMove(t.id, null)} className="w-full text-left px-3 py-1.5 hover:bg-zinc-100 text-zinc-500">— No channel —</button>}
              {channels.length === 0 && <p className="px-3 py-1.5 text-[11px] text-zinc-400">No channels yet.</p>}
              {channels.map(c => (
                <button key={c.id} onClick={() => onMove(t.id, c.id)} disabled={t.parent_channel_id === c.id}
                  className={cn('w-full text-left px-3 py-1.5 hover:bg-zinc-100 flex items-center gap-1.5', t.parent_channel_id === c.id ? 'text-zinc-400' : 'text-zinc-700')}>
                  <Hash className="h-3 w-3" style={c.color ? { color: c.color } : undefined} /> {c.channel_slug ?? c.label}{t.parent_channel_id === c.id && ' ✓'}
                </button>
              ))}
            </div>
          </div>
        </>
      )}
    </div>
  )
}

function ThreadRow({ t, selected, onClick, icon, label, resolved }: { t: TeamThread; selected: boolean; onClick: () => void; icon: React.ReactNode; label: string; resolved?: boolean }) {
  return (
    <button onClick={onClick} className={cn('w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-left', selected ? 'bg-zinc-200' : 'hover:bg-zinc-100')}>
      <span className="shrink-0 text-zinc-500">{icon}</span>
      <span className={cn('flex-1 truncate text-sm', t.unread_count > 0 ? 'font-semibold text-zinc-900' : 'text-zinc-600', resolved && 'line-through opacity-60')}>{label}</span>
      <TurnBadge state={t.read_state} name={t.waiting_name} compact />
      <StatusDot status={t.work_status} />
      {t.unread_count > 0 && <span className="shrink-0 min-w-[18px] h-[18px] px-1 rounded-full bg-red-500 text-white text-[10px] font-bold flex items-center justify-center">{t.unread_count}</span>}
    </button>
  )
}

/**
 * Rename / Archive / Delete for ONE thread — the same menu in the thread pane
 * header and on every Threads-panel row, so the two can't drift.
 *
 * Delete is only offered to the person who opened the thread AND only while
 * nobody else has replied; everyone else sees Archive, which hides the thread
 * reversibly without destroying anyone's words. The server enforces both rules
 * independently — this is the affordance, not the guard.
 */
function ThreadActionsMenu({ thread, channelId, currentUserId, onRename, onArchive, onDelete, onLater, onMarkUnread, align = 'right' }: {
  thread: ThreadListItem
  channelId: string
  currentUserId: string | null
  onRename: (rootId: string, title: string) => void
  onArchive: (rootId: string, archived: boolean) => void
  onDelete: (rootId: string) => void
  onLater: (rootId: string, later: boolean) => void
  onMarkUnread: (rootId: string) => void
  align?: 'left' | 'right'
}) {
  const [open, setOpen] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [confirmDel, setConfirmDel] = useState(false)
  const [draft, setDraft] = useState(thread.title)

  const deletable = !!currentUserId && thread.root_sender_id === currentUserId && thread.reply_count === 0
  const close = () => { setOpen(false); setRenaming(false); setConfirmDel(false) }
  const copyLink = () => {
    const url = `${window.location.origin}/team-chat?thread=${channelId}&root=${thread.root_id}`
    navigator.clipboard.writeText(url)
      .then(() => toast.success('Thread link copied — paste it into a Claude Code session and say "read this link".'))
      .catch(() => toast.error('Could not copy the link.'))
  }

  return (
    <div className="relative shrink-0" onClick={e => e.stopPropagation()}>
      <button onClick={() => { setDraft(thread.title); setOpen(v => !v) }}
        className="p-2 -m-1 rounded-full text-zinc-400 hover:text-zinc-700 hover:bg-zinc-100" aria-label="Thread actions">
        <MoreHorizontal className="h-4 w-4" />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-30" onClick={close} />
          <div className={cn('absolute top-full mt-1 z-40 w-56 bg-white border border-zinc-200 rounded-xl shadow-lg py-1', align === 'right' ? 'right-0' : 'left-0')}>
            {renaming ? (
              <div className="p-2.5">
                <input autoFocus value={draft} onChange={e => setDraft(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') { onRename(thread.root_id, draft); close() } if (e.key === 'Escape') close() }}
                  placeholder="Thread name"
                  className="w-full text-sm px-2 py-1.5 border border-zinc-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-200" />
                <p className="text-[10px] text-zinc-400 mt-1">Leave blank to use the opening message.</p>
                <div className="flex gap-2 mt-2">
                  <button onClick={() => { onRename(thread.root_id, draft); close() }}
                    className="flex-1 min-h-[36px] text-xs font-medium rounded-lg bg-zinc-800 text-white hover:bg-zinc-900">Save</button>
                  <button onClick={close} className="flex-1 min-h-[36px] text-xs font-medium rounded-lg border border-zinc-200 text-zinc-600 hover:bg-zinc-50">Cancel</button>
                </div>
              </div>
            ) : confirmDel ? (
              <div className="p-2.5">
                <p className="text-xs text-zinc-600 mb-2">Delete this thread for everyone? This can&apos;t be undone.</p>
                <div className="flex gap-2">
                  <button onClick={() => { onDelete(thread.root_id); close() }}
                    className="flex-1 min-h-[36px] text-xs font-medium rounded-lg bg-red-600 text-white hover:bg-red-700">Delete</button>
                  <button onClick={close} className="flex-1 min-h-[36px] text-xs font-medium rounded-lg border border-zinc-200 text-zinc-600 hover:bg-zinc-50">Cancel</button>
                </div>
              </div>
            ) : (
              <>
                {/* Personal markers first — used often, and harmless. */}
                <TouchAction icon={<Clock className="h-4 w-4" />}
                  label={thread.later ? 'Remove from Later' : 'Bring forward'}
                  onClick={() => { onLater(thread.root_id, !thread.later); close() }} />
                <TouchAction icon={<Mail className="h-4 w-4" />} label="Mark unread"
                  onClick={() => { onMarkUnread(thread.root_id); close() }} />
                <TouchAction icon={<Link2 className="h-4 w-4" />} label="Copy link"
                  onClick={() => { copyLink(); close() }} />
                <div className="my-1 border-t border-zinc-100" />
                <TouchAction icon={<Pencil className="h-4 w-4" />} label="Rename topic" onClick={() => setRenaming(true)} />
                {thread.archived ? (
                  <TouchAction icon={<ArchiveRestore className="h-4 w-4" />} label="Restore thread" onClick={() => { onArchive(thread.root_id, false); close() }} />
                ) : (
                  <TouchAction icon={<Archive className="h-4 w-4" />} label="Archive thread" onClick={() => { onArchive(thread.root_id, true); close() }} />
                )}
                {deletable && <TouchAction icon={<Trash2 className="h-4 w-4" />} label="Delete thread" danger onClick={() => setConfirmDel(true)} />}
                {!deletable && (
                  <p className="px-3 py-2 text-[10px] leading-snug text-zinc-400 border-t border-zinc-100 mt-1">
                    Archiving hides it and can be undone. Delete is only available on a thread nobody has replied to yet.
                  </p>
                )}
              </>
            )}
          </div>
        </>
      )}
    </div>
  )
}

/** One row in a touch menu — a full-width, ≥44px target (a 22px icon is not tappable). */
function TouchAction({ icon, label, onClick, danger }: { icon: React.ReactNode; label: string; onClick: () => void; danger?: boolean }) {
  return (
    <button onClick={onClick}
      className={cn('w-full flex items-center gap-3 px-3 min-h-[44px] text-sm text-left active:bg-zinc-100', danger ? 'text-red-600' : 'text-zinc-700')}>
      {icon}{label}
    </button>
  )
}

function MessageRow({ m, isMe, isClaude, canDelete, currentUserId, onReply, onEdit, onDelete, onPin, onReact, reactOpen, setReactOpen, touchMenu, setTouchMenu, onMarkUnreadFromHere }: {
  m: TeamMsg; isMe: boolean; isClaude: boolean; canDelete: boolean; currentUserId: string | null
  onReply: () => void; onEdit: () => void; onDelete: () => void; onPin: () => void; onReact: (e: string) => void
  reactOpen: boolean; setReactOpen: (o: boolean) => void
  touchMenu: boolean; setTouchMenu: (o: boolean) => void
  /** Present only inside a thread pane — marks everything from this message
   *  down as new again (Slack's "mark unread from here"). */
  onMarkUnreadFromHere?: () => void
}) {
  const isDeleted = !!m.deleted_at
  const [confirmDelete, setConfirmDelete] = useState(false)
  const attachments = m.attachments?.length ? m.attachments : (m.attachment_url ? [{ url: m.attachment_url, name: m.attachment_name ?? 'file' }] : [])
  const grouped = useMemo(() => {
    const map = new Map<string, { emoji: string; count: number; mine: boolean }>()
    for (const r of (m.reactions ?? []) as Reaction[]) {
      const g = map.get(r.emoji) ?? { emoji: r.emoji, count: 0, mine: false }
      g.count++; if (r.reactor_id === currentUserId) g.mine = true
      map.set(r.emoji, g)
    }
    return Array.from(map.values())
  }, [m.reactions, currentUserId])

  return (
    <div className={cn('flex gap-2 items-start group py-0.5', isMe ? 'flex-row-reverse' : 'flex-row')}>
      <span className={cn('w-7 h-7 rounded-full flex items-center justify-center text-[10px] font-bold text-white shrink-0 mt-0.5', isClaude ? 'bg-violet-600' : senderColor(m.sender_id))}>
        {isClaude ? <Bot className="h-4 w-4" /> : initials(m.sender_name)}
      </span>
      <div className={cn('flex flex-col max-w-[72%]', isMe ? 'items-end' : 'items-start')}>
        <div className="flex items-center gap-2 px-1">
          <span className="text-[11px] font-semibold text-zinc-500">{isClaude ? 'Claude' : m.sender_name}</span>
          <span className="text-[10px] text-zinc-400">{msgTime(m.created_at)}</span>
          {m.edited_at && !isDeleted && <span className="text-[10px] text-zinc-400">(edited)</span>}
          {m.pinned_at && !isDeleted && <Pin className="h-2.5 w-2.5 text-amber-500" />}
        </div>

        {m.reply_to_preview && !isDeleted && (
          <div className="text-[11px] px-2 py-1 rounded-lg border-l-2 bg-zinc-50 border-zinc-300 text-zinc-500 max-w-full truncate mb-0.5">
            <span className="font-semibold">{m.reply_to_preview.sender_name}: </span>
            {m.reply_to_preview.deleted_at ? 'Message deleted' : m.reply_to_preview.message.slice(0, 80)}
          </div>
        )}

        <div className={cn('flex items-center gap-1', isMe ? 'flex-row-reverse' : 'flex-row')}>
          <div className={cn('px-3 py-2 rounded-2xl text-sm leading-relaxed', isClaude ? 'bg-violet-50 border border-violet-200 text-zinc-900' : isMe ? 'bg-zinc-800 text-white' : 'bg-white border border-zinc-200 text-zinc-900', isDeleted && 'opacity-60 italic')} style={{ wordBreak: 'break-word' }}>
            {isDeleted ? <span className="text-zinc-400 text-xs">🗑 Message deleted</span> : (
              <>
                {/* Both pending markers render as the spinner: '…' = queued, '⋯' = a
                    processor has claimed this turn (see PENDING_PLACEHOLDERS in
                    lib/team/claude-trigger.ts). They are two states of "still thinking",
                    and the claim is deliberately invisible to the reader. */}
                {m.message === '…' || m.message === '⋯' ? <span className="text-zinc-400 flex items-center gap-1"><Loader2 className="h-3 w-3 animate-spin" /> thinking…</span> : m.message && <p className="whitespace-pre-wrap">{m.message}</p>}
                {m.card && <CardView card={m.card} />}
                {attachments.length > 0 && (
                  <div className="flex flex-col gap-1 mt-1.5">
                    {attachments.map((a, i) => {
                      const isImg = a.url && /\.(jpg|jpeg|png|webp|gif)(\?|$)/i.test(a.url)
                      return isImg
                        // eslint-disable-next-line @next/next/no-img-element
                        ? <img key={i} src={a.url} alt={a.name} className="max-w-[220px] rounded-lg border border-zinc-200 cursor-pointer" onClick={() => window.open(a.url, '_blank')} />
                        : <a key={i} href={a.url} target="_blank" rel="noopener noreferrer" className={cn('flex items-center gap-2 px-2 py-1.5 rounded-lg text-xs', isMe ? 'bg-white/10 hover:bg-white/20' : 'bg-zinc-100 hover:bg-zinc-200')}><FileText className="h-3.5 w-3.5 shrink-0" /><span className="truncate max-w-[160px]">{a.name}</span></a>
                    })}
                  </div>
                )}
              </>
            )}
          </div>

          {/* Actions. Desktop keeps the familiar hover row; TOUCH gets an
              always-visible ⋯ opening a menu with full-size targets — a hover
              row is unreachable on a phone, and Antonio runs the whole CRM as a
              ~380px PWA. Delete asks first on both. */}
          {!isDeleted && (
            <div className="flex items-center gap-0.5 relative">
              {/* Desktop hover row */}
              <div className="hidden md:flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
                <button onClick={() => setReactOpen(!reactOpen)} className="p-1 rounded-full text-zinc-400 hover:bg-zinc-100" title="React"><Smile className="h-3.5 w-3.5" /></button>
                <button onClick={onReply} className="p-1 rounded-full text-zinc-400 hover:bg-zinc-100" title="Reply"><CornerUpLeft className="h-3.5 w-3.5" /></button>
                <button onClick={onPin} className="p-1 rounded-full text-zinc-400 hover:bg-zinc-100" title={m.pinned_at ? 'Unpin' : 'Pin'}>{m.pinned_at ? <PinOff className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />}</button>
                {onMarkUnreadFromHere && <button onClick={onMarkUnreadFromHere} className="p-1 rounded-full text-zinc-400 hover:bg-zinc-100" title="Mark unread from here"><Mail className="h-3.5 w-3.5" /></button>}
                {isMe && !isClaude && <button onClick={onEdit} className="p-1 rounded-full text-zinc-400 hover:bg-zinc-100" title="Edit"><Pencil className="h-3.5 w-3.5" /></button>}
                {canDelete && <button onClick={() => setConfirmDelete(true)} className="p-1 rounded-full text-zinc-400 hover:text-red-500 hover:bg-zinc-100" title="Delete"><Trash2 className="h-3.5 w-3.5" /></button>}
              </div>

              {/* Touch: always-visible ⋯ */}
              <button onClick={() => setTouchMenu(!touchMenu)}
                className="md:hidden relative z-40 p-2 -m-0.5 rounded-full text-zinc-400 active:bg-zinc-100" aria-label="Message actions">
                <MoreHorizontal className="h-4 w-4" />
              </button>

              {reactOpen && (
                <>
                  {/* Touch has no hover-out, so the picker needs a way to close. */}
                  <div className="fixed inset-0 z-30" onClick={() => setReactOpen(false)} />
                  <div className="absolute bottom-full mb-1 bg-white border border-zinc-200 rounded-full shadow-lg px-1.5 py-1 flex gap-0.5 z-40">
                    {QUICK_EMOJIS.map(e => <button key={e} onClick={() => onReact(e)} className="hover:scale-125 transition-transform text-base p-1">{e}</button>)}
                  </div>
                </>
              )}

              {touchMenu && (
                <>
                  {/* Tap-anywhere-to-close backdrop — a phone has no Escape key. */}
                  <div className="fixed inset-0 z-30 md:hidden" onClick={() => setTouchMenu(false)} />
                  <div className={cn('absolute bottom-full mb-1 z-40 w-44 bg-white border border-zinc-200 rounded-xl shadow-lg py-1 md:hidden', isMe ? 'left-0' : 'right-0')}>
                    <TouchAction icon={<Smile className="h-4 w-4" />} label="React" onClick={() => { setTouchMenu(false); setReactOpen(true) }} />
                    <TouchAction icon={<CornerUpLeft className="h-4 w-4" />} label="Reply" onClick={() => { setTouchMenu(false); onReply() }} />
                    <TouchAction icon={m.pinned_at ? <PinOff className="h-4 w-4" /> : <Pin className="h-4 w-4" />} label={m.pinned_at ? 'Unpin' : 'Pin'} onClick={() => { setTouchMenu(false); onPin() }} />
                    {onMarkUnreadFromHere && <TouchAction icon={<Mail className="h-4 w-4" />} label="Mark unread from here" onClick={() => { setTouchMenu(false); onMarkUnreadFromHere() }} />}
                    {isMe && !isClaude && <TouchAction icon={<Pencil className="h-4 w-4" />} label="Edit" onClick={() => { setTouchMenu(false); onEdit() }} />}
                    {canDelete && <TouchAction icon={<Trash2 className="h-4 w-4" />} label="Delete" danger onClick={() => { setTouchMenu(false); setConfirmDelete(true) }} />}
                  </div>
                </>
              )}

              {/* Delete confirmation — destructive and one tap away on both surfaces. */}
              {confirmDelete && (
                <>
                  <div className="fixed inset-0 z-30" onClick={() => setConfirmDelete(false)} />
                  <div className={cn('absolute bottom-full mb-1 z-40 w-52 bg-white border border-zinc-200 rounded-xl shadow-lg p-3', isMe ? 'left-0' : 'right-0')}>
                    <p className="text-xs text-zinc-600 mb-2">Delete this message?</p>
                    <div className="flex gap-2">
                      <button onClick={() => { setConfirmDelete(false); onDelete() }}
                        className="flex-1 min-h-[36px] text-xs font-medium rounded-lg bg-red-600 text-white hover:bg-red-700">Delete</button>
                      <button onClick={() => setConfirmDelete(false)}
                        className="flex-1 min-h-[36px] text-xs font-medium rounded-lg border border-zinc-200 text-zinc-600 hover:bg-zinc-50">Cancel</button>
                    </div>
                  </div>
                </>
              )}
            </div>
          )}
        </div>

        {/* Reactions */}
        {grouped.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-1 px-1">
            {grouped.map(g => (
              <button key={g.emoji} onClick={() => onReact(g.emoji)} className={cn('flex items-center gap-1 px-1.5 py-0.5 rounded-full border text-xs', g.mine ? 'bg-blue-50 border-blue-300 text-blue-700' : 'bg-zinc-50 border-zinc-200 text-zinc-600 hover:border-zinc-300')}>
                <span>{g.emoji}</span><span className="text-[10px] font-medium">{g.count}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

/**
 * A frozen outbound email waiting for a human — the SAME confirm step the Inbox,
 * client-chat and sidebar panels show, rendered here so it exists on every surface
 * (Antonio, 2026-07-29: "I want the confirm step everywhere"). The buttons call the
 * shared confirm-send endpoint with the frozen row's id: what leaves is exactly the
 * payload shown, and the row is single-use, so a second click cannot send twice.
 */
function EmailConfirmCard({ card }: { card: NonNullable<TeamMsg['card']> }) {
  const [busy, setBusy] = useState(false)
  const [done, setDone] = useState<'sent' | 'cancelled' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const preparedId = card.entity_id

  const resolve = async (action: 'confirm' | 'cancel') => {
    if (!preparedId || busy) return
    setBusy(true)
    setError(null)
    try {
      const res = await fetch('/api/inbox/worker-chat/confirm-send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prepared_id: preparedId, action }),
      })
      const data = await res.json().catch(() => ({}))
      // Surface the server's real reason (R099) — "already sent", "not authorized
      // for this mailbox" and "expired" are all things staff need to see verbatim.
      if (!res.ok) throw new Error(data.error || 'Could not complete — please try again.')
      setDone(action === 'confirm' ? 'sent' : 'cancelled')
    } catch (err) {
      setError(err instanceof Error && err.message ? err.message : 'Could not complete.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mt-1.5 rounded-lg border border-amber-200 bg-amber-50 overflow-hidden max-w-[420px]">
      <div className="px-3 py-2">
        <p className="text-[10px] uppercase tracking-wide text-amber-700 font-semibold">Confirm before sending</p>
        <p className="text-sm font-medium text-zinc-900 break-all">{card.title}</p>
        {card.subtitle && <p className="text-xs text-zinc-600 mt-0.5 break-words">{card.subtitle}</p>}
        {card.body ? (
          <div className="mt-2 max-h-40 overflow-y-auto rounded-lg border border-amber-200 bg-white px-2.5 py-2">
            <p className="whitespace-pre-wrap break-words text-xs text-zinc-700">{card.body}</p>
          </div>
        ) : null}
        {done ? (
          <p className={cn('mt-2 text-xs font-medium', done === 'sent' ? 'text-emerald-700' : 'text-zinc-500')}>
            {done === 'sent' ? '✅ Sent.' : 'Cancelled — nothing was sent.'}
          </p>
        ) : (
          <div className="mt-2.5 flex items-center gap-2">
            <button
              onClick={() => void resolve('confirm')}
              disabled={busy || !preparedId}
              className="px-3 py-1.5 rounded-lg bg-emerald-600 text-white text-sm font-medium hover:bg-emerald-700 disabled:opacity-50 min-h-[36px]"
            >
              {busy ? 'Sending…' : 'Confirm & send'}
            </button>
            <button
              onClick={() => void resolve('cancel')}
              disabled={busy || !preparedId}
              className="px-3 py-1.5 rounded-lg border border-zinc-300 text-zinc-700 text-sm hover:bg-zinc-100 disabled:opacity-50 min-h-[36px]"
            >
              Cancel
            </button>
          </div>
        )}
        {error && <p className="mt-1.5 text-xs text-red-600">{error}</p>}
      </div>
    </div>
  )
}

function CardView({ card }: { card: NonNullable<TeamMsg['card']> }) {
  if (card.kind === 'email_confirm') return <EmailConfirmCard card={card} />
  const inner = (
    <div className="mt-1.5 rounded-lg border border-zinc-200 bg-white overflow-hidden max-w-[280px]" style={card.color ? { borderLeftColor: card.color, borderLeftWidth: 3 } : undefined}>
      <div className="px-3 py-2">
        <p className="text-[10px] uppercase tracking-wide text-zinc-400 font-semibold">{card.kind.replace('_', ' ')}</p>
        <p className="text-sm font-medium text-zinc-900 truncate">{card.title}</p>
        {card.subtitle && <p className="text-xs text-zinc-500 truncate">{card.subtitle}</p>}
      </div>
    </div>
  )
  return card.url ? <a href={card.url} className="block hover:opacity-90">{inner}</a> : inner
}

function NewChannelModal({ onClose, onCreate }: { onClose: () => void; onCreate: (name: string, color: string) => void }) {
  const [name, setName] = useState('')
  const [color, setColor] = useState<string>(TEAM_COLORS[0])
  const slug = channelSlug(name)
  return (
    <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-xl p-5 w-80" onClick={e => e.stopPropagation()}>
        <h3 className="text-sm font-semibold text-zinc-900 mb-3">New channel</h3>
        <input autoFocus value={name} onChange={e => setName(e.target.value)} placeholder="e.g. Daily Ops" className="w-full px-3 py-2 text-sm border border-zinc-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-zinc-300 mb-1" />
        {slug && <p className="text-[11px] text-zinc-400 mb-3">Will be created as #{slug}</p>}
        <p className="text-[11px] font-semibold text-zinc-400 uppercase mb-2">Color</p>
        <div className="flex gap-2 mb-4">
          {TEAM_COLORS.map(c => <button key={c} onClick={() => setColor(c)} className={cn('w-6 h-6 rounded-full border-2', color === c ? 'border-zinc-800' : 'border-transparent')} style={{ background: c }} />)}
        </div>
        <div className="flex gap-2 justify-end">
          <button onClick={onClose} className="px-3 py-1.5 text-sm text-zinc-600 hover:bg-zinc-100 rounded-lg">Cancel</button>
          <button onClick={() => slug && onCreate(name, color)} disabled={!slug} className="px-3 py-1.5 text-sm bg-zinc-800 text-white rounded-lg disabled:opacity-40">Create</button>
        </div>
      </div>
    </div>
  )
}

function SlackFeedView({ channel, channelId, messages, loading }: {
  channel: SlackChannel | null; channelId: string; messages: SlackMsg[]; loading: boolean
}) {
  const channelLink = messages[0]?.deep_link
  return (
    <>
      <div className="flex items-center justify-between px-5 py-3 border-b border-zinc-200 bg-white shrink-0">
        <h2 className="text-sm font-semibold text-zinc-900 flex items-center gap-2 truncate">
          <Slack className="h-4 w-4 text-[#4A154B]" /> #{channel?.name ?? channelId}
          <span className="text-[10px] font-normal text-zinc-400 border border-zinc-200 rounded px-1.5 py-0.5">Slack · read-only</span>
        </h2>
        {channelLink && (
          <a href={channelLink} target="_blank" rel="noopener noreferrer" className="text-xs text-zinc-600 hover:text-zinc-900 flex items-center gap-1">
            Open in Slack <ExternalLink className="h-3 w-3" />
          </a>
        )}
      </div>
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-2">
        {loading ? (
          <div className="flex justify-center py-8"><Loader2 className="h-6 w-6 animate-spin text-zinc-400" /></div>
        ) : messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-zinc-400 gap-2">
            <Slack className="h-9 w-9" /><p className="text-sm">No messages mirrored yet.</p>
            <p className="text-[11px]">Run a sync, or wait for new Slack activity.</p>
          </div>
        ) : (
          messages.map(m => (
            <div key={m.ts} className="group flex gap-2 items-start">
              <span className="w-7 h-7 rounded-md bg-zinc-200 flex items-center justify-center text-[10px] font-bold text-zinc-600 shrink-0 mt-0.5">
                {initials(m.display_author)}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-[11px] font-semibold text-zinc-600">{m.display_author}</span>
                  {m.posted_at && <span className="text-[10px] text-zinc-400">{msgTime(m.posted_at)}</span>}
                  {m.edited && <span className="text-[10px] text-zinc-400">(edited)</span>}
                  <a href={m.deep_link} target="_blank" rel="noopener noreferrer" title="Open in Slack"
                    className="opacity-0 group-hover:opacity-100 transition-opacity text-zinc-400 hover:text-zinc-700"><ExternalLink className="h-3 w-3" /></a>
                </div>
                <p className="text-sm text-zinc-800 whitespace-pre-wrap" style={{ wordBreak: 'break-word' }}>{m.text || <span className="text-zinc-400 italic">(no text)</span>}</p>
              </div>
            </div>
          ))
        )}
      </div>
      <div className="shrink-0 px-5 py-3 border-t border-zinc-200 bg-zinc-50 text-center">
        <p className="text-xs text-zinc-500">This is a read-only mirror of Slack. {channelLink ? <a href={channelLink} target="_blank" rel="noopener noreferrer" className="text-zinc-700 underline">Reply in Slack ↗</a> : 'Reply in Slack.'}</p>
      </div>
    </>
  )
}

function NewConversationModal({ channels, generalThread, onClose, onCreate }: {
  channels: TeamThread[]; generalThread: TeamThread | null
  onClose: () => void; onCreate: (client: string, topic: string, channelId: string | null) => void
}) {
  const [q, setQ] = useState('')
  const [results, setResults] = useState<{ value: string; label: string; sublabel: string }[]>([])
  const [picked, setPicked] = useState<{ value: string; label: string } | null>(null)
  const [topics, setTopics] = useState<{ slug: string; display_name: string }[]>([])
  const [topicSel, setTopicSel] = useState('')
  const [newTopic, setNewTopic] = useState('')
  const [channelId, setChannelId] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    fetch('/api/portal/chat/topic-templates').then(r => r.json()).then(d => setTopics(d.templates ?? [])).catch(() => {})
  }, [])

  // Debounced client search
  useEffect(() => {
    if (picked) return
    if (q.trim().length < 2) { setResults([]); return }
    const t = setTimeout(() => {
      fetch(`/api/team/client-search?q=${encodeURIComponent(q)}`).then(r => r.json()).then(d => setResults(d.results ?? [])).catch(() => setResults([]))
    }, 250)
    return () => clearTimeout(t)
  }, [q, picked])

  const effectiveTopic = newTopic.trim() || topicSel
  const channelOptions = [...(generalThread ? [generalThread] : []), ...channels]

  const submit = async () => {
    if (!picked || busy) return
    setBusy(true)
    await onCreate(picked.value, effectiveTopic, channelId || null)
    setBusy(false)
  }

  return (
    <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-xl p-5 w-96 max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <h3 className="text-sm font-semibold text-zinc-900 mb-4">New conversation</h3>

        {/* Client (required) */}
        <label className="text-[11px] font-semibold text-zinc-500 uppercase">Client</label>
        {picked ? (
          <div className="flex items-center justify-between mt-1 mb-3 px-3 py-2 border border-zinc-200 rounded-lg bg-zinc-50">
            <span className="text-sm text-zinc-800 truncate">{picked.label}</span>
            <button onClick={() => { setPicked(null); setQ('') }} className="text-zinc-400 hover:text-zinc-700"><X className="h-3.5 w-3.5" /></button>
          </div>
        ) : (
          <div className="relative mt-1 mb-3">
            <input autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder="Search account, contact, or lead…"
              className="w-full px-3 py-2 text-sm border border-zinc-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-zinc-300" />
            {results.length > 0 && (
              <div className="absolute top-full left-0 right-0 mt-1 bg-white border border-zinc-200 rounded-lg shadow-lg max-h-52 overflow-y-auto z-10">
                {results.map(r => (
                  <button key={r.value} onClick={() => { setPicked({ value: r.value, label: r.label }); setResults([]) }}
                    className="w-full flex items-center justify-between px-3 py-2 hover:bg-zinc-100 text-left">
                    <span className="text-sm text-zinc-800 truncate">{r.label}</span>
                    <span className="text-[10px] text-zinc-400 shrink-0 ml-2">{r.sublabel}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Topic (optional) */}
        <label className="text-[11px] font-semibold text-zinc-500 uppercase">Topic <span className="text-zinc-300">(optional)</span></label>
        <select value={topicSel} onChange={e => setTopicSel(e.target.value)} disabled={!!newTopic.trim()}
          className="w-full mt-1 mb-2 px-3 py-2 text-sm border border-zinc-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-zinc-300 disabled:opacity-50">
          <option value="">Pick a topic</option>
          {topics.map(t => <option key={t.slug} value={t.display_name}>{t.display_name}</option>)}
        </select>
        <input value={newTopic} onChange={e => setNewTopic(e.target.value)} placeholder="Or type a new topic"
          className="w-full mb-3 px-3 py-2 text-sm border border-zinc-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-zinc-300" />

        {/* Channel (optional) — the conversation is FILED under this channel (Slack parity) */}
        <label className="text-[11px] font-semibold text-zinc-500 uppercase">Channel <span className="text-zinc-300">(optional — conversation is filed there)</span></label>
        <select value={channelId} onChange={e => setChannelId(e.target.value)}
          className="w-full mt-1 mb-4 px-3 py-2 text-sm border border-zinc-200 rounded-lg focus:outline-none focus:ring-1 focus:ring-zinc-300">
          <option value="">None</option>
          {channelOptions.map(c => <option key={c.id} value={c.id}>#{c.thread_type === 'general' ? 'general' : (c.channel_slug ?? c.label)}</option>)}
        </select>

        <div className="flex gap-2 justify-end">
          <button onClick={onClose} className="px-3 py-1.5 text-sm text-zinc-600 hover:bg-zinc-100 rounded-lg">Cancel</button>
          <button onClick={submit} disabled={!picked || busy} className="px-3 py-1.5 text-sm bg-zinc-800 text-white rounded-lg disabled:opacity-40 flex items-center gap-1">
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" />} Start
          </button>
        </div>
      </div>
    </div>
  )
}

function NewDmModal({ members, onClose, onPick }: { members: TeamMember[]; onClose: () => void; onPick: (id: string) => void }) {
  return (
    <div className="fixed inset-0 bg-black/30 flex items-center justify-center z-50" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-xl p-5 w-80" onClick={e => e.stopPropagation()}>
        <h3 className="text-sm font-semibold text-zinc-900 mb-3">New direct message</h3>
        {members.length === 0 ? <p className="text-xs text-zinc-400">No other teammates.</p> : (
          <div className="flex flex-col gap-1 max-h-64 overflow-y-auto">
            {members.map(m => (
              <button key={m.id} onClick={() => onPick(m.id)} className="flex items-center gap-2 px-2 py-2 rounded-lg hover:bg-zinc-100 text-left">
                <span className={cn('w-7 h-7 rounded-full flex items-center justify-center text-[10px] font-bold text-white', senderColor(m.id))}>{initials(m.name)}</span>
                <div><p className="text-sm text-zinc-800">{m.name}</p><p className="text-[10px] text-zinc-400 capitalize">{m.role}</p></div>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
