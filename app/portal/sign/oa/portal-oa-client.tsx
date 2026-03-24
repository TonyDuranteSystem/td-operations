'use client'

import { useEffect, useState, useCallback } from 'react'
import { FileText, CheckCircle, Clock, PenLine } from 'lucide-react'
import { useRouter } from 'next/navigation'

interface PortalOAClientProps {
  oaUrl: string
  status: string
  companyName: string
  language?: string
}

const STATUS_INFO: Record<string, { en: string; it: string; icon: typeof FileText; color: string; bg: string }> = {
  draft: { en: 'Operating Agreement Ready', it: 'Operating Agreement Pronto', icon: PenLine, color: 'text-blue-600', bg: 'bg-blue-50' },
  sent: { en: 'Operating Agreement Ready', it: 'Operating Agreement Pronto', icon: PenLine, color: 'text-blue-600', bg: 'bg-blue-50' },
  viewed: { en: 'Awaiting Your Signature', it: 'In Attesa della Tua Firma', icon: Clock, color: 'text-amber-600', bg: 'bg-amber-50' },
  signed: { en: 'Signed', it: 'Firmato', icon: CheckCircle, color: 'text-green-600', bg: 'bg-green-50' },
}

const SUBTITLES: Record<string, { en: string; it: string }> = {
  signed: { en: 'Your Operating Agreement has been signed and saved.', it: 'Il tuo Operating Agreement \u00e8 stato firmato e salvato.' },
  default: { en: 'Review and sign your Operating Agreement below.', it: 'Rivedi e firma il tuo Operating Agreement qui sotto.' },
}

export function PortalOAClient({ oaUrl, status, companyName, language }: PortalOAClientProps) {
  const router = useRouter()
  const [currentStatus, setCurrentStatus] = useState(status)

  const info = STATUS_INFO[currentStatus] || STATUS_INFO.sent
  const Icon = info.icon
  const lang = (language === 'it' ? 'it' : 'en') as 'en' | 'it'
  const subtitle = SUBTITLES[currentStatus] || SUBTITLES.default

  // Listen for postMessage from embedded OA page when signing completes
  const handleMessage = useCallback((event: MessageEvent) => {
    if (event.data?.type === 'oa-signed') {
      setCurrentStatus('signed')
      // Refresh the dashboard after a short delay to update checklist
      setTimeout(() => router.refresh(), 1500)
    }
  }, [router])

  useEffect(() => {
    window.addEventListener('message', handleMessage)
    return () => window.removeEventListener('message', handleMessage)
  }, [handleMessage])

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)]">
      {/* Status bar */}
      <div className={`${info.bg} border-b px-6 py-3 flex items-center gap-3`}>
        <Icon className={`h-5 w-5 ${info.color}`} />
        <div>
          <p className={`text-sm font-semibold ${info.color}`}>{info[lang]}</p>
          <p className="text-xs text-zinc-500">{subtitle[lang]}</p>
        </div>
      </div>

      {/* OA iframe */}
      <iframe
        src={oaUrl}
        className="flex-1 w-full border-0"
        title={`Operating Agreement for ${companyName}`}
        allow="clipboard-write"
      />
    </div>
  )
}
