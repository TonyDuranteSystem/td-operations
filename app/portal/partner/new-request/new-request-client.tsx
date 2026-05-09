'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import {
  Building2, FileText, CreditCard, Package, Receipt,
  XCircle, Fingerprint, Phone, Send, CheckCircle, ArrowLeft,
  Loader2, MessageCircle, PlusCircle, User,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { labelForServiceStatic } from '@/lib/services'

interface Account {
  id: string
  company_name: string
}

interface Props {
  contactId: string
  partnerName: string
  accounts: Account[]
  preselectedAccountId: string | null
  preselectedAccountName: string | null
}

// Slug → UI metadata (icon, color, marketing description). Display label
// is fetched from the services catalog via labelForServiceStatic so wording
// stays canonical across the app. Listed in display order.
const SERVICE_UI: ReadonlyArray<{
  slug: string
  icon: typeof Building2
  color: string
  desc: string
}> = [
  { slug: 'llc_formation', icon: Building2, color: 'text-blue-600 bg-blue-50', desc: 'Form a new US LLC (Wyoming, Delaware, New Mexico, Florida)' },
  { slug: 'tax_return', icon: Receipt, color: 'text-green-600 bg-green-50', desc: 'Annual tax return (Form 1120, 1065, 5472)' },
  { slug: 'itin', icon: Fingerprint, color: 'text-purple-600 bg-purple-50', desc: 'W-7 preparation and filing as IRS Certified Acceptance Agent' },
  { slug: 'banking', icon: CreditCard, color: 'text-amber-600 bg-amber-50', desc: 'USD (Relay) or EUR (Payset IBAN) business account' },
  { slug: 'ein', icon: FileText, color: 'text-indigo-600 bg-indigo-50', desc: 'Employer Identification Number from the IRS' },
  { slug: 'shipping', icon: Package, color: 'text-orange-600 bg-orange-50', desc: 'International shipping, mail forwarding, package handling' },
  { slug: 'notary', icon: FileText, color: 'text-rose-600 bg-rose-50', desc: 'Notarization, apostille, certified copies' },
  { slug: 'closure', icon: XCircle, color: 'text-red-600 bg-red-50', desc: 'LLC dissolution, state filing, IRS closure letter' },
  { slug: 'consulting', icon: Phone, color: 'text-teal-600 bg-teal-50', desc: 'One-on-one consultation about your business needs' },
]

export function PartnerNewRequestClient({
  contactId,
  partnerName,
  accounts,
  preselectedAccountId,
  preselectedAccountName,
}: Props) {
  const router = useRouter()

  // Step 1 state — client selection
  const [step, setStep] = useState<1 | 2>(preselectedAccountId ? 2 : 1)
  const [selectedAccountId, setSelectedAccountId] = useState<string>(preselectedAccountId ?? '')
  const [isNewClient, setIsNewClient] = useState(false)
  const [newClientName, setNewClientName] = useState('')
  const [newClientEmail, setNewClientEmail] = useState('')

  // Step 2 state — service + details
  const [selectedService, setSelectedService] = useState<string | null>(null)
  const [details, setDetails] = useState('')
  const [urgency, setUrgency] = useState<'normal' | 'urgent'>('normal')
  const [submitting, setSubmitting] = useState(false)
  const [submitted, setSubmitted] = useState(false)

  const selectedAccount = accounts.find(a => a.id === selectedAccountId)
  const clientLabel = isNewClient
    ? (newClientName.trim() || 'New Client')
    : (selectedAccount?.company_name ?? preselectedAccountName ?? '—')

  const canProceedStep1 = isNewClient
    ? newClientName.trim().length > 0
    : selectedAccountId !== ''

  const handleSubmit = async () => {
    if (!selectedService || !details.trim()) return
    setSubmitting(true)

    try {
      const serviceName = labelForServiceStatic(selectedService)
      const clientInfo = isNewClient && newClientEmail
        ? `${clientLabel} (${newClientEmail})`
        : clientLabel

      await fetch('/api/portal/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          account_id: isNewClient ? undefined : (selectedAccountId || undefined),
          message: `🛎️ PARTNER REQUEST [${partnerName}]\nClient: ${clientInfo}\nService: ${serviceName}\n\nDetails: ${details.trim()}\nUrgency: ${urgency}`,
          type: 'service_request',
        }),
      })

      await fetch('/api/portal/service-request', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          service_id: selectedService,
          service_name: serviceName,
          details: `[Partner: ${partnerName}] Client: ${clientInfo}\n\n${details.trim()}`,
          urgency,
          contact_id: contactId,
        }),
      })

      setSubmitted(true)
    } catch {
      // Chat message is the primary delivery — silently continue
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
        <h2 className="text-xl font-semibold mb-2">Request Submitted!</h2>
        <p className="text-zinc-500 text-sm mb-8">
          We&apos;ll review your request for <strong>{clientLabel}</strong> and get back to you shortly via chat.
        </p>
        <div className="flex gap-3 justify-center">
          <button
            onClick={() => router.push('/portal/partner/clients')}
            className="px-4 py-2 text-sm border rounded-lg hover:bg-zinc-50"
          >
            Back to Clients
          </button>
          <button
            onClick={() => router.push('/portal/chat')}
            className="px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 flex items-center gap-2"
          >
            <MessageCircle className="h-4 w-4" />
            Go to Chat
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl sm:text-2xl font-semibold tracking-tight text-zinc-900">New Request</h1>
        <p className="text-zinc-500 text-sm mt-1">
          Submit a service request on behalf of one of your clients.
        </p>
      </div>

      {/* Step indicator */}
      <div className="flex items-center gap-2 text-xs text-zinc-400">
        <span className={cn('font-medium', step === 1 ? 'text-blue-600' : 'text-zinc-400')}>1. Select Client</span>
        <span>→</span>
        <span className={cn('font-medium', step === 2 ? 'text-blue-600' : 'text-zinc-400')}>2. Service &amp; Details</span>
      </div>

      {/* Step 1 — Client */}
      {step === 1 && (
        <div className="space-y-4">
          <div className="space-y-2">
            {accounts.map(a => (
              <button
                key={a.id}
                onClick={() => { setSelectedAccountId(a.id); setIsNewClient(false) }}
                className={cn(
                  'w-full flex items-center gap-3 p-4 bg-white border rounded-xl text-left transition-all',
                  selectedAccountId === a.id && !isNewClient
                    ? 'border-blue-400 ring-1 ring-blue-200 bg-blue-50'
                    : 'hover:border-zinc-300'
                )}
              >
                <div className="w-8 h-8 rounded-full bg-zinc-100 flex items-center justify-center shrink-0">
                  <Building2 className="h-4 w-4 text-zinc-500" />
                </div>
                <span className="text-sm font-medium text-zinc-900">{a.company_name}</span>
              </button>
            ))}

            {/* New Client option */}
            <button
              onClick={() => { setIsNewClient(true); setSelectedAccountId('') }}
              className={cn(
                'w-full flex items-center gap-3 p-4 bg-white border rounded-xl text-left transition-all',
                isNewClient
                  ? 'border-blue-400 ring-1 ring-blue-200 bg-blue-50'
                  : 'hover:border-zinc-300 border-dashed'
              )}
            >
              <div className="w-8 h-8 rounded-full bg-zinc-100 flex items-center justify-center shrink-0">
                <PlusCircle className="h-4 w-4 text-zinc-500" />
              </div>
              <span className="text-sm font-medium text-zinc-600">New Client</span>
            </button>
          </div>

          {/* New client fields */}
          {isNewClient && (
            <div className="space-y-3 p-4 bg-zinc-50 rounded-xl border">
              <div>
                <label className="block text-xs font-medium text-zinc-700 mb-1">Client Name *</label>
                <input
                  type="text"
                  value={newClientName}
                  onChange={e => setNewClientName(e.target.value)}
                  placeholder="Full name or company name"
                  className="w-full px-3 py-2 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-zinc-700 mb-1">Client Email</label>
                <input
                  type="email"
                  value={newClientEmail}
                  onChange={e => setNewClientEmail(e.target.value)}
                  placeholder="client@example.com"
                  className="w-full px-3 py-2 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
            </div>
          )}

          <button
            onClick={() => setStep(2)}
            disabled={!canProceedStep1}
            className="w-full px-4 py-3 bg-blue-600 text-white rounded-xl text-sm font-medium hover:bg-blue-700 disabled:opacity-50 transition-colors"
          >
            Next: Choose Service
          </button>
        </div>
      )}

      {/* Step 2 — Service + Details */}
      {step === 2 && (
        <div className="space-y-5">
          {/* Selected client */}
          <div className="flex items-center gap-3 p-3 bg-blue-50 border border-blue-200 rounded-xl">
            <div className="w-8 h-8 rounded-full bg-blue-100 flex items-center justify-center shrink-0">
              {isNewClient ? <User className="h-4 w-4 text-blue-600" /> : <Building2 className="h-4 w-4 text-blue-600" />}
            </div>
            <div className="flex-1 min-w-0">
              <p className="text-xs text-blue-500 font-medium">Request for</p>
              <p className="text-sm font-semibold text-blue-900 truncate">{clientLabel}</p>
            </div>
            {!preselectedAccountId && (
              <button onClick={() => setStep(1)} className="text-xs text-blue-500 hover:text-blue-700 shrink-0">
                Change
              </button>
            )}
          </div>

          {/* Service grid */}
          {!selectedService ? (
            <>
              <p className="text-sm font-medium text-zinc-700">Select a service</p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {SERVICE_UI.map(svc => {
                  const Icon = svc.icon
                  return (
                    <button
                      key={svc.slug}
                      onClick={() => setSelectedService(svc.slug)}
                      className="flex items-start gap-3 p-4 bg-white border rounded-xl hover:border-blue-300 hover:shadow-sm transition-all text-left"
                    >
                      <div className={cn('p-2.5 rounded-lg shrink-0', svc.color)}>
                        <Icon className="h-5 w-5" />
                      </div>
                      <div>
                        <p className="text-sm font-medium text-zinc-900">{labelForServiceStatic(svc.slug)}</p>
                        <p className="text-xs text-zinc-500 mt-0.5">{svc.desc}</p>
                      </div>
                    </button>
                  )
                })}
              </div>
            </>
          ) : (
            <div className="space-y-4">
              <button
                onClick={() => setSelectedService(null)}
                className="flex items-center gap-1 text-sm text-zinc-500 hover:text-zinc-700"
              >
                <ArrowLeft className="h-4 w-4" />
                Back to services
              </button>

              {/* Selected service card */}
              {(() => {
                const svc = SERVICE_UI.find(s => s.slug === selectedService)!
                const Icon = svc.icon
                return (
                  <div className="flex items-center gap-3 p-4 bg-white border rounded-xl">
                    <div className={cn('p-2.5 rounded-lg', svc.color)}>
                      <Icon className="h-5 w-5" />
                    </div>
                    <div>
                      <p className="text-sm font-semibold">{labelForServiceStatic(svc.slug)}</p>
                      <p className="text-xs text-zinc-500">{svc.desc}</p>
                    </div>
                  </div>
                )
              })()}

              <div>
                <label className="block text-sm font-medium text-zinc-700 mb-1">
                  Tell us more about what the client needs
                </label>
                <textarea
                  value={details}
                  onChange={e => setDetails(e.target.value)}
                  placeholder="Describe the request in detail..."
                  rows={4}
                  className="w-full px-3 py-2 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-zinc-700 mb-2">Urgency</label>
                <div className="flex gap-3">
                  <button
                    onClick={() => setUrgency('normal')}
                    className={cn(
                      'px-4 py-2 text-sm rounded-lg border transition-colors',
                      urgency === 'normal' ? 'bg-blue-50 border-blue-300 text-blue-700' : 'hover:bg-zinc-50'
                    )}
                  >
                    Normal
                  </button>
                  <button
                    onClick={() => setUrgency('urgent')}
                    className={cn(
                      'px-4 py-2 text-sm rounded-lg border transition-colors',
                      urgency === 'urgent' ? 'bg-red-50 border-red-300 text-red-700' : 'hover:bg-zinc-50'
                    )}
                  >
                    🔴 Urgent
                  </button>
                </div>
              </div>

              <button
                onClick={handleSubmit}
                disabled={submitting || !details.trim()}
                className="w-full px-4 py-3 text-sm bg-blue-600 text-white rounded-xl hover:bg-blue-700 disabled:opacity-50 flex items-center justify-center gap-2 font-medium transition-colors"
              >
                {submitting ? (
                  <><Loader2 className="h-4 w-4 animate-spin" /> Submitting...</>
                ) : (
                  <><Send className="h-4 w-4" /> Submit Request</>
                )}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
