'use client'

import { useQuery } from '@tanstack/react-query'
import { MessageSquare, Mail, Send } from 'lucide-react'
import type { InboxStats, InboxChannel } from '@/lib/types'

interface InboxHeaderProps {
  activeChannel: InboxChannel | null
  onChannelChange: (channel: InboxChannel | null) => void
}

export function InboxHeader({ activeChannel, onChannelChange }: InboxHeaderProps) {
  const { data: stats } = useQuery<InboxStats>({
    queryKey: ['inbox-stats'],
    queryFn: () => fetch('/api/inbox/stats').then((r) => r.json()),
    refetchInterval: 30_000,
  })

  const channels: { key: InboxChannel | null; label: string; icon: React.ElementType; count: number }[] = [
    { key: null, label: 'All', icon: MessageSquare, count: stats?.total || 0 },
    { key: 'whatsapp', label: 'WhatsApp', icon: MessageSquare, count: stats?.whatsapp || 0 },
    { key: 'telegram', label: 'Telegram', icon: Send, count: stats?.telegram || 0 },
    { key: 'gmail', label: 'Gmail', icon: Mail, count: stats?.gmail || 0 },
  ]

  return (
    <div className="flex items-center gap-1 px-4 py-2 bg-white">
      {channels.map((ch) => {
        const isActive = activeChannel === ch.key
        return (
          <button
            key={ch.key ?? 'all'}
            onClick={() => onChannelChange(ch.key)}
            className={`
              flex items-center gap-1.5 px-3 py-1.5 rounded-full text-sm font-medium transition-colors
              ${isActive
                ? 'bg-zinc-900 text-white'
                : 'bg-zinc-100 text-zinc-600 hover:bg-zinc-200'
              }
            `}
          >
            <ch.icon className="h-3.5 w-3.5" />
            {ch.label}
            {ch.count > 0 && (
              <span
                className={`
                  ml-1 px-1.5 py-0.5 rounded-full text-xs font-semibold
                  ${isActive ? 'bg-white/20 text-white' : 'bg-red-500 text-white'}
                `}
              >
                {ch.count}
              </span>
            )}
          </button>
        )
      })}
    </div>
  )
}
