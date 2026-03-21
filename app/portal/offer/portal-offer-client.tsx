'use client'

import { FileText, CheckCircle, Clock, CreditCard } from 'lucide-react'

interface PortalOfferClientProps {
  offerUrl: string
  status: string
  clientName: string
}

const STATUS_INFO: Record<string, { label: string; icon: typeof FileText; color: string; bg: string }> = {
  draft: { label: 'Proposal Ready', icon: FileText, color: 'text-blue-600', bg: 'bg-blue-50' },
  sent: { label: 'Proposal Ready', icon: FileText, color: 'text-blue-600', bg: 'bg-blue-50' },
  viewed: { label: 'Under Review', icon: Clock, color: 'text-amber-600', bg: 'bg-amber-50' },
  signed: { label: 'Signed — Payment Pending', icon: CreditCard, color: 'text-orange-600', bg: 'bg-orange-50' },
  completed: { label: 'Completed', icon: CheckCircle, color: 'text-green-600', bg: 'bg-green-50' },
}

export function PortalOfferClient({ offerUrl, status, clientName }: PortalOfferClientProps) {
  const info = STATUS_INFO[status] || STATUS_INFO.sent
  const Icon = info.icon

  return (
    <div className="flex flex-col h-[calc(100vh-4rem)]">
      {/* Status bar */}
      <div className={`${info.bg} border-b px-6 py-3 flex items-center gap-3`}>
        <Icon className={`h-5 w-5 ${info.color}`} />
        <div>
          <p className={`text-sm font-semibold ${info.color}`}>{info.label}</p>
          <p className="text-xs text-zinc-500">
            {status === 'signed'
              ? 'Complete your payment to get started.'
              : status === 'completed'
                ? 'Thank you! Your setup is being processed.'
                : 'Review the proposal below. Accept and sign when ready.'}
          </p>
        </div>
      </div>

      {/* Offer iframe — full existing offer page, no email gate (access code in URL) */}
      <iframe
        src={offerUrl}
        className="flex-1 w-full border-0"
        title={`Proposal for ${clientName}`}
        allow="payment"
      />
    </div>
  )
}
