'use client'

import { useState, useEffect } from 'react'
import { Bell, CheckCircle2, Loader2, FileText, MessageCircle, Cog, Calendar, CreditCard } from 'lucide-react'
import { cn } from '@/lib/utils'
import { format, parseISO } from 'date-fns'
import { useLocale } from '@/lib/portal/use-locale'
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
  service: Cog,
  deadline: Calendar,
  payment: CreditCard,
}

export default function NotificationsPage() {
  const { t } = useLocale()
  const [notifications, setNotifications] = useState<Notification[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    async function load() {
      const match = document.cookie.match(/portal_account_id=([^;]+)/)
      if (!match) { setLoading(false); return }
      const res = await fetch(`/api/portal/notifications?account_id=${match[1]}&limit=50`)
      if (res.ok) {
        const data = await res.json()
        setNotifications(data.notifications ?? [])
      }
      setLoading(false)
    }
    load()
  }, [])

  const markAllRead = async () => {
    const unread = notifications.filter(n => !n.read_at).map(n => n.id)
    if (unread.length === 0) return
    await fetch('/api/portal/notifications', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: unread }),
    })
    setNotifications(prev => prev.map(n => ({ ...n, read_at: n.read_at || new Date().toISOString() })))
  }

  if (loading) {
    return (
      <div className="p-8 flex justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-blue-600" />
      </div>
    )
  }

  return (
    <div className="p-6 lg:p-8 max-w-3xl mx-auto space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight text-zinc-900">{t('settings.notifications')}</h1>
        </div>
        {notifications.some(n => !n.read_at) && (
          <button
            onClick={markAllRead}
            className="text-sm text-blue-600 hover:text-blue-700"
          >
            Mark all as read
          </button>
        )}
      </div>

      {notifications.length === 0 ? (
        <div className="bg-white rounded-xl border shadow-sm p-12 text-center">
          <Bell className="h-12 w-12 text-zinc-200 mx-auto mb-3" />
          <p className="text-zinc-400">No notifications yet</p>
        </div>
      ) : (
        <div className="bg-white rounded-xl border shadow-sm divide-y">
          {notifications.map(n => {
            const Icon = TYPE_ICONS[n.type] ?? Bell
            return (
              <div key={n.id} className={cn('p-4 flex gap-3', !n.read_at && 'bg-blue-50/50')}>
                <div className={cn(
                  'w-9 h-9 rounded-lg flex items-center justify-center shrink-0',
                  !n.read_at ? 'bg-blue-100 text-blue-600' : 'bg-zinc-100 text-zinc-400'
                )}>
                  <Icon className="h-4 w-4" />
                </div>
                <div className="flex-1 min-w-0">
                  {n.link ? (
                    <Link href={n.link} className="text-sm font-medium text-zinc-900 hover:text-blue-600">{n.title}</Link>
                  ) : (
                    <p className="text-sm font-medium text-zinc-900">{n.title}</p>
                  )}
                  {n.body && <p className="text-xs text-zinc-500 mt-0.5 truncate">{n.body}</p>}
                  <p className="text-xs text-zinc-400 mt-1">{format(parseISO(n.created_at), 'MMM d, h:mm a')}</p>
                </div>
                {!n.read_at && <div className="w-2 h-2 rounded-full bg-blue-600 shrink-0 mt-2" />}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}
