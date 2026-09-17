'use client'

import { useEffect, useRef, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Send, Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'

interface WhatsAppMessage {
  id: string
  content_text: string | null
  direction: 'inbound' | 'outbound'
  sender_name: string | null
  sender_phone: string | null
  created_at: string
  content_type: string | null
  media_url: string | null
}

interface WhatsappThreadProps {
  groupId: string
}

function formatTimestamp(dateStr: string) {
  if (!dateStr) return ''
  const date = new Date(dateStr)
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

export function WhatsappThread({ groupId }: WhatsappThreadProps) {
  const bottomRef = useRef<HTMLDivElement>(null)
  const sendingRef = useRef(false)
  const [text, setText] = useState('')
  const queryClient = useQueryClient()

  const { data, isLoading, error } = useQuery<{ messages: WhatsAppMessage[] }>({
    queryKey: ['whatsapp-messages', groupId],
    queryFn: () =>
      fetch(`/api/inbox/whatsapp/messages/${encodeURIComponent(groupId)}`).then((r) =>
        r.json()
      ),
    refetchInterval: 60_000,
  })

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'instant' })
  }, [data?.messages])

  const sendMutation = useMutation({
    mutationFn: async (message: string) => {
      const res = await fetch('/api/inbox/reply', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversationId: groupId, message, channel: 'whatsapp' }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error || 'Send failed')
      }
      return res.json()
    },
    onSuccess: () => {
      setText('')
      queryClient.invalidateQueries({ queryKey: ['whatsapp-messages', groupId] })
    },
  })

  const handleSend = () => {
    const message = text.trim()
    if (!message || sendMutation.isPending || sendingRef.current) return
    sendingRef.current = true
    sendMutation.mutate(message, { onSettled: () => { sendingRef.current = false } })
  }

  const messages = data?.messages ?? []

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {isLoading ? (
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div
              key={i}
              className={cn('flex', i % 3 === 0 ? 'justify-end' : 'justify-start')}
            >
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
            const isImage = msg.content_type === 'image'
            const isOtherMedia = !isImage && msg.content_type !== 'text' && !!msg.media_url

            return (
              <div
                key={msg.id}
                className={cn('flex', isOutbound ? 'justify-end' : 'justify-start')}
              >
                <div
                  className={cn(
                    'max-w-[70%] px-3 py-2 rounded-2xl shadow-sm',
                    isOutbound
                      ? 'bg-green-100 text-zinc-800 rounded-br-sm'
                      : 'bg-white text-zinc-800 rounded-bl-sm'
                  )}
                >
                  {isImage && msg.media_url ? (
                    <a href={msg.media_url} target="_blank" rel="noopener noreferrer">
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={msg.media_url}
                        alt={msg.content_text || 'Image'}
                        className="max-w-full rounded-lg mb-1"
                      />
                    </a>
                  ) : isOtherMedia ? (
                    <a
                      href={msg.media_url ?? undefined}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-sm italic text-blue-600 underline"
                    >
                      {msg.content_text || `Attachment (${msg.content_type})`}
                    </a>
                  ) : (
                    <p className="text-sm whitespace-pre-wrap break-words">
                      {msg.content_text}
                    </p>
                  )}
                  <p className="text-[10px] text-zinc-400 mt-1 text-right">
                    {msg.sender_name ?? msg.sender_phone ?? (isOutbound ? 'Antonio' : 'Contact')}
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

      {/* Reply bar — Enter to send, Shift+Enter for a newline, matching the
          other chat channels' composer (compose-reply.tsx). */}
      <div className="border-t bg-white p-2 shrink-0">
        {sendMutation.isError && (
          <p className="text-xs text-red-600 px-1 pb-1">
            Failed to send: {sendMutation.error.message}
          </p>
        )}
        <div className="flex items-end gap-2">
          <textarea
            className="compose-reply-textarea flex-1 resize-none rounded-lg border border-zinc-200 px-3 py-2 text-sm outline-none focus:border-blue-400 min-h-[40px] max-h-32"
            rows={1}
            placeholder="Type a WhatsApp message…"
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
            className="inline-flex items-center justify-center h-9 w-9 shrink-0 rounded-lg bg-green-600 text-white disabled:opacity-40 disabled:cursor-not-allowed hover:bg-green-700 transition-colors"
            aria-label="Send"
          >
            {sendMutation.isPending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Send className="h-4 w-4" />
            )}
          </button>
        </div>
      </div>
    </div>
  )
}
