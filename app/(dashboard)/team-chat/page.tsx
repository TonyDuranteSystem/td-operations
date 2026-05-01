'use client'

import { useState, useEffect, useRef, useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'
import { toast } from 'sonner'
import { Send, Loader2, Users } from 'lucide-react'
import { useNotificationSound, senderPatternIndex } from '@/lib/hooks/use-notification-sound'
import { format, isToday, isYesterday } from 'date-fns'

// 8 distinct avatar colors for team members (deterministic per sender_id)
const AVATAR_COLORS = [
  'bg-blue-500',
  'bg-emerald-500',
  'bg-violet-500',
  'bg-orange-500',
  'bg-rose-500',
  'bg-cyan-500',
  'bg-amber-500',
  'bg-indigo-500',
]

function senderColor(senderId: string): string {
  let h = 0
  for (let i = 0; i < senderId.length; i++) {
    h = (h << 5) - h + senderId.charCodeAt(i)
    h |= 0
  }
  return AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length]
}

function initials(name: string): string {
  return name
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map(w => w[0].toUpperCase())
    .join('')
}

function formatMsgTime(ts: string): string {
  const d = new Date(ts)
  if (isToday(d)) return format(d, 'HH:mm')
  if (isYesterday(d)) return `Yesterday ${format(d, 'HH:mm')}`
  return format(d, 'MMM d, HH:mm')
}

interface Msg {
  id: string
  sender_id: string
  sender_name: string
  message: string
  created_at: string
  read_at: string | null
}

export default function TeamChatPage() {
  const [threadId, setThreadId] = useState<string | null>(null)
  const [currentUserId, setCurrentUserId] = useState<string | null>(null)
  const [messages, setMessages] = useState<Msg[]>([])
  const [loading, setLoading] = useState(true)
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const bottomRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const { playSenderSound } = useNotificationSound()

  // Track which sender IDs we've seen so we can show a legend
  const knownSenders = useRef<Map<string, string>>(new Map()) // id → name

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'smooth') => {
    bottomRef.current?.scrollIntoView({ behavior })
  }, [])

  // Initial load
  useEffect(() => {
    fetch('/api/team-chat')
      .then(r => {
        if (!r.ok) throw new Error('Failed to load team chat')
        return r.json()
      })
      .then(data => {
        setThreadId(data.thread_id)
        setCurrentUserId(data.current_user_id)
        setMessages(data.messages)
        data.messages.forEach((m: Msg) => knownSenders.current.set(m.sender_id, m.sender_name))
      })
      .catch(() => toast.error('Failed to load team chat'))
      .finally(() => setLoading(false))
  }, [])

  // Scroll to bottom on initial load
  useEffect(() => {
    if (!loading && messages.length > 0) {
      scrollToBottom('instant')
    }
  }, [loading]) // eslint-disable-line react-hooks/exhaustive-deps

  // Supabase Realtime subscription
  useEffect(() => {
    if (!threadId) return
    const supabase = createClient()
    const channel = supabase
      .channel(`team-chat-${threadId}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'internal_messages',
          filter: `thread_id=eq.${threadId}`,
        },
        (payload) => {
          const msg = payload.new as Msg
          setMessages(prev => {
            if (prev.some(m => m.id === msg.id)) return prev
            return [...prev, msg]
          })
          knownSenders.current.set(msg.sender_id, msg.sender_name)

          // Play sender sound for messages from others
          if (msg.sender_id !== currentUserId) {
            playSenderSound(msg.sender_id)

            // Mark as read via API (fire and forget)
            fetch(`/api/internal/threads/${threadId}`, { method: 'GET' }).catch(() => {})
          }
        }
      )
      .subscribe()

    return () => { supabase.removeChannel(channel) }
  }, [threadId, currentUserId, playSenderSound])

  // Scroll to bottom on new messages
  useEffect(() => {
    scrollToBottom()
  }, [messages, scrollToBottom])

  const handleSend = useCallback(async () => {
    const msg = text.trim()
    if (!msg || !threadId || sending) return
    setSending(true)
    setText('')
    try {
      const res = await fetch(`/api/internal/threads/${threadId}/messages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: msg }),
      })
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || 'Failed to send')
      }
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : 'Failed to send message')
      setText(msg) // restore
    } finally {
      setSending(false)
      inputRef.current?.focus()
    }
  }, [text, threadId, sending])

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  // Group messages by sender (consecutive runs)
  const grouped = messages.reduce<Array<{ senderId: string; senderName: string; msgs: Msg[] }>>(
    (acc, msg) => {
      const last = acc[acc.length - 1]
      if (last && last.senderId === msg.sender_id) {
        last.msgs.push(msg)
      } else {
        acc.push({ senderId: msg.sender_id, senderName: msg.sender_name, msgs: [msg] })
      }
      return acc
    },
    []
  )

  // Pattern descriptions for the legend
  const PATTERN_LABELS = ['Rising ♪♪', 'Low→High ♩♪', 'Three pings ♩♩♩', 'Descending ♪♩♩', 'Chime ♩♪']

  const uniqueSenders = Array.from(
    new Map(messages.map(m => [m.sender_id, m.sender_name])).entries()
  ).filter(([id]) => id !== currentUserId)

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-zinc-200 bg-white shrink-0">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-zinc-100 rounded-lg">
            <Users className="h-5 w-5 text-zinc-600" />
          </div>
          <div>
            <h1 className="text-base font-semibold text-zinc-900">Team Chat</h1>
            <p className="text-xs text-zinc-500">Internal — not visible to clients</p>
          </div>
        </div>

        {/* Sound legend */}
        {uniqueSenders.length > 0 && (
          <div className="flex items-center gap-3">
            {uniqueSenders.map(([id, name]) => (
              <div key={id} className="flex items-center gap-1.5 text-xs text-zinc-500">
                <span className={`w-5 h-5 rounded-full ${senderColor(id)} flex items-center justify-center text-[9px] font-bold text-white`}>
                  {initials(name)}
                </span>
                <span className="hidden sm:inline">{name.split(' ')[0]}: {PATTERN_LABELS[senderPatternIndex(id)]}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto px-4 py-4 space-y-1">
        {loading ? (
          <div className="flex items-center justify-center h-full">
            <Loader2 className="h-6 w-6 animate-spin text-zinc-400" />
          </div>
        ) : messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-zinc-400 gap-2">
            <Users className="h-10 w-10" />
            <p className="text-sm">No messages yet. Say hi!</p>
          </div>
        ) : (
          grouped.map((group, gi) => {
            const isMe = group.senderId === currentUserId
            return (
              <div key={gi} className={`flex gap-2 ${isMe ? 'flex-row-reverse' : 'flex-row'} items-end mb-2`}>
                {/* Avatar — only for others */}
                {!isMe && (
                  <div className={`w-7 h-7 rounded-full ${senderColor(group.senderId)} flex items-center justify-center text-[10px] font-bold text-white shrink-0 mb-1`}>
                    {initials(group.senderName)}
                  </div>
                )}

                <div className={`flex flex-col gap-0.5 max-w-[70%] ${isMe ? 'items-end' : 'items-start'}`}>
                  {/* Sender name — only for others, first bubble of group */}
                  {!isMe && (
                    <span className="text-[11px] font-semibold text-zinc-500 px-1">
                      {group.senderName}
                    </span>
                  )}

                  {group.msgs.map((msg, mi) => (
                    <div key={msg.id} className="flex flex-col gap-0.5">
                      <div
                        className={`px-3 py-2 rounded-2xl text-sm leading-relaxed ${
                          isMe
                            ? 'bg-zinc-800 text-white rounded-br-sm'
                            : 'bg-white border border-zinc-200 text-zinc-900 rounded-bl-sm shadow-sm'
                        }`}
                        style={{ wordBreak: 'break-word' }}
                      >
                        {msg.message}
                      </div>
                      {/* Timestamp on last bubble of group */}
                      {mi === group.msgs.length - 1 && (
                        <span className={`text-[10px] text-zinc-400 px-1 ${isMe ? 'text-right' : 'text-left'}`}>
                          {formatMsgTime(msg.created_at)}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )
          })
        )}
        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div className="shrink-0 px-4 py-3 border-t border-zinc-200 bg-white">
        <div className="flex items-end gap-2">
          <textarea
            ref={inputRef}
            value={text}
            onChange={e => setText(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Message team… (Enter to send, Shift+Enter for newline)"
            rows={1}
            disabled={loading || !threadId}
            className="flex-1 resize-none px-3 py-2 text-sm border border-zinc-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-zinc-400 disabled:opacity-50 max-h-32 overflow-y-auto"
            style={{ minHeight: '40px' }}
          />
          <button
            onClick={handleSend}
            disabled={!text.trim() || sending || !threadId}
            className="p-2 rounded-xl bg-zinc-800 text-white hover:bg-zinc-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors shrink-0"
          >
            {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          </button>
        </div>
        <p className="text-[10px] text-zinc-400 mt-1 px-1">
          Each team member has a unique notification sound — no more guessing who wrote
        </p>
      </div>
    </div>
  )
}
