'use client'

import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Send, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { trackOpenMarkRead } from '@/lib/inbox/pending-mark-read'

interface TelegramMessage {
  id: string
  content_text: string | null
  direction: 'inbound' | 'outbound'
  sender_name: string | null
  created_at: string
}

interface TelegramThreadProps {
  groupId: string
}

function formatTimestamp(dateStr: string) {
  if (!dateStr) return ''
  return new Date(dateStr).toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
  })
}

/**
 * Telegram's thread view — deliberately a slim, text-only sibling of
 * WhatsappThread rather than a shared/generalized component: WhatsApp's
 * version is wired to WhatsApp-specific attachment staging and an AI-suggest
 * endpoint that don't exist for Telegram, and building those just to satisfy
 * a shared component would be scope neither asked for nor verified as
 * needed. This covers exactly what was asked: receive and reply.
 */
export function TelegramThread({ groupId }: TelegramThreadProps) {
  const bottomRef = useRef<HTMLDivElement>(null)
  const sendingRef = useRef(false)
  const [text, setText] = useState('')
  const queryClient = useQueryClient()

  // Same open-time mark-read pattern as WhatsApp's thread (2026-09-18 fix) —
  // built in from the start here rather than retrofitted, since the exact
  // same gap (nothing ever calling mark-read on open) is how that bug happened.
  useEffect(() => {
    const call = fetch('/api/inbox/telegram/mark-read', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ groupId, unread: false }),
    }).then(() => {
      queryClient.invalidateQueries({ queryKey: ['inbox-conversations'] })
      queryClient.invalidateQueries({ queryKey: ['inbox-stats'] })
    })
    trackOpenMarkRead(`telegram:${groupId}`, call)
  }, [groupId, queryClient])

  const { data, isLoading, error } = useQuery<{ messages: TelegramMessage[] }>({
    queryKey: ['telegram-messages', groupId],
    queryFn: () => fetch(`/api/inbox/telegram/messages/${encodeURIComponent(groupId)}`).then((r) => r.json()),
    refetchInterval: 60_000,
  })

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'instant' })
  }, [data?.messages])

  useEffect(() => {
    setText('')
  }, [groupId])

  const sendMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch('/api/inbox/reply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversationId: groupId, message: text, channel: 'telegram' }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error || 'Send failed')
      }
      return res.json()
    },
    onSuccess: () => {
      setText('')
      queryClient.invalidateQueries({ queryKey: ['telegram-messages', groupId] })
    },
    onError: (err: Error) => {
      toast.error(err.message || 'Send failed')
    },
  })

  const handleSend = () => {
    if (!text.trim() || sendingRef.current || sendMutation.isPending) return
    sendingRef.current = true
    sendMutation.mutate(undefined, { onSettled: () => { sendingRef.current = false } })
  }

  const messages = data?.messages ?? []

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {isLoading ? (
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className={cn('flex', i % 3 === 0 ? 'justify-end' : 'justify-start')}>
              <div className="h-10 bg-zinc-100 rounded-2xl animate-pulse w-48" />
            </div>
          ))}
        </div>
      ) : error ? (
        <div className="flex-1 flex items-center justify-center text-zinc-400 text-sm">
          Failed to load messages
        </div>
      ) : messages.length === 0 ? (
        <div className="flex-1 flex items-center justify-center text-zinc-400 text-sm">
          No messages in this conversation
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto p-4 space-y-2 bg-zinc-50">
          {messages.map((msg) => {
            const isOutbound = msg.direction === 'outbound'
            return (
              <div key={msg.id} className={cn('flex', isOutbound ? 'justify-end' : 'justify-start')}>
                <div
                  className={cn(
                    'max-w-[70%] px-3 py-2 rounded-2xl shadow-sm',
                    isOutbound ? 'bg-sky-100 text-zinc-800 rounded-br-sm' : 'bg-white text-zinc-800 rounded-bl-sm'
                  )}
                >
                  <p className="text-sm whitespace-pre-wrap break-words">{msg.content_text}</p>
                  <p className="text-[10px] text-zinc-400 mt-1 text-right">
                    {msg.sender_name ?? (isOutbound ? 'Antonio' : 'Contact')}
                    {' · '}
                    {formatTimestamp(msg.created_at)}
                  </p>
                </div>
              </div>
            )
          })}
          <div ref={bottomRef} />
        </div>
      )}

      <div className="border-t bg-white shrink-0 p-2">
        {sendMutation.isError && (
          <p className="text-xs text-red-600 px-1 pb-1">Failed to send: {sendMutation.error.message}</p>
        )}
        <div className="flex items-end gap-2">
          <textarea
            className="compose-reply-textarea flex-1 resize-none rounded-lg border border-zinc-200 px-3 py-2 text-sm outline-none focus:border-blue-400 min-h-[40px] max-h-60"
            rows={1}
            placeholder="Type a Telegram message…"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== 'Enter' || e.shiftKey) return
              e.preventDefault()
              handleSend()
            }}
          />
          <button
            onClick={handleSend}
            disabled={!text.trim() || sendMutation.isPending}
            className="inline-flex items-center justify-center h-9 w-9 shrink-0 rounded-lg bg-sky-600 text-white disabled:opacity-40 disabled:cursor-not-allowed hover:bg-sky-700 transition-colors"
            aria-label="Send"
          >
            {sendMutation.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
          </button>
        </div>
      </div>
    </div>
  )
}
