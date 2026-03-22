'use client'

import { FileText, CheckCircle, Clock, CreditCard } from 'lucide-react'

interface PortalOfferClientProps {
  offerUrl: string
  status: string
  clientName: string
  language?: string
}

const STATUS_INFO: Record<string, { en: string; it: string; icon: typeof FileText; color: string; bg: string }> = {
  draft: { en: 'Proposal Ready', it: 'Proposta Pronta', icon: FileText, color: 'text-blue-600', bg: 'bg-blue-50' },
  sent: { en: 'Proposal Ready', it: 'Proposta Pronta', icon: FileText, color: 'text-blue-600', bg: 'bg-blue-50' },
  viewed: { en: 'Under Review', it: 'In Revisione', icon: Clock, color: 'text-amber-600', bg: 'bg-amber-50' },
  signed: { en: 'Signed — Payment Pending', it: 'Firmato — In Attesa di Pagamento', icon: CreditCard, color: 'text-orange-600', bg: 'bg-orange-50' },
  completed: { en: 'Completed', it: 'Completato', icon: CheckCircle, color: 'text-green-600', bg: 'bg-green-50' },
}

const SUBTITLES: Record<string, { en: string; it: string }> = {
  signed: { en: 'Complete your payment to get started.', it: 'Completa il pagamento per iniziare.' },
  completed: { en: 'Thank you! Your setup is being processed.', it: 'Grazie! La tua configurazione è in corso.' },
  default: { en: 'Review the proposal below. Accept and sign when ready.', it: 'Rivedi la proposta qui sotto. Accetta e firma quando sei pronto.' },
}

export function PortalOfferClient({ offerUrl, status, clientName, language }: PortalOfferClientProps) {
  const info = STATUS_INFO[status] || STATUS_INFO.sent
  const Icon = info.icon
  const lang = (language === 'it' ? 'it' : 'en') as 'en' | 'it'
  const subtitle = SUBTITLES[status] || SUBTITLES.default

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

      {/* Offer iframe */}
      <iframe
        src={offerUrl}
        className="flex-1 w-full border-0"
        title={`Proposal for ${clientName}`}
        allow="payment"
      />
    </div>
  )
}
