'use client'

import { useEffect, useState, useCallback } from 'react'
import { FileText, CheckCircle, Clock, PenLine } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useLocale } from '@/lib/portal/use-locale'

interface PortalLeaseClientProps {
  leaseUrl: string
  status: string
  companyName: string
  suiteNumber: string | null
}

const STATUS_ICON: Record<string, { key: string; icon: typeof FileText; color: string; bg: string }> = {
  draft: { key: 'signSubpages.lease.ready', icon: PenLine, color: 'text-blue-600', bg: 'bg-blue-50' },
  sent: { key: 'signSubpages.lease.ready', icon: PenLine, color: 'text-blue-600', bg: 'bg-blue-50' },
  viewed: { key: 'signSubpages.awaitingSignature', icon: Clock, color: 'text-amber-600', bg: 'bg-amber-50' },
  signed: { key: 'signDocs.status.signed', icon: CheckCircle, color: 'text-green-600', bg: 'bg-green-50' },
}

export function PortalLeaseClient({ leaseUrl, status, companyName, suiteNumber }: PortalLeaseClientProps) {
  const router = useRouter()
  const { t } = useLocale()
  const [currentStatus, setCurrentStatus] = useState(status)

  const info = STATUS_ICON[currentStatus] || STATUS_ICON.sent
  const Icon = info.icon
  const subtitle = currentStatus === 'signed' ? t('signSubpages.lease.subtitleSigned') : t('signSubpages.lease.subtitleDefault')

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
          <p className={`text-sm font-semibold ${info.color}`}>{t(info.key)}</p>
          <p className="text-xs text-zinc-500">
            {subtitle}
            {suiteNumber && currentStatus !== 'signed' && (
              <span className="ml-2 text-zinc-400">{t('signDocs.suite')} {suiteNumber}</span>
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
