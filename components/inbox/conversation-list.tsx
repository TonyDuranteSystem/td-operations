'use client'

import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { Mail, CheckSquare, Square, Paperclip, Trash2, MessagesSquare, MessageSquare } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { markByKey } from '@/lib/inbox/color-marks'
import type { InboxConversation, InboxChannel } from '@/lib/types'

interface ConversationListProps {
  activeChannel: InboxChannel | null
  selectedId: string | null
  onSelect: (conversation: InboxConversation) => void
  onDeleted?: (id: string) => void
  deletedIds?: Set<string>
  unreadOverrides?: Map<string, number>
  // Bulk selection
  bulkMode: boolean
  selectedIds: Set<string>
  onToggleSelect: (id: string) => void
  // Gmail filters
  labelFilter?: string | null
  searchQuery?: string
}

const channelIcons: Record<InboxChannel, React.ElementType> = {
  gmail: Mail,
  portal: MessagesSquare,
  whatsapp: MessageSquare,
}

const channelColors: Record<InboxChannel, string> = {
  gmail: 'text-red-500',
  portal: 'text-purple-600',
  whatsapp: 'text-green-500',
}

function formatTime(dateStr: string) {
  if (!dateStr) return ''
  const date = new Date(dateStr)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24))

  if (diffDays === 0) {
    return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })
  }
  if (diffDays === 1) return 'Yesterday'
  if (diffDays < 7) return date.toLocaleDateString('en-US', { weekday: 'short' })
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

export function ConversationList({ activeChannel, selectedId, onSelect, onDeleted, deletedIds, unreadOverrides, bulkMode, selectedIds, onToggleSelect, labelFilter, searchQuery, mailbox, unreadFilter }: ConversationListProps & { mailbox?: string; unreadFilter?: 'all' | 'unread' | 'read' }) {
  const queryClient = useQueryClient()

  const deleteMutation = useMutation({
    mutationFn: async (conv: InboxConversation) => {
      if (conv.channel !== 'gmail') return
      const res = await fetch('/api/inbox/email-actions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ threadId: conv.id.replace('gmail:', ''), action: 'trash', mailbox }),
      })
      if (!res.ok) throw new Error('Failed to delete')
      return conv.id
    },
    onMutate: async (conv) => {
      await queryClient.cancelQueries({ queryKey: ['inbox-conversations'] })
      if (onDeleted) onDeleted(conv.id)
    },
    onSuccess: (_data, conv) => {
      toast('Email deleted', {
        action: {
          label: 'Undo',
          onClick: async () => {
            try {
              const res = await fetch('/api/inbox/email-actions', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ threadId: conv.id.replace('gmail:', ''), action: 'untrash', mailbox }),
              })
              if (res.ok) {
                toast.success('Email restored')
                queryClient.invalidateQueries({ queryKey: ['inbox-conversations'] })
              }
            } catch {
              toast.error('Failed to restore email')
            }
          },
        },
        duration: 8000,
      })
      setTimeout(() => {
        queryClient.invalidateQueries({ queryKey: ['inbox-conversations'] })
        queryClient.invalidateQueries({ queryKey: ['inbox-stats'] })
      }, 15000)
    },
    onError: () => {
      toast.error('Failed to delete email')
      queryClient.invalidateQueries({ queryKey: ['inbox-conversations'] })
    },
  })

  const isWhatsApp = activeChannel === 'whatsapp'

  const { data, isLoading } = useQuery<{ conversations: InboxConversation[]; total: number }>({
    queryKey: ['inbox-conversations', activeChannel, labelFilter, searchQuery, mailbox],
    queryFn: async () => {
      // Throw on non-2xx (R099): a failed refetch must NOT replace the list
      // with emptiness — react-query keeps the previous data on error, so a
      // Gmail rate-limit hiccup leaves the inbox visible instead of showing
      // "No conversations" until a manual refresh (Antonio 2026-07-08).
      const url = isWhatsApp
        ? '/api/inbox/whatsapp/conversations'
        : (() => {
            const params = new URLSearchParams()
            if (activeChannel) params.set('channel', activeChannel)
            if (labelFilter) params.set('label', labelFilter)
            if (searchQuery) params.set('q', searchQuery)
            if (mailbox) params.set('mailbox', mailbox)
            params.set('limit', '100')
            return `/api/inbox/conversations?${params}`
          })()
      const res = await fetch(url)
      const json = await res.json().catch(() => ({}))
      if (!res.ok) {
        throw new Error(json.error || 'Failed to load conversations')
      }
      return json
    },
    refetchInterval: searchQuery ? false : 30_000,
  })

  const conversations = (data?.conversations || [])
    .filter(c => !deletedIds?.has(c.id))
    .map(c => unreadOverrides?.has(c.id) ? { ...c, unread: unreadOverrides.get(c.id)! } : c)
    .filter(c => {
      if (!unreadFilter || unreadFilter === 'all') return true
      if (unreadFilter === 'unread') return c.unread > 0
      if (unreadFilter === 'read') return c.unread === 0
      return true
    })

  if (isLoading) {
    return (
      <div className="flex-1 overflow-y-auto">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="px-4 py-3 border-b animate-pulse">
            <div className="h-4 bg-zinc-200 rounded w-2/3 mb-2" />
            <div className="h-3 bg-zinc-100 rounded w-full" />
          </div>
        ))}
      </div>
    )
  }

  if (conversations.length === 0) {
    return (
      <div className="flex-1 flex items-center justify-center text-zinc-400 text-sm">
        No conversations
      </div>
    )
  }

  return (
    <div className="flex-1 overflow-y-auto">
      {conversations.map((conv) => {
        const Icon = channelIcons[conv.channel]
        const isSelected = selectedId === conv.id
        const isChecked = selectedIds.has(conv.id)
        const showCheckbox = !isWhatsApp && (bulkMode || conv.channel === 'gmail')
        const mark = markByKey(conv.colorMark)

        return (
          <div
            key={conv.id}
            // Marked rows are tinted with the mark color across the WHOLE row
            // (Antonio 2026-07-08: "the chat in the picker colored, not just
            // the dot"). Selection state wins over the tint; the colored left
            // edge stays in both states.
            style={
              mark
                ? {
                    boxShadow: `inset 3px 0 0 0 ${mark.hex}`,
                    ...(isSelected || isChecked ? {} : { backgroundColor: `${mark.hex}1f` }),
                  }
                : undefined
            }
            className={cn(
              'group w-full text-left px-4 py-3 border-b transition-colors hover:bg-zinc-50 flex items-start gap-2',
              isSelected && 'bg-blue-50 border-l-2 border-l-blue-500',
              isChecked && !isSelected && 'bg-blue-50/50',
              conv.unread > 0 && !isSelected && !isChecked && 'bg-white'
            )}
          >
            {/* Checkbox (only in bulk mode or Gmail — never WhatsApp) */}
            {showCheckbox && (
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  onToggleSelect(conv.id)
                }}
                className="shrink-0 mt-0.5 p-0.5 rounded hover:bg-zinc-200 transition-colors"
              >
                {isChecked ? (
                  <CheckSquare className="h-4 w-4 text-blue-500" />
                ) : (
                  <Square className="h-4 w-4 text-zinc-300 hover:text-zinc-500" />
                )}
              </button>
            )}

            {/* Conversation content */}
            <button
              onClick={() => onSelect(conv)}
              className="flex-1 text-left min-w-0"
            >
              <div className="flex items-center justify-between mb-1">
                <div className="flex items-center gap-2 min-w-0">
                  <Icon className={cn('h-3.5 w-3.5 shrink-0', channelColors[conv.channel])} />
                  <span
                    className={cn(
                      'text-sm truncate',
                      conv.unread > 0 ? 'font-semibold text-zinc-900' : 'font-medium text-zinc-700'
                    )}
                  >
                    {conv.name}
                  </span>
                </div>
                <span className="text-xs text-zinc-400 shrink-0 ml-2">
                  {formatTime(conv.lastMessageAt)}
                </span>
              </div>

              {conv.subject && conv.channel === 'gmail' && (
                <p className="text-xs font-medium text-zinc-600 truncate mb-0.5">
                  {conv.subject}
                </p>
              )}

              <div className="flex items-center justify-between">
                <p className="text-xs text-zinc-500 truncate flex-1">
                  {conv.preview}
                </p>
                <div className="flex items-center gap-1 shrink-0 ml-2">
                  {mark && (
                    <span
                      className="h-2.5 w-2.5 rounded-full shrink-0"
                      style={{ backgroundColor: mark.hex }}
                      title={`Marked ${mark.label}`}
                    />
                  )}
                  {conv.hasAttachment && (
                    <Paperclip className="h-3 w-3 text-zinc-400" />
                  )}
                  {conv.unread > 0 && (
                    <span className="px-1.5 py-0.5 bg-blue-500 text-white text-xs rounded-full font-semibold">
                      {conv.unread}
                    </span>
                  )}
                </div>
              </div>
            </button>

            {/* Delete button — visible on hover (Gmail only) */}
            {conv.channel === 'gmail' && (
              <button
                onClick={(e) => {
                  e.stopPropagation()
                  deleteMutation.mutate(conv)
                }}
                disabled={deleteMutation.isPending}
                className="shrink-0 self-center opacity-0 group-hover:opacity-100 p-1.5 rounded hover:bg-red-100 text-zinc-400 hover:text-red-600 transition-all"
                title="Delete"
              >
                <Trash2 className="h-4 w-4" />
              </button>
            )}
          </div>
        )
      })}
    </div>
  )
}
