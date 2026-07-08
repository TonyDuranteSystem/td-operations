'use client'

/**
 * AccountEmailsCard — compact "recent emails" card on the account OVERVIEW
 * (Antonio 2026-07-08: linked emails must be visible without hunting for the
 * Emails tab). Shows the latest threads (auto-matched + manually linked,
 * "Linked" badge) from the same client-emails endpoint; "View all" jumps to
 * the full Emails tab.
 */

import { useQuery } from '@tanstack/react-query'
import { ChevronRight, Link2, Loader2, Mail } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { InboxConversation } from '@/lib/types'

interface AccountEmailsCardProps {
  accountId: string
  onOpenAll: () => void
}

function formatDate(dateStr: string) {
  if (!dateStr) return ''
  const date = new Date(dateStr)
  const days = Math.floor((Date.now() - date.getTime()) / 86_400_000)
  if (days === 0) return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })
  if (days < 7) return date.toLocaleDateString('en-US', { weekday: 'short' })
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

export function AccountEmailsCard({ accountId, onOpenAll }: AccountEmailsCardProps) {
  const { data, isLoading } = useQuery<{ conversations: InboxConversation[] }>({
    queryKey: ['client-emails', accountId, null],
    queryFn: () => fetch(`/api/portal-chats/client-emails?account_id=${accountId}`).then(r => r.json()),
    staleTime: 60_000,
  })

  const conversations = (data?.conversations ?? []).slice(0, 5)

  return (
    <div className="bg-white rounded-lg border p-5">
      <div className="flex items-center justify-between mb-3">
        <h3 className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground uppercase tracking-wide">
          <Mail className="h-3.5 w-3.5" />
          Emails
        </h3>
        <button
          onClick={onOpenAll}
          className="flex items-center gap-0.5 text-xs text-blue-600 hover:underline"
        >
          View all
          <ChevronRight className="h-3 w-3" />
        </button>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-6">
          <Loader2 className="h-4 w-4 animate-spin text-zinc-300" />
        </div>
      ) : conversations.length === 0 ? (
        <p className="text-sm text-zinc-400 py-4 text-center">No emails yet</p>
      ) : (
        <div className="space-y-0.5 -mx-2">
          {conversations.map(conv => (
            <button
              key={conv.id}
              onClick={onOpenAll}
              className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-zinc-50 text-left"
            >
              <span className="flex-1 min-w-0">
                <span className={cn(
                  'block text-sm truncate',
                  conv.unread > 0 ? 'font-semibold text-zinc-900' : 'text-zinc-700'
                )}>
                  {conv.subject || '(no subject)'}
                </span>
                <span className="block text-[11px] text-zinc-400 truncate">{conv.name}</span>
              </span>
              {conv.linked && (
                <span
                  className="flex items-center gap-0.5 text-[9px] font-semibold uppercase px-1.5 py-0.5 rounded bg-blue-100 text-blue-700 shrink-0"
                  title="Manually linked to this client"
                >
                  <Link2 className="h-2.5 w-2.5" />
                  Linked
                </span>
              )}
              <span className="text-[11px] text-zinc-400 shrink-0">{formatDate(conv.lastMessageAt)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  )
}
