'use client'

import { useQuery } from '@tanstack/react-query'
import { MessageSquare, Mail, Send, Loader2, MessagesSquare } from 'lucide-react'
import { cn } from '@/lib/utils'
import { format } from 'date-fns'
import type { InboxConversation } from '@/lib/types'

function relativeTime(dateStr: string): string {
  if (!dateStr) return ''
  try {
    const d = new Date(dateStr)
    const now = new Date()
    const diffMs = now.getTime() - d.getTime()
    const diffMin = Math.floor(diffMs / 60000)
    if (diffMin < 1) return 'now'
    if (diffMin < 60) return `${diffMin}m ago`
    const diffH = Math.floor(diffMin / 60)
    if (diffH < 24) return `${diffH}h ago`
    const diffD = Math.floor(diffH / 24)
    if (diffD < 7) return `${diffD}d ago`
    return format(d, 'MM/dd/yy')
  } catch {
    return ''
  }
}

interface AccountCommunicationsProps {
  accountId: string
}

const CHANNEL_CONFIG = {
  whatsapp: { label: 'WhatsApp', color: 'bg-green-100 text-green-700', icon: MessageSquare },
  telegram: { label: 'Telegram', color: 'bg-blue-100 text-blue-700', icon: Send },
  gmail: { label: 'Email', color: 'bg-red-100 text-red-700', icon: Mail },
  portal: { label: 'Portal', color: 'bg-purple-100 text-purple-700', icon: MessagesSquare },
} as const

export function AccountCommunications({ accountId }: AccountCommunicationsProps) {
  const { data, isLoading, error } = useQuery({
    queryKey: ['account-communications', accountId],
    queryFn: async () => {
      const res = await fetch(`/api/accounts/${accountId}/communications`)
      if (!res.ok) throw new Error('Failed to fetch')
      return res.json() as Promise<{
        conversations: InboxConversation[]
        stats: { whatsapp: number; telegram: number; gmail: number; portal: number; total: number }
      }>
    },
    staleTime: 60_000,
  })

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12 text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin mr-2" />
        Loading communications...
      </div>
    )
  }

  if (error) {
    return (
      <p className="text-sm text-red-500 py-4">
        Error loading communications
      </p>
    )
  }

  const { conversations, stats } = data || { conversations: [], stats: { whatsapp: 0, telegram: 0, gmail: 0, portal: 0, total: 0 } }

  return (
    <div className="space-y-4">
      {/* Stats bar */}
      <div className="flex items-center gap-3 flex-wrap">
        {stats.gmail > 0 && (
          <span className="inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full bg-red-100 text-red-700">
            <Mail className="h-3 w-3" />
            {stats.gmail} Email
          </span>
        )}
        {stats.portal > 0 && (
          <span className="inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full bg-purple-100 text-purple-700">
            <MessagesSquare className="h-3 w-3" />
            {stats.portal} Portal
          </span>
        )}
        {stats.whatsapp > 0 && (
          <span className="inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full bg-green-100 text-green-700">
            <MessageSquare className="h-3 w-3" />
            {stats.whatsapp} WhatsApp
          </span>
        )}
        {stats.telegram > 0 && (
          <span className="inline-flex items-center gap-1.5 text-xs font-medium px-2.5 py-1 rounded-full bg-blue-100 text-blue-700">
            <Send className="h-3 w-3" />
            {stats.telegram} Telegram
          </span>
        )}
        {stats.total === 0 && (
          <span className="text-sm text-muted-foreground">No conversations found</span>
        )}
      </div>

      {/* Conversation list */}
      {conversations.length > 0 && (
        <div className="bg-white rounded-lg border overflow-hidden divide-y">
          {conversations.map((conv) => {
            const cfg = CHANNEL_CONFIG[conv.channel]
            const Icon = cfg.icon
            const ago = relativeTime(conv.lastMessageAt)

            return (
              <a
                key={conv.id}
                href={conv.channel === 'portal' ? `/portal/admin/${conv.accountId}` : `/inbox?conversation=${conv.id}`}
                className={cn(
                  'flex items-start gap-3 px-4 py-3 hover:bg-zinc-50 transition-colors',
                  conv.unread > 0 && 'bg-blue-50/50'
                )}
              >
                {/* Channel icon */}
                <div className={cn('shrink-0 mt-0.5 w-8 h-8 rounded-full flex items-center justify-center', cfg.color)}>
                  <Icon className="h-4 w-4" />
                </div>

                {/* Content */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-2">
                    <span className={cn('text-sm truncate', conv.unread > 0 ? 'font-semibold' : 'font-medium')}>
                      {conv.name}
                    </span>
                    <span className="text-xs text-muted-foreground shrink-0">{ago}</span>
                  </div>
                  {conv.subject && (
                    <p className="text-xs font-medium text-zinc-700 truncate">{conv.subject}</p>
                  )}
                  <p className="text-xs text-muted-foreground truncate mt-0.5">{conv.preview}</p>
                </div>

                {/* Unread badge */}
                {conv.unread > 0 && (
                  <span className="shrink-0 mt-1 w-5 h-5 rounded-full bg-blue-500 text-white text-[10px] font-bold flex items-center justify-center">
                    {conv.unread}
                  </span>
                )}
              </a>
            )
          })}
        </div>
      )}
    </div>
  )
}
