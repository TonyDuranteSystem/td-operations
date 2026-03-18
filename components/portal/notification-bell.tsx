'use client'

import { useState, useEffect, useRef } from 'react'
import { Bell, MessageCircle, FileText, Activity, Calendar, Receipt } from 'lucide-react'
import { cn } from '@/lib/utils'
import { format, parseISO } from 'date-fns'
import Link from 'next/link'

interface Notification {
  id: string
  type: string
  title: string
  body: string | null
  link: string | null
  read_at: string | null
  created_at: string
}

const TYPE_ICONS: Record<string, React.ElementType> = {
  chat: MessageCircle,
  document: FileText,
  service: Activity,
  deadline: Calendar,
  invoice: Receipt,
}

export function NotificationBell({ accountId }: { accountId: string }) {
  const [open, setOpen] = useState(false)
  const [notifications, setNotifications] = useState<Notification[]>([])
  const [unread, setUnread] = useState(0)
  const ref = useRef<HTMLDivElement>(null)

  // Close on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [])

  // Fetch notifications
  useEffect(() => {
    async function load() {
      try {
        const res = await fetch(`/api/portal/notifications?account_id=${accountId}&limit=10`)
        if (res.ok) {
          const data = await res.json()
          setNotifications(data.notifications ?? [])
          setUnread(data.unread_count ?? 0)
        }
      } catch { /* silent */ }
    }
    load()
    const interval = setInterval(load, 30000) // Refresh every 30s
    return () => clearInterval(interval)
  }, [accountId])

  const markAllRead = async () => {
    const unreadIds = notifications.filter(n => !n.read_at).map(n => n.id)
    if (unreadIds.length === 0) return
    await fetch('/api/portal/notifications', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: unreadIds }),
    })
    setNotifications(prev => prev.map(n => ({ ...n, read_at: n.read_at ?? new Date().toISOString() })))
    setUnread(0)
  }

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen(!open)}
        className="relative p-2 rounded-lg hover:bg-zinc-100 transition-colors"
      >
        <Bell className="h-5 w-5 text-zinc-600" />
        {unread > 0 && (
          <span className="absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] rounded-full bg-red-500 text-white text-[10px] font-semibold flex items-center justify-center px-1">
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>

      {open && (
        <div className="absolute right-0 mt-2 w-80 bg-white border rounded-xl shadow-lg z-50 overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 border-b">
            <span className="text-sm font-semibold text-zinc-900">Notifications</span>
            {unread > 0 && (
              <button onClick={markAllRead} className="text-xs text-blue-600 hover:underline">
                Mark all read
              </button>
            )}
          </div>
          <div className="max-h-80 overflow-y-auto">
            {notifications.length === 0 ? (
              <div className="p-6 text-center text-sm text-zinc-500">No notifications</div>
            ) : (
              notifications.map(n => {
                const Icon = TYPE_ICONS[n.type] ?? Bell
                const content = (
                  <div className={cn(
                    'flex items-start gap-3 px-4 py-3 hover:bg-zinc-50 transition-colors border-b last:border-b-0',
                    !n.read_at && 'bg-blue-50/50'
                  )}>
                    <Icon className="h-4 w-4 text-zinc-400 mt-0.5 shrink-0" />
                    <div className="flex-1 min-w-0">
                      <p className={cn('text-sm', !n.read_at && 'font-medium')}>{n.title}</p>
                      {n.body && <p className="text-xs text-zinc-500 mt-0.5 truncate">{n.body}</p>}
                      <p className="text-[10px] text-zinc-400 mt-1">{format(parseISO(n.created_at), 'MMM d, h:mm a')}</p>
                    </div>
                    {!n.read_at && <div className="w-2 h-2 rounded-full bg-blue-500 mt-1.5 shrink-0" />}
                  </div>
                )
                return n.link ? (
                  <Link key={n.id} href={n.link} onClick={() => setOpen(false)}>{content}</Link>
                ) : (
                  <div key={n.id}>{content}</div>
                )
              })
            )}
          </div>
        </div>
      )}
    </div>
  )
}
