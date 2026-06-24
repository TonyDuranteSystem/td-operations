'use client'

import { useEffect, useRef } from 'react'
import { useQuery } from '@tanstack/react-query'
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

  if (isLoading) {
    return (
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
    )
  }

  if (error) {
    return (
      <div className="flex-1 flex items-center justify-center text-zinc-400 text-sm">
        Failed to load messages
      </div>
    )
  }

  const messages = data?.messages ?? []

  if (messages.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-zinc-400 text-sm">
        No messages in this conversation
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-y-auto p-4 space-y-2 bg-zinc-50">
      {messages.map((msg) => {
        const isOutbound = msg.direction === 'outbound'
        const isMedia = msg.content_type === 'media'

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
              {isMedia ? (
                <p className="text-sm italic text-zinc-500">
                  {msg.content_text || 'Media (image/video)'}
                </p>
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
  )
}
