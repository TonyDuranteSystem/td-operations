'use client'

import { useQuery, useMutation, useQueryClient, keepPreviousData } from '@tanstack/react-query'
import { Mail, MailOpen, CheckSquare, Square, Paperclip, Trash2, MessagesSquare, MessageSquare } from 'lucide-react'
import { toast } from 'sonner'
import { cn } from '@/lib/utils'
import { markByKey } from '@/lib/inbox/color-marks'
import type { InboxConversation, InboxChannel } from '@/lib/types'

interface ConversationListProps {
  activeChannel: InboxChannel | null
  selectedId: string | null
  onSelect: (conversation: InboxConversation) => void
  onDeleted?: (id: string) => void
  /** Undo of a delete — clears the id from the parent's hidden-row set so the
   *  restored thread is visible again on the next refetch. Without this, Undo
   *  untrashes in Gmail but the row stays filtered out (Luca, 2026-07-13). */
  onRestored?: (id: string) => void
  deletedIds?: Set<string>
  unreadOverrides?: Map<string, number>
  /** Optimistically set a row's unread override in the parent (badge + bold). */
  onUnreadOverride?: (id: string, unread: number) => void
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

export function ConversationList({ activeChannel, selectedId, onSelect, onDeleted, onRestored, deletedIds, unreadOverrides, onUnreadOverride, bulkMode, selectedIds, onToggleSelect, labelFilter, searchQuery, mailbox, unreadFilter }: ConversationListProps & { mailbox?: string; unreadFilter?: 'all' | 'unread' | 'read' }) {
  const queryClient = useQueryClient()

  // Toggle a row read/unread from the list (next to the row Delete). Uses the
  // parent's optimistic unread override for instant badge/bold feedback and
  // only invalidates stats/labels — NEVER the conversations list itself, whose
  // ~300-Gmail-call refetch under load is what blanked the inbox (2026-07-08).
  const markMutation = useMutation({
    mutationFn: async ({ conv, action }: { conv: InboxConversation; action: 'mark_read' | 'mark_unread' }) => {
      const res = await fetch('/api/inbox/email-actions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ threadId: conv.id.replace('gmail:', ''), action, mailbox }),
      })
      if (!res.ok) throw new Error('Failed to update')
      return action
    },
    onMutate: ({ conv, action }) => {
      onUnreadOverride?.(conv.id, action === 'mark_unread' ? Math.max(conv.unread, 1) : 0)
    },
    onSuccess: (action) => {
      toast.success(action === 'mark_unread' ? 'Marked as unread' : 'Marked as read')
      queryClient.invalidateQueries({ queryKey: ['inbox-stats'] })
      queryClient.invalidateQueries({ queryKey: ['gmail-labels'] })
    },
  })

  const deleteMutation = useMutation({
    mutationFn: async (conv: InboxConversation) => {
      if (conv.channel !== 'gmail') return
      const res = await fetch('/api/inbox/email-actions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ threadId: conv.id.replace('gmail:', ''), action: 'trash', mailbox }),
      })
      if (!res.ok) throw new Error('Failed to delete')
      // The server snapshots UNREAD/STARRED/IMPORTANT before stripping them —
      // hand it straight back on Undo so the email returns as it was.
      return res.json().catch(() => ({}))
    },
    onMutate: async (conv) => {
      await queryClient.cancelQueries({ queryKey: ['inbox-conversations'] })
      if (onDeleted) onDeleted(conv.id)
    },
    onSuccess: (data, conv) => {
      toast('Email deleted', {
        action: {
          label: 'Undo',
          onClick: async () => {
            try {
              const res = await fetch('/api/inbox/email-actions', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  threadId: conv.id.replace('gmail:', ''),
                  action: 'untrash',
                  mailbox,
                  restore: (data as { restore?: unknown })?.restore,
                }),
              })
              if (!res.ok) {
                // R099 — a non-2xx used to fall through silently, so a failed
                // restore looked identical to a successful one.
                const err = await res.json().catch(() => ({}))
                throw new Error(err.error || 'Failed to restore email.')
              }
              // MUST come before the refetch: the row is hidden by the parent's
              // `deletedIds` set, so untrashing in Gmail alone brings the thread
              // back from the API only for it to be filtered out again. Clearing
              // the id is what actually makes it reappear (Luca, 2026-07-13).
              onRestored?.(conv.id)
              toast.success('Email restored')
              queryClient.invalidateQueries({ queryKey: ['inbox-conversations'] })
              queryClient.invalidateQueries({ queryKey: ['inbox-stats'] })
              queryClient.invalidateQueries({ queryKey: ['gmail-labels'] })
            } catch (err) {
              toast.error(
                err instanceof Error && err.message ? err.message : 'Failed to restore email.',
              )
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
    // Never flash an empty pane while a refetch (or a mailbox/filter switch)
    // is in flight — keep showing the list we already have (Antonio
    // 2026-07-08: the list "disappeared" on actions/scroll under Gmail load).
    placeholderData: keepPreviousData,
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

            {/* Row actions — read/unread toggle + Delete (Gmail only). Reveal on
                hover on desktop; ALWAYS visible on mobile (touch has no hover, so
                the row actions would be unreachable — Antonio's phone PWA). */}
            {conv.channel === 'gmail' && (
              <div className="shrink-0 self-center flex items-center gap-0.5 opacity-100 sm:opacity-0 sm:group-hover:opacity-100 transition-opacity">
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    markMutation.mutate({ conv, action: conv.unread > 0 ? 'mark_read' : 'mark_unread' })
                  }}
                  disabled={markMutation.isPending}
                  className="p-1.5 rounded hover:bg-blue-100 text-zinc-400 hover:text-blue-600 transition-colors"
                  title={conv.unread > 0 ? 'Mark as read' : 'Mark as unread'}
                >
                  {conv.unread > 0 ? <Mail className="h-4 w-4" /> : <MailOpen className="h-4 w-4" />}
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation()
                    deleteMutation.mutate(conv)
                  }}
                  disabled={deleteMutation.isPending}
                  className="p-1.5 rounded hover:bg-red-100 text-zinc-400 hover:text-red-600 transition-colors"
                  title="Delete"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}
