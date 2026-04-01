'use client'

import { useState } from 'react'
import { FileText, ExternalLink, Circle, CheckCircle2 } from 'lucide-react'
import { cn } from '@/lib/utils'

interface CorrespondenceItem {
  id: string
  file_name: string
  description: string | null
  drive_file_url: string | null
  read_at: string | null
  created_at: string
  account_id: string | null
}

interface Props {
  items: CorrespondenceItem[]
}

export function CorrespondenceList({ items }: Props) {
  const [readIds, setReadIds] = useState<Set<string>>(
    new Set(items.filter(i => i.read_at).map(i => i.id))
  )

  async function markAsRead(id: string) {
    if (readIds.has(id)) return
    try {
      await fetch('/api/portal/correspondence/read', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      })
      setReadIds(prev => new Set(Array.from(prev).concat(id)))
    } catch {
      // silent — don't block the user from viewing
    }
  }

  return (
    <div className="divide-y divide-zinc-100">
      {items.map(item => {
        const isRead = readIds.has(item.id)
        return (
          <div
            key={item.id}
            className={cn(
              'flex items-start gap-3 px-5 py-4 transition-colors',
              !isRead ? 'bg-blue-50/60' : 'bg-white'
            )}
          >
            {/* Read indicator */}
            <div className="mt-0.5 flex-shrink-0">
              {isRead
                ? <CheckCircle2 className="h-4 w-4 text-green-500" />
                : <Circle className="h-4 w-4 fill-blue-500 text-blue-500" />
              }
            </div>

            {/* Content */}
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <FileText className="h-3.5 w-3.5 text-zinc-400 flex-shrink-0" />
                <span className={cn(
                  'text-sm truncate',
                  !isRead ? 'font-semibold text-zinc-900' : 'font-medium text-zinc-700'
                )}>
                  {item.file_name}
                </span>
                {!isRead && (
                  <span className="text-xs font-medium text-blue-600 bg-blue-100 px-1.5 py-0.5 rounded-full">New</span>
                )}
              </div>
              {item.description && (
                <p className="text-xs text-zinc-500 mt-0.5">{item.description}</p>
              )}
              <p className="text-xs text-zinc-400 mt-1">
                {new Date(item.created_at).toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })}
              </p>
            </div>

            {/* Open + mark as read */}
            {item.drive_file_url && (
              <a
                href={item.drive_file_url}
                target="_blank"
                rel="noopener noreferrer"
                onClick={() => markAsRead(item.id)}
                className="flex-shrink-0 inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-lg border border-zinc-200 bg-white hover:bg-zinc-50 text-zinc-700 transition-colors"
              >
                <ExternalLink className="h-3.5 w-3.5" />
                View
              </a>
            )}
          </div>
        )
      })}
    </div>
  )
}
