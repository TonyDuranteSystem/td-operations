'use client'

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef } from 'react'
import { cn } from '@/lib/utils'
import type { InboxMessage, InboxConversation } from '@/lib/types'

interface MessageThreadProps {
  conversation: InboxConversation
}

interface ThreadResponse {
  conversationId: string
  channel: string
  messages: InboxMessage[]
  subject?: string
  name?: string
}

function formatMessageTime(dateStr: string) {
  if (!dateStr) return ''
  const date = new Date(dateStr)
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

export function MessageThread({ conversation }: MessageThreadProps) {
  const queryClient = useQueryClient()
  const scrollRef = useRef<HTMLDivElement>(null)

  const { data, isLoading } = useQuery<ThreadResponse>({
    queryKey: ['inbox-messages', conversation.id],
    queryFn: () =>
      fetch(`/api/inbox/messages/${encodeURIComponent(conversation.id)}`).then(
        (r) => r.json()
      ),
    refetchInterval: 15_000,
  })

  // Mark as read when opening a conversation with unread messages
  const markReadMutation = useMutation({
    mutationFn: () =>
      fetch('/api/inbox/mark-read', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          conversationId: conversation.id,
          channel: conversation.channel,
        }),
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['inbox-stats'] })
      queryClient.invalidateQueries({ queryKey: ['inbox-conversations'] })
    },
  })

  useEffect(() => {
    if (conversation.unread > 0) {
      markReadMutation.mutate()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversation.id])

  // Auto-scroll to bottom when messages load
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [data?.messages])

  if (isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="animate-spin h-6 w-6 border-2 border-zinc-300 border-t-zinc-600 rounded-full" />
      </div>
    )
  }

  const messages = data?.messages || []

  if (messages.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-zinc-400 text-sm">
        No messages in this conversation
      </div>
    )
  }

  return (
    <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
      {data?.subject && (
        <div className="text-center py-2">
          <span className="text-xs font-medium text-zinc-500 bg-zinc-100 px-3 py-1 rounded-full">
            {data.subject}
          </span>
        </div>
      )}

      {messages.map((msg) => {
        const isOutbound = msg.direction === 'outbound'

        return (
          <div
            key={msg.id}
            className={cn('flex', isOutbound ? 'justify-end' : 'justify-start')}
          >
            <div
              className={cn(
                'max-w-[75%] rounded-2xl px-4 py-2.5',
                isOutbound
                  ? 'bg-blue-500 text-white rounded-br-md'
                  : 'bg-white border border-zinc-200 text-zinc-900 rounded-bl-md'
              )}
            >
              {!isOutbound && (
                <p
                  className={cn(
                    'text-xs font-semibold mb-1',
                    isOutbound ? 'text-blue-100' : 'text-zinc-500'
                  )}
                >
                  {msg.sender}
                </p>
              )}

              <p className="text-sm whitespace-pre-wrap break-words">
                {msg.content}
              </p>

              <p
                className={cn(
                  'text-[10px] mt-1',
                  isOutbound ? 'text-blue-200' : 'text-zinc-400'
                )}
              >
                {formatMessageTime(msg.createdAt)}
              </p>
            </div>
          </div>
        )
      })}
    </div>
  )
}
