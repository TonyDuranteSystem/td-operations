'use client'

/**
 * ThreadEmailPanel — the "Email" tab inside /portal-chats for one client:
 * that client's Gmail correspondence (support@ mailbox), reusing the inbox's
 * shipped thread view (MessageThread renders sandboxed email HTML; opening a
 * thread marks it read in Gmail, which clears the GREEN dot) and reply box.
 */

import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Loader2, Mail, Paperclip, RefreshCw } from 'lucide-react'
import { cn } from '@/lib/utils'
import { MessageThread } from '@/components/inbox/message-thread'
import { ComposeReply } from '@/components/inbox/compose-reply'
import type { InboxConversation } from '@/lib/types'

interface ThreadEmailPanelProps {
  accountId: string | null
  contactId: string | null
}

function formatDate(dateStr: string) {
  if (!dateStr) return ''
  const date = new Date(dateStr)
  const days = Math.floor((Date.now() - date.getTime()) / 86_400_000)
  if (days === 0) return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })
  if (days < 7) return date.toLocaleDateString('en-US', { weekday: 'short' })
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

export function ThreadEmailPanel({ accountId, contactId }: ThreadEmailPanelProps) {
  const [selected, setSelected] = useState<InboxConversation | null>(null)
  const [directionFilter, setDirectionFilter] = useState<'all' | 'received' | 'sent'>('all')
  const queryClient = useQueryClient()

  const params = new URLSearchParams()
  if (accountId) params.set('account_id', accountId)
  else if (contactId) params.set('contact_id', contactId)

  const { data, isLoading, isFetching, refetch } = useQuery<{
    conversations: InboxConversation[]
    emails: string[]
    error?: string
  }>({
    queryKey: ['client-emails', accountId, contactId],
    queryFn: () => fetch(`/api/portal-chats/client-emails?${params}`).then(r => r.json()),
    enabled: !!(accountId || contactId),
    refetchInterval: 60_000,
  })

  const allConversations = data?.conversations ?? []
  const conversations = allConversations.filter(
    c => directionFilter === 'all' || c.direction === directionFilter
  )

  if (selected) {
    return (
      <div className="flex-1 flex flex-col min-h-0">
        <div className="flex items-center gap-2 px-3 py-2 border-b bg-white shrink-0">
          <button
            onClick={() => {
              setSelected(null)
              // Opening the thread marked it read in Gmail — refresh list + green dots
              queryClient.invalidateQueries({ queryKey: ['client-emails'] })
              queryClient.invalidateQueries({ queryKey: ['email-unread'] })
            }}
            className="p-1 rounded hover:bg-zinc-100 text-zinc-500"
            title="Back to email list"
          >
            <ArrowLeft className="h-4 w-4" />
          </button>
          <Mail className="h-4 w-4 text-zinc-400 shrink-0" />
          <p className="text-sm font-medium text-zinc-800 truncate">
            {selected.subject || selected.name}
          </p>
        </div>
        {/* Keyed: remount per conversation resets scroll + collapse state
            (same rule as the Inbox mount — council 2026-07-28). */}
        <MessageThread key={selected.id} conversation={selected} mailbox="support" />
        <ComposeReply conversation={selected} mailbox="support" />
      </div>
    )
  }

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="flex items-center justify-between gap-2 px-4 py-2 border-b bg-white shrink-0">
        <p className="text-xs text-zinc-500 truncate">
          Emails with this client{data?.emails?.length ? ` (${data.emails.join(', ')})` : ''} — support@ mailbox
        </p>
        <div className="flex items-center gap-1 shrink-0">
          {(['all', 'received', 'sent'] as const).map(f => (
            <button
              key={f}
              onClick={() => setDirectionFilter(f)}
              className={cn(
                'px-2 py-0.5 rounded text-[11px] font-medium transition-colors capitalize',
                directionFilter === f
                  ? 'bg-emerald-100 text-emerald-700'
                  : 'text-zinc-400 hover:bg-zinc-100'
              )}
            >
              {f}
            </button>
          ))}
          <button
            onClick={() => refetch()}
            className="p-1 rounded hover:bg-zinc-100 text-zinc-400"
            title="Refresh"
          >
            <RefreshCw className={cn('h-3.5 w-3.5', isFetching && 'animate-spin')} />
          </button>
        </div>
      </div>

      {isLoading ? (
        <div className="flex-1 flex items-center justify-center">
          <Loader2 className="h-5 w-5 animate-spin text-zinc-400" />
        </div>
      ) : conversations.length === 0 ? (
        <div className="flex-1 flex flex-col items-center justify-center text-zinc-400">
          <Mail className="h-8 w-8 mb-2 stroke-1" />
          <p className="text-sm">
            {allConversations.length > 0 ? `No ${directionFilter} emails` : 'No emails with this client'}
          </p>
          {data?.emails?.length === 0 && allConversations.length === 0 && (
            <p className="text-xs mt-1">No email address on the CRM contact</p>
          )}
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto">
          {conversations.map(conv => (
            <button
              key={conv.id}
              onClick={() => setSelected(conv)}
              className="w-full px-4 py-3 text-left border-b hover:bg-zinc-50 transition-colors"
            >
              <div className="flex items-center justify-between gap-2">
                <span className={cn(
                  'text-sm truncate',
                  conv.unread > 0 ? 'font-semibold text-zinc-900' : 'font-medium text-zinc-700'
                )}>
                  {conv.subject || '(no subject)'}
                </span>
                <span className="flex items-center gap-1.5 shrink-0">
                  {conv.linked && (
                    <span
                      className="text-[9px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded bg-blue-100 text-blue-700"
                      title="Manually linked to this client"
                    >
                      Linked
                    </span>
                  )}
                  <span className="text-xs text-zinc-400">{formatDate(conv.lastMessageAt)}</span>
                </span>
              </div>
              <div className="flex items-center justify-between gap-2 mt-0.5">
                <p className="text-xs text-zinc-500 truncate flex-1">{conv.preview}</p>
                <span className="flex items-center gap-1 shrink-0">
                  {conv.hasAttachment && <Paperclip className="h-3 w-3 text-zinc-400" />}
                  {conv.unread > 0 && (
                    <span className="px-1.5 py-0.5 bg-emerald-500 text-white text-[10px] rounded-full font-semibold">
                      {conv.unread}
                    </span>
                  )}
                </span>
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
