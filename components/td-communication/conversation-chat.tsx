'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { Send, Loader2, MessageCircle } from 'lucide-react'
import { toast } from 'sonner'
import { format, parseISO } from 'date-fns'
import { createClient } from '@/lib/supabase/client'
import { cn } from '@/lib/utils'
import { isOwnMessage } from '@/lib/td-communication/helpers'
import type { CommMessage, CommParticipant } from '@/lib/td-communication/types'

function formatTime(dateStr: string): string {
  try {
    return format(parseISO(dateStr), 'MMM d, h:mm a')
  } catch {
    return ''
  }
}

/**
 * Realtime conversation chat for TD Communication, shared by the CRM staff page
 * and the standalone partner page. Loads the thread over the API, then
 * subscribes to comm_messages (INSERT = append, UPDATE = drop on
 * soft-delete, per R100). Sends via POST /api/conversations/messages and
 * surfaces server errors per R099.
 */
export function ConversationChat({
  conversationId,
  viewer,
}: {
  conversationId: string
  viewer: CommParticipant
}) {
  const [messages, setMessages] = useState<CommMessage[]>([])
  const [loading, setLoading] = useState(true)
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const scrollRef = useRef<HTMLDivElement>(null)

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [])

  // Initial load + reload when the selected conversation changes.
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setMessages([])
    ;(async () => {
      try {
        const res = await fetch(
          `/api/conversations/messages?conversation_id=${encodeURIComponent(conversationId)}`,
        )
        const data = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(data.error || 'Failed to load messages.')
        if (!cancelled) setMessages((data.messages ?? []) as CommMessage[])
      } catch (err) {
        if (!cancelled) {
          toast.error(err instanceof Error && err.message ? err.message : 'Failed to load messages.')
        }
      } finally {
        if (!cancelled) setLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [conversationId])

  useEffect(() => {
    scrollToBottom()
  }, [messages, loading, scrollToBottom])

  // Realtime: append new messages, drop soft-deleted ones live.
  useEffect(() => {
    const supabase = createClient()
    const channel = supabase
      .channel(`td-comm-${conversationId}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'comm_messages',
          filter: `conversation_id=eq.${conversationId}`,
        },
        (payload) => {
          const m = payload.new as CommMessage
          if (m.deleted_at) return
          setMessages((prev) => (prev.some((x) => x.id === m.id) ? prev : [...prev, m]))
        },
      )
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'comm_messages',
          filter: `conversation_id=eq.${conversationId}`,
        },
        (payload) => {
          const m = payload.new as CommMessage
          setMessages((prev) =>
            m.deleted_at
              ? prev.filter((x) => x.id !== m.id)
              : prev.map((x) => (x.id === m.id ? m : x)),
          )
        },
      )
      .subscribe()
    return () => {
      supabase.removeChannel(channel)
    }
  }, [conversationId])

  const handleSend = useCallback(async () => {
    const body = input.trim()
    if (!body || sending) return
    setSending(true)
    setInput('')
    try {
      const res = await fetch('/api/conversations/messages', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversation_id: conversationId, body }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.error || 'Failed to send message.')
      // Optimistically append; realtime de-dupes by id.
      const sent = data.message as CommMessage
      setMessages((prev) => (prev.some((x) => x.id === sent.id) ? prev : [...prev, sent]))
    } catch (err) {
      toast.error(err instanceof Error && err.message ? err.message : 'Failed to send message.')
      setInput(body)
    } finally {
      setSending(false)
    }
  }, [input, sending, conversationId])

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
    }
  }

  return (
    <div className="flex flex-col flex-1 min-h-0 bg-white rounded-xl border shadow-sm overflow-hidden">
      <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto p-4 space-y-2">
        {loading ? (
          <div className="flex items-center justify-center h-full">
            <Loader2 className="h-6 w-6 animate-spin text-zinc-400" />
          </div>
        ) : messages.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-zinc-400">
            <MessageCircle className="h-12 w-12 mb-3" />
            <p className="text-sm font-medium">No messages yet</p>
            <p className="text-xs mt-1">Send a message to start the conversation</p>
          </div>
        ) : (
          messages.map((msg) => {
            const own = isOwnMessage(msg, viewer.type, viewer.id)
            return (
              <div key={msg.id} className={cn('flex', own ? 'justify-end' : 'justify-start')}>
                <div
                  className={cn(
                    'max-w-[75%] px-3.5 py-2 rounded-2xl text-sm',
                    own
                      ? 'bg-blue-600 text-white rounded-br-md'
                      : 'bg-zinc-100 text-zinc-900 rounded-bl-md',
                  )}
                >
                  {!own && (
                    <p className="text-[10px] font-medium text-zinc-500 mb-0.5">
                      {msg.sender_name || (msg.sender_type === 'staff' ? 'TD Team' : 'Partner')}
                    </p>
                  )}
                  <p className="whitespace-pre-wrap break-words">{msg.body}</p>
                  <p
                    className={cn(
                      'text-[10px] mt-1',
                      own ? 'text-blue-200 text-right' : 'text-zinc-400',
                    )}
                  >
                    {formatTime(msg.created_at)}
                  </p>
                </div>
              </div>
            )
          })
        )}
      </div>

      <div className="border-t p-2 sm:p-3">
        <div className="flex items-end gap-2">
          <textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            rows={1}
            placeholder="Type a message…"
            className="flex-1 min-w-0 px-3 py-2.5 text-sm bg-white border border-zinc-200 rounded-2xl focus:outline-none focus:ring-2 focus:ring-blue-200 resize-none max-h-[120px]"
          />
          <button
            onClick={handleSend}
            disabled={sending || !input.trim()}
            className="w-11 h-11 rounded-full bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40 flex items-center justify-center shrink-0 transition-colors"
            title="Send"
          >
            {sending ? <Loader2 className="h-5 w-5 animate-spin" /> : <Send className="h-5 w-5" />}
          </button>
        </div>
      </div>
    </div>
  )
}
