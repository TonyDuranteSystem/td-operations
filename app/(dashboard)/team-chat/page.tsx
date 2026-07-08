'use client'

import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'
import {
  Send, Loader2, Users, Hash, Paperclip, Smile, Mic, MicOff, FileText, X,
  CornerUpLeft, Trash2, Plus, Search, Pin, PinOff, Pencil, Check,
  MessageSquare, Bot, CircleDot, Building2,
} from 'lucide-react'
import EmojiPicker from 'emoji-picker-react'
import { format, isToday, isYesterday } from 'date-fns'
import { cn } from '@/lib/utils'
import { useVoiceInput } from '@/lib/hooks/use-voice-input'
import { uploadTeamAttachment } from '@/lib/team/attachment'
import { TEAM_COLORS, CLAUDE_SENDER_UUID, channelSlug } from '@/lib/team/workspace'
import type { ChatAttachment } from '@/lib/types'
import type { TeamMsg, TeamThread, TeamMember, Reaction } from './types'

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
  const [showNewChannel, setShowNewChannel] = useState(false)
  const [showNewDm, setShowNewDm] = useState(false)
  const [searchQ, setSearchQ] = useState('')
  const [searchResults, setSearchResults] = useState<{ id: string; thread_id: string; thread_label: string; message: string; sender_name: string; created_at: string }[] | null>(null)
  const [reactFor, setReactFor] = useState<string | null>(null)

  const bottomRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const fileRef = useRef<HTMLInputElement>(null)
  const emojiRef = useRef<HTMLDivElement>(null)
  const selectedIdRef = useRef<string | null>(null)
  selectedIdRef.current = selectedId

  const { isRecording, isTranscribing, startRecording, stopRecording, isSupported: voiceSupported } =
    useVoiceInput({ language: 'en-US', onTranscript: t => setText(p => p ? `${p} ${t}` : t), onError: m => toast.error(m) })

  const selected = useMemo(() => threads.find(t => t.id === selectedId) ?? null, [threads, selectedId])

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
      const r = await fetch(`/api/team/threads/${threadId}`)
      if (!r.ok) throw new Error('Failed')
      const d = await r.json()
      // On a silent poll, only replace if something actually changed (avoids
      // clobbering local optimistic state / re-render churn).
      setMessages(prev => {
        if (opts?.silent) {
          const a = prev[prev.length - 1]?.id, b = d.messages[d.messages.length - 1]?.id
          if (prev.length === d.messages.length && a === b) return prev
        }
        return d.messages
      })
      // Optimistically clear this thread's unread badge locally.
      setThreads(prev => prev.map(t => t.id === threadId ? { ...t, unread_count: 0 } : t))
    } catch {
      if (!opts?.silent) toast.error('Failed to load messages')
    } finally {
      if (!opts?.silent) setLoadingMsgs(false)
    }
  }, [])

  // Initial load
  useEffect(() => { loadThreads(true) }, [loadThreads])

  // Load messages when a thread is selected
  useEffect(() => { if (selectedId) loadMessages(selectedId) }, [selectedId, loadMessages])

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
      .subscribe()
    return () => { if (debounce) clearTimeout(debounce); supabase.removeChannel(channel) }
  }, [loadThreads])

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

  // Detect @mention typing for autocomplete
  const onTextChange = (val: string) => {
    setText(val)
    const el = inputRef.current
    const caret = el?.selectionStart ?? val.length
    const upto = val.slice(0, caret)
    const m = upto.match(/(?:^|\s)@([a-zA-Z0-9._-]*)$/)
    setMentionQuery(m ? m[1].toLowerCase() : null)
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
    setText(replaced + rest)
    setMentionQuery(null)
    requestAnimationFrame(() => el?.focus())
  }

  const handleSend = useCallback(async () => {
    const msg = text.trim()
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
      const r = await fetch(`/api/team/threads/${selectedId}/messages`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: sentText, reply_to_id: sentReply?.id ?? null, attachments }),
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
      }
    } catch (e) {
      toast.error(e instanceof Error && e.message ? e.message : 'Failed to send')
      setText(sentText); setReplyTo(sentReply)
    } finally { setSending(false); inputRef.current?.focus() }
  }, [text, pendingFiles, selectedId, sending, uploading, replyTo, editing, isRecording, stopRecording])

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

  const toggleResolve = async () => {
    if (!selected) return
    const r = await fetch(`/api/team/threads/${selected.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ resolved: !selected.resolved_at }),
    })
    if (r.ok) loadThreads()
  }

  // Sidebar sections
  const generalThread = threads.find(t => t.thread_type === 'general')
  const channels = threads.filter(t => t.thread_type === 'channel')
  const dms = threads.filter(t => t.thread_type === 'dm')
  const discussions = threads.filter(t => t.thread_type === 'discussion')

  const dmLabel = (t: TeamThread): string => {
    if (!t.dm_key || !currentUserId) return t.label
    const otherId = t.dm_key.split(':').find(id => id !== currentUserId) ?? ''
    return members.find(m => m.id === otherId)?.name ?? 'Direct message'
  }

  const pinned = messages.filter(m => m.pinned_at && !m.deleted_at)

  return (
    <div className="flex h-full">
      {/* Sidebar */}
      <div className="w-64 shrink-0 border-r border-zinc-200 bg-zinc-50 flex flex-col">
        <div className="px-4 py-3 border-b border-zinc-200">
          <h1 className="text-sm font-semibold text-zinc-900 flex items-center gap-2"><Users className="h-4 w-4" /> Team Workspace</h1>
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
              <p className="px-2 text-[11px] font-semibold text-zinc-400 uppercase mb-1">Search</p>
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
              {generalThread && <ThreadRow t={generalThread} selected={selectedId === generalThread.id} onClick={() => setSelectedId(generalThread.id)} icon={<Hash className="h-3.5 w-3.5" />} label="general" />}

              <SectionHeader label="Channels" onAdd={() => setShowNewChannel(true)} />
              {channels.length === 0 && <p className="px-2 text-[11px] text-zinc-400 mb-2">No channels yet.</p>}
              {channels.map(t => <ThreadRow key={t.id} t={t} selected={selectedId === t.id} onClick={() => setSelectedId(t.id)} icon={<Hash className="h-3.5 w-3.5" style={t.color ? { color: t.color } : undefined} />} label={t.channel_slug ?? t.label} />)}

              <SectionHeader label="Direct Messages" onAdd={() => setShowNewDm(true)} />
              {dms.length === 0 && <p className="px-2 text-[11px] text-zinc-400 mb-2">No DMs yet.</p>}
              {dms.map(t => <ThreadRow key={t.id} t={t} selected={selectedId === t.id} onClick={() => setSelectedId(t.id)} icon={<span className={cn('w-4 h-4 rounded-full flex items-center justify-center text-[8px] font-bold text-white', senderColor(t.id))}>{initials(dmLabel(t))}</span>} label={dmLabel(t)} />)}

              <SectionHeader label="Client Discussions" />
              {discussions.length === 0 && <p className="px-2 text-[11px] text-zinc-400">None.</p>}
              {discussions.map(t => <ThreadRow key={t.id} t={t} selected={selectedId === t.id} onClick={() => setSelectedId(t.id)} icon={<Building2 className="h-3.5 w-3.5" />} label={t.label} resolved={!!t.resolved_at} />)}
            </>
          )}
        </div>
      </div>

      {/* Main pane */}
      <div className="flex-1 flex flex-col min-w-0">
        {!selected ? (
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
              {selected.thread_type === 'discussion' && (
                <button onClick={toggleResolve} className={cn('text-xs px-2.5 py-1 rounded-full border flex items-center gap-1', selected.resolved_at ? 'bg-emerald-50 border-emerald-200 text-emerald-700' : 'bg-white border-zinc-200 text-zinc-600 hover:bg-zinc-50')}>
                  {selected.resolved_at ? <><Check className="h-3 w-3" /> Resolved</> : <><CircleDot className="h-3 w-3" /> Open</>}
                </button>
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

            {/* Messages */}
            <div className="flex-1 overflow-y-auto px-4 py-4 space-y-1">
              {loadingMsgs ? (
                <div className="flex justify-center py-8"><Loader2 className="h-6 w-6 animate-spin text-zinc-400" /></div>
              ) : messages.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-full text-zinc-400 gap-2">
                  <MessageSquare className="h-9 w-9" /><p className="text-sm">No messages yet.</p>
                </div>
              ) : (
                messages.map(m => (
                  <MessageRow key={m.id} m={m} isMe={m.sender_id === currentUserId} isClaude={m.sender_id === CLAUDE_SENDER_UUID}
                    canDelete={m.sender_id === currentUserId || isAdmin} currentUserId={currentUserId}
                    onReply={() => { setReplyTo(m); inputRef.current?.focus() }}
                    onEdit={() => { setEditing(m); setText(m.message); inputRef.current?.focus() }}
                    onDelete={() => deleteMsg(m)} onPin={() => togglePin(m)}
                    onReact={emoji => toggleReaction(m.id, emoji)}
                    reactOpen={reactFor === m.id} setReactOpen={open => setReactFor(open ? m.id : null)} />
                ))
              )}
              <div ref={bottomRef} />
            </div>

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
                  <input ref={fileRef} type="file" multiple onChange={e => { setPendingFiles(p => [...p, ...Array.from(e.target.files ?? [])].slice(0, 5)); e.target.value = '' }} className="hidden" />
                  <textarea ref={inputRef} value={text} onChange={e => onTextChange(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && mentionQuery === null) { e.preventDefault(); handleSend() } }}
                    placeholder={editing ? 'Edit message…' : isRecording ? 'Recording…' : `Message ${selected.thread_type === 'channel' ? '#' + (selected.channel_slug ?? '') : selected.thread_type === 'dm' ? dmLabel(selected) : selected.label}… (@ to mention, @claude for AI)`}
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
          </>
        )}
      </div>

      {showNewChannel && <NewChannelModal onClose={() => setShowNewChannel(false)} onCreate={createChannel} />}
      {showNewDm && <NewDmModal members={members.filter(m => m.id !== currentUserId)} onClose={() => setShowNewDm(false)} onPick={startDm} />}
    </div>
  )
}

function SectionHeader({ label, onAdd }: { label: string; onAdd?: () => void }) {
  return (
    <div className="flex items-center justify-between px-2 mt-4 mb-1">
      <p className="text-[11px] font-semibold text-zinc-400 uppercase tracking-wide">{label}</p>
      {onAdd && <button onClick={onAdd} className="p-0.5 rounded text-zinc-400 hover:text-zinc-700 hover:bg-zinc-200"><Plus className="h-3.5 w-3.5" /></button>}
    </div>
  )
}

function ThreadRow({ t, selected, onClick, icon, label, resolved }: { t: TeamThread; selected: boolean; onClick: () => void; icon: React.ReactNode; label: string; resolved?: boolean }) {
  return (
    <button onClick={onClick} className={cn('w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-left', selected ? 'bg-zinc-200' : 'hover:bg-zinc-100')}>
      <span className="shrink-0 text-zinc-500">{icon}</span>
      <span className={cn('flex-1 truncate text-sm', t.unread_count > 0 ? 'font-semibold text-zinc-900' : 'text-zinc-600', resolved && 'line-through opacity-60')}>{label}</span>
      {t.unread_count > 0 && <span className="shrink-0 min-w-[18px] h-[18px] px-1 rounded-full bg-red-500 text-white text-[10px] font-bold flex items-center justify-center">{t.unread_count}</span>}
    </button>
  )
}

function MessageRow({ m, isMe, isClaude, canDelete, currentUserId, onReply, onEdit, onDelete, onPin, onReact, reactOpen, setReactOpen }: {
  m: TeamMsg; isMe: boolean; isClaude: boolean; canDelete: boolean; currentUserId: string | null
  onReply: () => void; onEdit: () => void; onDelete: () => void; onPin: () => void; onReact: (e: string) => void
  reactOpen: boolean; setReactOpen: (o: boolean) => void
}) {
  const isDeleted = !!m.deleted_at
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
                {m.message === '…' ? <span className="text-zinc-400 flex items-center gap-1"><Loader2 className="h-3 w-3 animate-spin" /> thinking…</span> : m.message && <p className="whitespace-pre-wrap">{m.message}</p>}
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

          {/* Hover actions */}
          {!isDeleted && (
            <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity relative">
              <button onClick={() => setReactOpen(!reactOpen)} className="p-1 rounded-full text-zinc-400 hover:bg-zinc-100" title="React"><Smile className="h-3.5 w-3.5" /></button>
              <button onClick={onReply} className="p-1 rounded-full text-zinc-400 hover:bg-zinc-100" title="Reply"><CornerUpLeft className="h-3.5 w-3.5" /></button>
              <button onClick={onPin} className="p-1 rounded-full text-zinc-400 hover:bg-zinc-100" title={m.pinned_at ? 'Unpin' : 'Pin'}>{m.pinned_at ? <PinOff className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />}</button>
              {isMe && !isClaude && <button onClick={onEdit} className="p-1 rounded-full text-zinc-400 hover:bg-zinc-100" title="Edit"><Pencil className="h-3.5 w-3.5" /></button>}
              {canDelete && <button onClick={onDelete} className="p-1 rounded-full text-zinc-400 hover:text-red-500 hover:bg-zinc-100" title="Delete"><Trash2 className="h-3.5 w-3.5" /></button>}
              {reactOpen && (
                <div className="absolute bottom-full mb-1 bg-white border border-zinc-200 rounded-full shadow-lg px-1.5 py-1 flex gap-0.5 z-20">
                  {QUICK_EMOJIS.map(e => <button key={e} onClick={() => onReact(e)} className="hover:scale-125 transition-transform text-sm">{e}</button>)}
                </div>
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

function CardView({ card }: { card: NonNullable<TeamMsg['card']> }) {
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
