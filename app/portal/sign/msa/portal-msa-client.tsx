'use client'

import { useEffect, useState, useCallback } from 'react'
import { FileText, CheckCircle, PenLine } from 'lucide-react'
import { useRouter } from 'next/navigation'

interface PortalMSAClientProps {
  msaUrl: string
  status: string
  companyName: string
  language?: string
  contractYear: number
}

const STATUS_INFO: Record<string, { en: string; it: string; icon: typeof FileText; color: string; bg: string }> = {
  draft: { en: 'Annual Service Agreement Ready', it: 'Contratto di Servizio Annuale Pronto', icon: PenLine, color: 'text-blue-600', bg: 'bg-blue-50' },
  sent: { en: 'Annual Service Agreement Ready', it: 'Contratto di Servizio Annuale Pronto', icon: PenLine, color: 'text-blue-600', bg: 'bg-blue-50' },
  signed: { en: 'Signed', it: 'Firmato', icon: CheckCircle, color: 'text-green-600', bg: 'bg-green-50' },
}

export function PortalMSAClient({ msaUrl, status, companyName, language, contractYear }: PortalMSAClientProps) {
  const router = useRouter()
  const [currentStatus, setCurrentStatus] = useState(status)

  const info = STATUS_INFO[currentStatus] || STATUS_INFO.draft
  const Icon = info.icon
  const lang = (language === 'it' ? 'it' : 'en') as 'en' | 'it'

  // Listen for postMessage from embedded contract page when signing completes
  const handleMessage = useCallback((event: MessageEvent) => {
    if (event.data?.type === 'contract-signed') {
      setCurrentStatus('signed')
      setTimeout(() => router.refresh(), 1500)
    }
  }, [router])

  useEffect(() => {
    window.addEventListener('message', handleMessage)
    return () => window.removeEventListener('message', handleMessage)
  }, [handleMessage])

  const subtitle = currentStatus === 'signed'
    ? { en: `Your ${contractYear} Annual Service Agreement has been signed and saved.`, it: `Il tuo Contratto di Servizio Annuale ${contractYear} è stato firmato e salvato.` }
    : { en: `Review and sign your ${contractYear} Annual Service Agreement below.`, it: `Rivedi e firma il tuo Contratto di Servizio Annuale ${contractYear} qui sotto.` }

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)]">
      {/* Status bar */}
      <div className={`${info.bg} border-b px-6 py-3 flex items-center gap-3`}>
        <Icon className={`h-5 w-5 ${info.color}`} />
        <div>
          <p className={`text-sm font-semibold ${info.color}`}>{info[lang]} — {contractYear}</p>
          <p className="text-xs text-zinc-500">{subtitle[lang]}</p>
        </div>
      </div>

      {/* Contract iframe */}
      <iframe
        src={msaUrl}
        className="flex-1 w-full border-0"
        title={`Annual Service Agreement ${contractYear} for ${companyName}`}
        allow="clipboard-write"
      />
    </div>
  )
}
