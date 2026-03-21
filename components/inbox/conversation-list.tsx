'use client'

import { useQuery } from '@tanstack/react-query'
import { MessageSquare, Mail, Send, CheckSquare, Square } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { InboxConversation, InboxChannel } from '@/lib/types'

interface ConversationListProps {
  activeChannel: InboxChannel | null
  selectedId: string | null
  onSelect: (conversation: InboxConversation) => void
  // Bulk selection
  bulkMode: boolean
  selectedIds: Set<string>
  onToggleSelect: (id: string) => void
}

const channelIcons: Record<InboxChannel, React.ElementType> = {
  whatsapp: MessageSquare,
  telegram: Send,
  gmail: Mail,
}

const channelColors: Record<InboxChannel, string> = {
  whatsapp: 'text-emerald-600',
  telegram: 'text-blue-500',
  gmail: 'text-red-500',
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

export function ConversationList({ activeChannel, selectedId, onSelect, bulkMode, selectedIds, onToggleSelect }: ConversationListProps) {
  const { data, isLoading } = useQuery<{ conversations: InboxConversation[]; total: number }>({
    queryKey: ['inbox-conversations', activeChannel],
    queryFn: () => {
      const params = new URLSearchParams()
      if (activeChannel) params.set('channel', activeChannel)
      params.set('limit', '50')
      return fetch(`/api/inbox/conversations?${params}`).then((r) => r.json())
    },
    refetchInterval: 30_000,
  })

  const conversations = data?.conversations || []

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

        return (
          <div
            key={conv.id}
            className={cn(
              'w-full text-left px-4 py-3 border-b transition-colors hover:bg-zinc-50 flex items-start gap-2',
              isSelected && 'bg-blue-50 border-l-2 border-l-blue-500',
              isChecked && !isSelected && 'bg-blue-50/50',
              conv.unread > 0 && !isSelected && !isChecked && 'bg-white'
            )}
          >
            {/* Checkbox (only in bulk mode or Gmail) */}
            {(bulkMode || conv.channel === 'gmail') && (
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
                {conv.unread > 0 && (
                  <span className="ml-2 px-1.5 py-0.5 bg-blue-500 text-white text-xs rounded-full font-semibold shrink-0">
                    {conv.unread}
                  </span>
                )}
              </div>
            </button>
          </div>
        )
      })}
    </div>
  )
}
