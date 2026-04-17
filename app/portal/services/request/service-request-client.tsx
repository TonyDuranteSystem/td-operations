'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  Building2, FileText, CreditCard, Package, Receipt,
  XCircle, Fingerprint, Phone, Send, CheckCircle, ArrowLeft,
  Loader2, MessageCircle,
} from 'lucide-react'
import { cn } from '@/lib/utils'

interface ServiceRequestClientProps {
  contactId: string
  accountId: string
  userName: string
  locale: string
}

const SERVICES = [
  {
    id: 'llc_formation',
    icon: Building2,
    color: 'text-blue-600 bg-blue-50',
    en: { name: 'LLC Formation', desc: 'Form a new US LLC (Wyoming, Delaware, New Mexico, Florida)' },
    it: { name: 'Costituzione LLC', desc: 'Costituisci una nuova LLC americana (Wyoming, Delaware, New Mexico, Florida)' },
  },
  {
    id: 'tax_return',
    icon: Receipt,
    color: 'text-green-600 bg-green-50',
    en: { name: 'Tax Return Filing', desc: 'Annual tax return (Form 1120, 1065, 5472)' },
    it: { name: 'Dichiarazione dei Redditi', desc: 'Dichiarazione annuale (Form 1120, 1065, 5472)' },
  },
  {
    id: 'itin',
    icon: Fingerprint,
    color: 'text-purple-600 bg-purple-50',
    en: { name: 'ITIN Application', desc: 'W-7 preparation and filing as IRS Certified Acceptance Agent' },
    it: { name: 'Richiesta ITIN', desc: 'Preparazione W-7 e invio come Agente Certificato IRS' },
  },
  {
    id: 'banking',
    icon: CreditCard,
    color: 'text-amber-600 bg-amber-50',
    en: { name: 'Business Banking', desc: 'USD (Relay) or EUR (Payset IBAN) business account' },
    it: { name: 'Conto Business', desc: 'Conto aziendale USD (Relay) o EUR IBAN (Payset)' },
  },
  {
    id: 'ein',
    icon: FileText,
    color: 'text-indigo-600 bg-indigo-50',
    en: { name: 'EIN Application', desc: 'Employer Identification Number from the IRS' },
    it: { name: 'Richiesta EIN', desc: 'Employer Identification Number dall\'IRS' },
  },
  {
    id: 'shipping',
    icon: Package,
    color: 'text-orange-600 bg-orange-50',
    en: { name: 'Shipping Service', desc: 'International shipping, mail forwarding, package handling' },
    it: { name: 'Servizio Spedizioni', desc: 'Spedizioni internazionali, inoltro posta, gestione pacchi' },
  },
  {
    id: 'notary',
    icon: FileText,
    color: 'text-rose-600 bg-rose-50',
    en: { name: 'Public Notary', desc: 'Notarization, apostille, certified copies' },
    it: { name: 'Notaio Pubblico', desc: 'Notarizzazione, apostille, copie certificate' },
  },
  {
    id: 'closure',
    icon: XCircle,
    color: 'text-red-600 bg-red-50',
    en: { name: 'Company Closure', desc: 'LLC dissolution, state filing, IRS closure letter' },
    it: { name: 'Chiusura Società', desc: 'Scioglimento LLC, filing statale, lettera chiusura IRS' },
  },
  {
    id: 'consulting',
    icon: Phone,
    color: 'text-teal-600 bg-teal-50',
    en: { name: 'Consulting Call', desc: 'One-on-one consultation about your business needs' },
    it: { name: 'Consulenza', desc: 'Consulenza personalizzata sulle tue esigenze aziendali' },
  },
]

const T = {
  en: {
    title: 'Request a Service',
    subtitle: 'Select a service and tell us what you need. We\'ll get back to you with a quote.',
    selectService: 'Select a service',
    details: 'Tell us more about what you need',
    detailsPlaceholder: 'Describe your request in detail...',
    urgency: 'Urgency',
    normal: 'Normal',
    urgent: 'Urgent',
    submit: 'Submit Request',
    submitting: 'Submitting...',
    success: 'Request Submitted!',
    successMsg: 'We\'ll review your request and get back to you shortly via chat or email.',
    back: 'Back to Services',
    backToPortal: 'Back to Dashboard',
    chatBtn: 'Go to Chat',
  },
  it: {
    title: 'Richiedi un Servizio',
    subtitle: 'Seleziona un servizio e dicci di cosa hai bisogno. Ti risponderemo con un preventivo.',
    selectService: 'Seleziona un servizio',
    details: 'Raccontaci di più su cosa ti serve',
    detailsPlaceholder: 'Descrivi la tua richiesta in dettaglio...',
    urgency: 'Urgenza',
    normal: 'Normale',
    urgent: 'Urgente',
    submit: 'Invia Richiesta',
    submitting: 'Invio in corso...',
    success: 'Richiesta Inviata!',
    successMsg: 'Esamineremo la tua richiesta e ti risponderemo a breve via chat o email.',
    back: 'Torna ai Servizi',
    backToPortal: 'Torna alla Dashboard',
    chatBtn: 'Vai alla Chat',
  },
}

export function ServiceRequestClient({ contactId, accountId, userName, locale }: ServiceRequestClientProps) {
  const router = useRouter()
  const t = locale === 'it' ? T.it : T.en
  const [selected, setSelected] = useState<string | null>(null)
  const [details, setDetails] = useState('')
  const [urgency, setUrgency] = useState<'normal' | 'urgent'>('normal')
  const [submitting, setSubmitting] = useState(false)
  const [submitted, setSubmitted] = useState(false)

  const handleSubmit = async () => {
    if (!selected || !details.trim()) return
    setSubmitting(true)

    try {
      const service = SERVICES.find(s => s.id === selected)
      const serviceName = locale === 'it' ? service?.it.name : service?.en.name

      // Submit via chat API (creates a message visible to staff).
      // Pass account_id so the message lands on the account chat — without
      // it, the row is stored with account_id=NULL and orphaned into the
      // contact-fallback chat (invisible to the account view).
      await fetch('/api/portal/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          account_id: accountId || undefined,
          message: `🛎️ SERVICE REQUEST: ${serviceName}\n\nDetails: ${details.trim()}\nUrgency: ${urgency}\n\nFrom: ${userName}`,
          type: 'service_request',
        }),
      })

      // Also create a CRM task via internal API
      await fetch('/api/portal/service-request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          service_id: selected,
          service_name: service?.en.name, // Always English for CRM
          details: details.trim(),
          urgency,
          contact_id: contactId,
        }),
      })

      setSubmitted(true)
    } catch {
      // Silently fail — the chat message is the primary delivery
    } finally {
      setSubmitting(false)
    }
  }

  if (submitted) {
    return (
      <div className="max-w-md mx-auto text-center py-16">
        <div className="h-16 w-16 rounded-full bg-green-100 flex items-center justify-center mx-auto mb-4">
          <CheckCircle className="h-8 w-8 text-green-600" />
        </div>
        <h2 className="text-xl font-semibold mb-2">{t.success}</h2>
        <p className="text-zinc-500 text-sm mb-8">{t.successMsg}</p>
        <div className="flex gap-3 justify-center">
          <button
            onClick={() => router.push('/portal')}
            className="px-4 py-2 text-sm border rounded-lg hover:bg-zinc-50"
          >
            {t.backToPortal}
          </button>
          <button
            onClick={() => router.push('/portal/chat')}
            className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 flex items-center gap-2"
          >
            <MessageCircle className="h-4 w-4" />
            {t.chatBtn}
          </button>
        </div>
      </div>
    )
  }

  return (
    <div>
      <div className="mb-6">
        <h1 className="text-xl sm:text-2xl font-semibold tracking-tight text-zinc-900">{t.title}</h1>
        <p className="text-zinc-500 text-sm mt-1">{t.subtitle}</p>
      </div>

      {!selected ? (
        // Service grid
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {SERVICES.map(svc => {
            const Icon = svc.icon
            const label = locale === 'it' ? svc.it : svc.en
            return (
              <button
                key={svc.id}
                onClick={() => setSelected(svc.id)}
                className="flex items-start gap-3 p-4 bg-white border rounded-xl hover:border-blue-300 hover:shadow-sm transition-all text-left"
              >
                <div className={cn('p-2.5 rounded-lg shrink-0', svc.color)}>
                  <Icon className="h-5 w-5" />
                </div>
                <div>
                  <p className="text-sm font-medium text-zinc-900">{label.name}</p>
                  <p className="text-xs text-zinc-500 mt-0.5">{label.desc}</p>
                </div>
              </button>
            )
          })}
        </div>
      ) : (
        // Request form
        <div className="max-w-lg">
          <button
            onClick={() => setSelected(null)}
            className="flex items-center gap-1 text-sm text-zinc-500 hover:text-zinc-700 mb-4"
          >
            <ArrowLeft className="h-4 w-4" />
            {t.back}
          </button>

          {/* Selected service card */}
          {(() => {
            const svc = SERVICES.find(s => s.id === selected)!
            const Icon = svc.icon
            const label = locale === 'it' ? svc.it : svc.en
            return (
              <div className="flex items-center gap-3 p-4 bg-white border rounded-xl mb-6">
                <div className={cn('p-2.5 rounded-lg', svc.color)}>
                  <Icon className="h-5 w-5" />
                </div>
                <div>
                  <p className="text-sm font-semibold">{label.name}</p>
                  <p className="text-xs text-zinc-500">{label.desc}</p>
                </div>
              </div>
            )
          })()}

          {/* Details */}
          <div className="mb-4">
            <label className="block text-sm font-medium text-zinc-700 mb-1">{t.details}</label>
            <textarea
              value={details}
              onChange={e => setDetails(e.target.value)}
              placeholder={t.detailsPlaceholder}
              rows={4}
              className="w-full px-3 py-2 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
            />
          </div>

          {/* Urgency */}
          <div className="mb-6">
            <label className="block text-sm font-medium text-zinc-700 mb-2">{t.urgency}</label>
            <div className="flex gap-3">
              <button
                onClick={() => setUrgency('normal')}
                className={cn(
                  'px-4 py-2 text-sm rounded-lg border transition-colors',
                  urgency === 'normal' ? 'bg-blue-50 border-blue-300 text-blue-700' : 'hover:bg-zinc-50'
                )}
              >
                {t.normal}
              </button>
              <button
                onClick={() => setUrgency('urgent')}
                className={cn(
                  'px-4 py-2 text-sm rounded-lg border transition-colors',
                  urgency === 'urgent' ? 'bg-red-50 border-red-300 text-red-700' : 'hover:bg-zinc-50'
                )}
              >
                🔴 {t.urgent}
              </button>
            </div>
          </div>

          {/* Submit */}
          <button
            onClick={handleSubmit}
            disabled={submitting || !details.trim()}
            className="w-full px-4 py-3 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 flex items-center justify-center gap-2 font-medium"
          >
            {submitting ? (
              <><Loader2 className="h-4 w-4 animate-spin" /> {t.submitting}</>
            ) : (
              <><Send className="h-4 w-4" /> {t.submit}</>
            )}
          </button>
        </div>
      )}
    </div>
  )
}
