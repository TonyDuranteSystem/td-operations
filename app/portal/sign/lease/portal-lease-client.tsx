'use client'

import { useEffect, useState, useCallback } from 'react'
import { FileText, CheckCircle, Clock, PenLine } from 'lucide-react'
import { useRouter } from 'next/navigation'

interface PortalLeaseClientProps {
  leaseUrl: string
  status: string
  companyName: string
  suiteNumber: string | null
  language?: string
}

const STATUS_INFO: Record<string, { en: string; it: string; icon: typeof FileText; color: string; bg: string }> = {
  draft: { en: 'Lease Agreement Ready', it: 'Contratto di Locazione Pronto', icon: PenLine, color: 'text-blue-600', bg: 'bg-blue-50' },
  sent: { en: 'Lease Agreement Ready', it: 'Contratto di Locazione Pronto', icon: PenLine, color: 'text-blue-600', bg: 'bg-blue-50' },
  viewed: { en: 'Awaiting Your Signature', it: 'In Attesa della Tua Firma', icon: Clock, color: 'text-amber-600', bg: 'bg-amber-50' },
  signed: { en: 'Signed', it: 'Firmato', icon: CheckCircle, color: 'text-green-600', bg: 'bg-green-50' },
}

const SUBTITLES: Record<string, { en: string; it: string }> = {
  signed: { en: 'Your Lease Agreement has been signed and saved.', it: 'Il tuo Contratto di Locazione \u00e8 stato firmato e salvato.' },
  default: { en: 'Review and sign your Lease Agreement below.', it: 'Rivedi e firma il tuo Contratto di Locazione qui sotto.' },
}

export function PortalLeaseClient({ leaseUrl, status, companyName, suiteNumber, language }: PortalLeaseClientProps) {
  const router = useRouter()
  const [currentStatus, setCurrentStatus] = useState(status)

  const info = STATUS_INFO[currentStatus] || STATUS_INFO.sent
  const Icon = info.icon
  const lang = (language === 'it' ? 'it' : 'en') as 'en' | 'it'
  const subtitle = SUBTITLES[currentStatus] || SUBTITLES.default

  // Listen for postMessage from embedded Lease page when signing completes
  const handleMessage = useCallback((event: MessageEvent) => {
    if (event.data?.type === 'lease-signed') {
      setCurrentStatus('signed')
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
          <p className="text-xs text-zinc-500">
            {subtitle[lang]}
            {suiteNumber && currentStatus !== 'signed' && (
              <span className="ml-2 text-zinc-400">Suite {suiteNumber}</span>
            )}
          </p>
        </div>
      </div>

      {/* Lease iframe */}
      <iframe
        src={leaseUrl}
        className="flex-1 w-full border-0"
        title={`Lease Agreement for ${companyName}`}
        allow="clipboard-write"
      />
    </div>
  )
}
