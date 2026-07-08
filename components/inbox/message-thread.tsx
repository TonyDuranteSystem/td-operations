'use client'

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef } from 'react'
import { cn } from '@/lib/utils'
import type { InboxMessage, InboxConversation } from '@/lib/types'
import { sanitizeEmailHtml } from '@/lib/html-escape'
import { EmailHtmlFrame } from './email-html-frame'

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

export function MessageThread({ conversation, mailbox }: MessageThreadProps & { mailbox?: string }) {
  const queryClient = useQueryClient()
  const scrollRef = useRef<HTMLDivElement>(null)

  const { data, isLoading } = useQuery<ThreadResponse>({
    queryKey: ['inbox-messages', conversation.id, mailbox],
    queryFn: () => {
      const params = mailbox ? `?mailbox=${mailbox}` : ''
      return fetch(`/api/inbox/messages/${encodeURIComponent(conversation.id)}${params}`).then(
        (r) => r.json()
      )
    },
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
          mailbox,
        }),
      }),
    onSuccess: () => {
      // Delay refetch significantly — Gmail's index takes 30-60s to reflect label changes
      // The optimistic update in the useEffect below handles immediate UI
      setTimeout(() => {
        queryClient.invalidateQueries({ queryKey: ['inbox-stats'] })
        queryClient.invalidateQueries({ queryKey: ['inbox-conversations'] })
      }, 60_000)
    },
  })

  useEffect(() => {
    // Optimistically clear unread badge immediately in the cache
    queryClient.setQueriesData<{ conversations: InboxConversation[]; total: number }>(
      { queryKey: ['inbox-conversations'] },
      (old) => {
        if (!old) return old
        return {
          ...old,
          conversations: old.conversations.map((c) =>
            c.id === conversation.id ? { ...c, unread: 0 } : c
          ),
        }
      }
    )

    // Then fire the actual API call to Gmail
    markReadMutation.mutate()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversation.id])

  // Chat channels: auto-scroll to bottom (newest last, WhatsApp-style).
  // EMAIL threads render NEWEST FIRST (Luca 2026-07-08: no scrolling to the
  // bottom of long threads — and the growing email iframes made bottom-scroll
  // land mid-thread anyway), so they stay at the top.
  const isEmailThread = data?.channel === 'gmail'
  useEffect(() => {
    if (!scrollRef.current) return
    scrollRef.current.scrollTop = isEmailThread ? 0 : scrollRef.current.scrollHeight
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.messages])

  if (isLoading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="animate-spin h-6 w-6 border-2 border-zinc-300 border-t-zinc-600 rounded-full" />
      </div>
    )
  }

  const messages = isEmailThread
    ? [...(data?.messages || [])].reverse() // newest email on top
    : data?.messages || []

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
          <span className="inline-block max-w-full break-words text-xs font-medium text-zinc-500 bg-zinc-100 px-3 py-1 rounded-xl">
            {data.subject}
          </span>
        </div>
      )}

      {messages.map((msg) => {
        const isOutbound = msg.direction === 'outbound'
        const isEmail = msg.type === 'email'

        // Emails render Gmail-style: full-width cards with the body isolated in
        // a sandboxed iframe (email CSS preserved, scripts impossible). Chat
        // channels keep the bubble layout.
        if (isEmail) {
          return (
            <div
              key={msg.id}
              className={cn(
                'rounded-lg border bg-white overflow-hidden',
                isOutbound ? 'border-blue-200' : 'border-zinc-200'
              )}
            >
              <div
                className={cn(
                  'flex items-center justify-between gap-2 px-4 py-2 border-b text-xs',
                  isOutbound ? 'bg-blue-50/60 border-blue-100' : 'bg-zinc-50 border-zinc-100'
                )}
              >
                <span className="font-semibold text-zinc-700 truncate">
                  {isOutbound ? `To: ${msg.sender}` : msg.sender}
                </span>
                <span className="text-zinc-400 shrink-0">
                  {formatMessageTime(msg.createdAt)}
                </span>
              </div>

              <div className="px-2 py-1">
                {msg.content?.includes('<') && msg.content?.includes('>') ? (
                  // Inbound email HTML is attacker-controlled (anyone can email
                  // support@). Defense in depth: sanitized AND rendered in a
                  // sandboxed iframe with scripts disabled (security audit
                  // 2026-06-13, H8/H9).
                  <EmailHtmlFrame html={sanitizeEmailHtml(msg.content)} />
                ) : (
                  <p className="text-sm whitespace-pre-wrap break-words px-2 py-1.5">
                    {msg.content}
                  </p>
                )}
              </div>

              {msg.attachments && msg.attachments.length > 0 && (
                <div className="px-4 pb-3 pt-1 flex flex-wrap gap-1.5">
                  {msg.attachments.map((att, i) => (
                    <a
                      key={i}
                      href={`/api/inbox/attachment?messageId=${msg.id}&attachmentId=${encodeURIComponent(att.attachmentId)}&filename=${encodeURIComponent(att.filename)}&mimeType=${encodeURIComponent(att.mimeType)}${mailbox ? `&mailbox=${mailbox}` : ''}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center gap-2 text-xs px-2 py-1.5 rounded-lg bg-zinc-100 hover:bg-zinc-200 text-zinc-700 transition-colors"
                    >
                      <svg className="w-3.5 h-3.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
                      </svg>
                      <span className="truncate max-w-[200px]">{att.filename}</span>
                      <span className="text-[10px] opacity-60 shrink-0">
                        {att.size > 1024 * 1024
                          ? `${(att.size / 1024 / 1024).toFixed(1)}MB`
                          : `${Math.round(att.size / 1024)}KB`}
                      </span>
                    </a>
                  ))}
                </div>
              )}
            </div>
          )
        }

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

              {msg.content?.includes('<') && msg.content?.includes('>') ? (
                <div
                  className="text-sm prose prose-sm max-w-none break-words [&_a]:text-blue-600 [&_a]:underline"
                  // Inbound HTML is untrusted and renders in the staff CRM
                  // session, so it MUST be sanitized before
                  // dangerouslySetInnerHTML (security audit 2026-06-13, H9).
                  dangerouslySetInnerHTML={{ __html: sanitizeEmailHtml(msg.content) }}
                />
              ) : (
                <p className="text-sm whitespace-pre-wrap break-words">
                  {msg.content}
                </p>
              )}

              {msg.attachments && msg.attachments.length > 0 && (
                <div className="mt-2 space-y-1">
                  {msg.attachments.map((att, i) => (
                    <a
                      key={i}
                      href={`/api/inbox/attachment?messageId=${msg.id}&attachmentId=${encodeURIComponent(att.attachmentId)}&filename=${encodeURIComponent(att.filename)}&mimeType=${encodeURIComponent(att.mimeType)}${mailbox ? `&mailbox=${mailbox}` : ''}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className={cn(
                        'flex items-center gap-2 text-xs px-2 py-1.5 rounded-lg transition-colors',
                        isOutbound
                          ? 'bg-blue-400/30 hover:bg-blue-400/50 text-white'
                          : 'bg-zinc-100 hover:bg-zinc-200 text-zinc-700'
                      )}
                    >
                      <svg className="w-3.5 h-3.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.172 7l-6.586 6.586a2 2 0 102.828 2.828l6.414-6.586a4 4 0 00-5.656-5.656l-6.415 6.585a6 6 0 108.486 8.486L20.5 13" />
                      </svg>
                      <span className="truncate max-w-[200px]">{att.filename}</span>
                      <span className="text-[10px] opacity-60 shrink-0">
                        {att.size > 1024 * 1024
                          ? `${(att.size / 1024 / 1024).toFixed(1)}MB`
                          : `${Math.round(att.size / 1024)}KB`}
                      </span>
                    </a>
                  ))}
                </div>
              )}

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
