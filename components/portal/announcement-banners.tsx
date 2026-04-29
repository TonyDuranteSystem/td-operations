'use client'

import { useEffect, useState } from 'react'
import { Megaphone, X } from 'lucide-react'

export interface PortalAnnouncement {
  id: string
  title: string
  message: string
  title_en: string | null
  message_en: string | null
  type: 'info' | 'warning' | 'success'
  dismissible: boolean
}

const TYPE_STYLES = {
  info: {
    container: 'bg-blue-50 border-blue-200',
    icon: 'bg-blue-100 text-blue-600',
    title: 'text-blue-900',
    body: 'text-blue-700',
    close: 'text-blue-400 hover:text-blue-600',
  },
  warning: {
    container: 'bg-amber-50 border-amber-200',
    icon: 'bg-amber-100 text-amber-600',
    title: 'text-amber-900',
    body: 'text-amber-700',
    close: 'text-amber-400 hover:text-amber-600',
  },
  success: {
    container: 'bg-green-50 border-green-200',
    icon: 'bg-green-100 text-green-600',
    title: 'text-green-900',
    body: 'text-green-700',
    close: 'text-green-400 hover:text-green-600',
  },
}

function SingleBanner({ ann, locale }: { ann: PortalAnnouncement; locale: 'en' | 'it' }) {
  const [visible, setVisible] = useState(!ann.dismissible)

  useEffect(() => {
    if (!ann.dismissible) {
      setVisible(true)
      return
    }
    try {
      const key = `td-portal-ann-${ann.id}`
      if (!localStorage.getItem(key)) setVisible(true)
    } catch {
      setVisible(true)
    }
  }, [ann.id, ann.dismissible])

  const handleDismiss = () => {
    try {
      localStorage.setItem(`td-portal-ann-${ann.id}`, '1')
    } catch {
      // no-op
    }
    setVisible(false)
  }

  if (!visible) return null

  const s = TYPE_STYLES[ann.type] ?? TYPE_STYLES.info

  // Use English copy if client is English and English version exists; otherwise Italian
  const displayTitle = locale === 'en' && ann.title_en ? ann.title_en : ann.title
  const displayMessage = locale === 'en' && ann.message_en ? ann.message_en : ann.message

  return (
    <div className={`flex items-start gap-3 border rounded-xl px-4 py-3 ${s.container}`}>
      <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 mt-0.5 ${s.icon}`}>
        <Megaphone className="h-4 w-4" />
      </div>
      <div className="flex-1 min-w-0">
        <p className={`text-sm font-semibold ${s.title}`}>{displayTitle}</p>
        <p className={`text-xs mt-0.5 whitespace-pre-line ${s.body}`}>{displayMessage}</p>
      </div>
      {ann.dismissible && (
        <button
          onClick={handleDismiss}
          aria-label="Dismiss"
          className={`p-1 transition-colors shrink-0 ${s.close}`}
        >
          <X className="h-4 w-4" />
        </button>
      )}
    </div>
  )
}

export function AnnouncementBanners({
  announcements,
  locale,
}: {
  announcements: PortalAnnouncement[]
  locale: 'en' | 'it'
}) {
  if (!announcements.length) return null
  return (
    <div className="space-y-2">
      {announcements.map(ann => (
        <SingleBanner key={ann.id} ann={ann} locale={locale} />
      ))}
    </div>
  )
}
