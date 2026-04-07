'use client'

import { useState, useTransition, useMemo } from 'react'
import { useRouter } from 'next/navigation'
import { FileText, Loader2, X, Upload } from 'lucide-react'
import { toast } from 'sonner'

// ── Service catalog: each service maps to a pipeline + contract type ──
const SERVICE_CATALOG = [
  // Annual management services (formation/onboarding contract)
  { id: 'company_formation', name: 'Company Formation', pipeline: 'Company Formation', contractType: 'formation', hasAnnual: true, category: 'primary' },
  { id: 'client_onboarding', name: 'Client Onboarding', pipeline: 'Client Onboarding', contractType: 'onboarding', hasAnnual: true, category: 'primary' },
  // Standalone services (lightweight contracts)
  { id: 'tax_return', name: 'Tax Return', pipeline: 'Tax Return', contractType: 'tax_return', hasAnnual: false, category: 'standalone' },
  { id: 'itin', name: 'ITIN Application', pipeline: 'ITIN', contractType: 'itin', hasAnnual: false, category: 'standalone' },
  // Add-on services (bundled with primary)
  { id: 'ein', name: 'EIN Application', pipeline: 'EIN', contractType: null, hasAnnual: false, category: 'addon' },
  { id: 'banking', name: 'Banking (Fintech)', pipeline: 'Banking Fintech', contractType: null, hasAnnual: false, category: 'addon' },
  { id: 'cmra', name: 'CMRA Mailing Address', pipeline: 'CMRA Mailing Address', contractType: null, hasAnnual: false, category: 'addon' },
  { id: 'annual_renewal', name: 'Annual Renewal', pipeline: 'Annual Renewal', contractType: null, hasAnnual: false, category: 'addon' },
  { id: 'closure', name: 'Company Closure', pipeline: 'Company Closure', contractType: null, hasAnnual: false, category: 'standalone' },
  { id: 'public_notary', name: 'Public Notary', pipeline: null, contractType: null, hasAnnual: false, category: 'addon' },
  { id: 'shipping', name: 'Shipping', pipeline: null, contractType: null, hasAnnual: false, category: 'addon' },
] as const

type ServiceId = typeof SERVICE_CATALOG[number]['id']

interface SelectedService {
  id: ServiceId
  price: string
}

const PAYMENT_TYPES = [
  { value: 'both', label: 'Let client decide (Recommended)' },
  { value: 'bank_transfer', label: 'Bank Transfer only' },
  { value: 'checkout', label: 'Card only (+5%)' },
  { value: 'none', label: 'No payment link' },
]

const PAYMENT_GATEWAYS = [
  { value: 'stripe', label: 'Stripe (default)' },
  { value: 'whop', label: 'Whop' },
]

const BANK_OPTIONS = [
  { value: 'auto', label: 'Auto (by currency)' },
  { value: 'relay', label: 'Relay (USD)' },
  { value: 'mercury', label: 'Mercury (USD)' },
  { value: 'revolut', label: 'Revolut (USD)' },
  { value: 'airwallex', label: 'Airwallex (EUR)' },
]

// ── Document types the client may need to upload ──
const DOCUMENT_TYPES = [
  { id: 'passport', name: 'Passport Copy' },
  { id: 'articles_of_organization', name: 'Articles of Organization' },
  { id: 'ein_letter', name: 'EIN Letter (IRS)' },
  { id: 'ss4', name: 'Form SS-4' },
  { id: 'operating_agreement', name: 'Operating Agreement' },
  { id: 'bank_statement', name: 'Bank Statement' },
  { id: 'proof_of_address', name: 'Proof of Address' },
  { id: 'tax_return_prior', name: 'Prior Year Tax Return' },
  { id: 'w7', name: 'Form W-7 (ITIN)' },
  { id: 'form_8832', name: 'Form 8832 (Entity Classification)' },
  { id: 'other', name: 'Other Document' },
] as const

interface CreateOfferDialogProps {
  open: boolean
  onClose: () => void
  // Either lead or account — one must be provided
  leadId?: string | null
  accountId?: string | null
  clientName: string
  clientEmail: string
  clientLanguage?: string | null
  referrerName?: string | null
  referrerType?: string | null
}

export function CreateOfferDialog({
  open,
  onClose,
  leadId,
  accountId,
  clientName,
  clientEmail,
  clientLanguage,
  referrerName,
  referrerType,
}: CreateOfferDialogProps) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()

  const [language, setLanguage] = useState(
    clientLanguage === 'Italian' || clientLanguage === 'it' ? 'it' : 'en'
  )
  const [paymentType, setPaymentType] = useState('both')
  const [paymentGateway, setPaymentGateway] = useState('stripe')
  const [bankPreference, setBankPreference] = useState('auto')
  const [currency, setCurrency] = useState('EUR')

  // Selected services with prices
  const [selected, setSelected] = useState<SelectedService[]>([])

  // Recurring costs (year 2+)
  const [installment1, setInstallment1] = useState('')
  const [installment2, setInstallment2] = useState('')

  // Required documents
  const [requiredDocs, setRequiredDocs] = useState<string[]>([])

  const currencySymbol = currency === 'EUR' ? '\u20AC' : '$'

  // ── Derived values ──
  const derivedContractType = useMemo(() => {
    for (const s of selected) {
      const catalog = SERVICE_CATALOG.find(c => c.id === s.id)
      if (catalog?.contractType) return catalog.contractType
    }
    return 'formation'
  }, [selected])

  const derivedPipelines = useMemo(() => {
    return selected
      .map(s => SERVICE_CATALOG.find(c => c.id === s.id)?.pipeline)
      .filter((p): p is string => !!p)
  }, [selected])

  const showAnnual = useMemo(() => {
    return selected.some(s => {
      const catalog = SERVICE_CATALOG.find(c => c.id === s.id)
      return catalog?.hasAnnual
    })
  }, [selected])

  const totalAmount = selected.reduce((sum, s) => {
    const n = parseFloat(s.price.replace(/[^0-9.]/g, ''))
    return sum + (isNaN(n) ? 0 : n)
  }, 0)

  const toggleService = (id: ServiceId) => {
    setSelected(prev => {
      const exists = prev.find(s => s.id === id)
      if (exists) return prev.filter(s => s.id !== id)
      return [...prev, { id, price: '' }]
    })
  }

  const updatePrice = (id: ServiceId, price: string) => {
    setSelected(prev =>
      prev.map(s => s.id === id ? { ...s, price } : s)
    )
  }

  const isSelected = (id: ServiceId) => selected.some(s => s.id === id)

  const toggleDoc = (docId: string) => {
    setRequiredDocs(prev =>
      prev.includes(docId) ? prev.filter(d => d !== docId) : [...prev, docId]
    )
  }

  // ── Submit ──
  const handleSubmit = () => {
    if (selected.length === 0) {
      toast.error('Select at least one service')
      return
    }

    const withPrices = selected.filter(s => s.price.trim())
    if (withPrices.length === 0) {
      toast.error('Enter a price for at least one service')
      return
    }

    startTransition(async () => {
      try {
        const servicesJson = selected
          .filter(s => s.price.trim())
          .map(s => {
            const catalog = SERVICE_CATALOG.find(c => c.id === s.id)!
            const svc: Record<string, unknown> = {
              name: catalog.name,
              price: `${currencySymbol}${s.price.replace(/[^0-9.]/g, '')}`,
            }
            if (catalog.contractType) svc.contract_type = catalog.contractType
            if (catalog.pipeline) svc.pipeline_type = catalog.pipeline
            return svc
          })

        const costItems = servicesJson.map(s => ({
          name: s.name,
          price: s.price,
        }))

        const costSummary = [{
          label: 'Setup Fee',
          total: `${currencySymbol}${totalAmount.toLocaleString('en-US')}`,
          items: costItems,
        }]

        let recurringCosts = null
        if (showAnnual && (installment1 || installment2)) {
          recurringCosts = []
          if (installment1) {
            recurringCosts.push({ label: '1st Installment (January)', price: `${currencySymbol}${installment1}` })
          }
          if (installment2) {
            recurringCosts.push({ label: '2nd Installment (June)', price: `${currencySymbol}${installment2}` })
          }
          const annualTotal = (parseFloat(installment1 || '0') + parseFloat(installment2 || '0'))
          if (annualTotal > 0) {
            recurringCosts.push({ label: 'Annual Total', price: `${currencySymbol}${annualTotal.toLocaleString('en-US')}` })
          }
        }

        // Build required_documents JSONB
        const requiredDocsJson = requiredDocs.length > 0
          ? requiredDocs.map(docId => {
              const doc = DOCUMENT_TYPES.find(d => d.id === docId)
              return { id: docId, name: doc?.name || docId }
            })
          : null

        const res = await fetch('/api/crm/admin-actions/create-offer', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            lead_id: leadId || null,
            account_id: accountId || null,
            client_name: clientName,
            client_email: clientEmail,
            language,
            contract_type: derivedContractType,
            payment_type: paymentType === 'both' ? 'checkout' : paymentType,
            payment_gateway: paymentGateway,
            bank_preference: bankPreference,
            services: servicesJson,
            cost_summary: costSummary,
            recurring_costs: recurringCosts,
            bundled_pipelines: derivedPipelines,
            referrer_name: referrerName || null,
            referrer_type: referrerType || null,
            required_documents: requiredDocsJson,
          }),
        })

        const data = await res.json()

        if (!res.ok) {
          toast.error(data.error || 'Failed to create offer')
          return
        }

        toast.success(`Offer created: ${data.token}`)
        onClose()
        router.refresh()
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'An error occurred')
      }
    })
  }

  if (!open) return null

  const primaryServices = SERVICE_CATALOG.filter(s => s.category === 'primary')
  const standaloneServices = SERVICE_CATALOG.filter(s => s.category === 'standalone')
  const addonServices = SERVICE_CATALOG.filter(s => s.category === 'addon')
  const sourceLabel = accountId ? 'account' : 'lead'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-2xl max-h-[90vh] overflow-y-auto mx-4">
        {/* Header */}
        <div className="flex items-center justify-between p-5 border-b">
          <div className="flex items-center gap-2">
            <FileText className="h-5 w-5 text-blue-600" />
            <h2 className="text-lg font-semibold">Create Offer</h2>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-zinc-100">
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="p-5 space-y-5">
          {/* Client info (locked) */}
          <div className="bg-zinc-50 rounded-lg p-3">
            <p className="text-xs text-muted-foreground mb-1">Client (from {sourceLabel} -- not editable)</p>
            <p className="text-sm font-medium">{clientName}</p>
            <p className="text-sm text-zinc-600">{clientEmail}</p>
            {referrerName && (
              <p className="text-xs text-blue-600 mt-1">Referrer: {referrerName} ({referrerType || 'client'})</p>
            )}
          </div>

          {/* Services -- grouped by category */}
          <div>
            <label className="block text-sm font-semibold mb-3">What is the client buying?</label>

            <p className="text-xs font-medium text-zinc-500 uppercase tracking-wide mb-2">Annual Management</p>
            <div className="space-y-2 mb-4">
              {primaryServices.map(svc => (
                <ServiceRow
                  key={svc.id}
                  service={svc}
                  isSelected={isSelected(svc.id)}
                  price={selected.find(s => s.id === svc.id)?.price || ''}
                  currencySymbol={currencySymbol}
                  onToggle={() => toggleService(svc.id)}
                  onPriceChange={(p) => updatePrice(svc.id, p)}
                />
              ))}
            </div>

            <p className="text-xs font-medium text-zinc-500 uppercase tracking-wide mb-2">Standalone Services</p>
            <div className="space-y-2 mb-4">
              {standaloneServices.map(svc => (
                <ServiceRow
                  key={svc.id}
                  service={svc}
                  isSelected={isSelected(svc.id)}
                  price={selected.find(s => s.id === svc.id)?.price || ''}
                  currencySymbol={currencySymbol}
                  onToggle={() => toggleService(svc.id)}
                  onPriceChange={(p) => updatePrice(svc.id, p)}
                />
              ))}
            </div>

            <p className="text-xs font-medium text-zinc-500 uppercase tracking-wide mb-2">Add-ons</p>
            <div className="space-y-2">
              {addonServices.map(svc => (
                <ServiceRow
                  key={svc.id}
                  service={svc}
                  isSelected={isSelected(svc.id)}
                  price={selected.find(s => s.id === svc.id)?.price || ''}
                  currencySymbol={currencySymbol}
                  onToggle={() => toggleService(svc.id)}
                  onPriceChange={(p) => updatePrice(svc.id, p)}
                />
              ))}
            </div>
          </div>

          {/* Total */}
          {totalAmount > 0 && (
            <div className="flex justify-between items-center bg-zinc-50 rounded-lg p-3">
              <span className="text-sm font-medium">Total</span>
              <span className="text-lg font-bold">{currencySymbol}{totalAmount.toLocaleString('en-US')}</span>
            </div>
          )}

          {/* Language + Currency + Payment */}
          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="block text-xs font-medium mb-1">Language</label>
              <select
                value={language}
                onChange={e => setLanguage(e.target.value)}
                className="w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="en">English</option>
                <option value="it">Italian</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium mb-1">Currency</label>
              <select
                value={currency}
                onChange={e => setCurrency(e.target.value)}
                className="w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="EUR">EUR</option>
                <option value="USD">USD</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium mb-1">Payment</label>
              <select
                value={paymentType}
                onChange={e => setPaymentType(e.target.value)}
                className="w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                {PAYMENT_TYPES.map(t => (
                  <option key={t.value} value={t.value}>{t.label}</option>
                ))}
              </select>
            </div>
          </div>

          {/* Payment Gateway + Bank Account */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium mb-1">Payment Gateway</label>
              <select
                value={paymentGateway}
                onChange={e => setPaymentGateway(e.target.value)}
                disabled={paymentType === 'bank_transfer' || paymentType === 'none'}
                className="w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:opacity-50 disabled:bg-zinc-100"
              >
                {PAYMENT_GATEWAYS.map(g => (
                  <option key={g.value} value={g.value}>{g.label}</option>
                ))}
              </select>
              {(paymentType === 'bank_transfer' || paymentType === 'none') && (
                <p className="text-xs text-zinc-400 mt-0.5">N/A for this payment type</p>
              )}
            </div>
            <div>
              <label className="block text-xs font-medium mb-1">Bank Account</label>
              <select
                value={bankPreference}
                onChange={e => setBankPreference(e.target.value)}
                className="w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                {BANK_OPTIONS.map(b => (
                  <option key={b.value} value={b.value}>{b.label}</option>
                ))}
              </select>
              {bankPreference === 'auto' && (
                <p className="text-xs text-zinc-400 mt-0.5">EUR-Airwallex, USD-Relay</p>
              )}
            </div>
          </div>

          {/* Annual Rates */}
          {showAnnual && (
            <div>
              <label className="block text-sm font-medium mb-2">Annual Rates (Year 2+)</label>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-xs text-muted-foreground">1st Installment (Jan)</label>
                  <div className="relative">
                    <span className="absolute left-3 top-2 text-sm text-zinc-400">{currencySymbol}</span>
                    <input
                      type="text"
                      value={installment1}
                      onChange={e => setInstallment1(e.target.value)}
                      placeholder="1,000"
                      className="w-full pl-7 pr-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                </div>
                <div>
                  <label className="text-xs text-muted-foreground">2nd Installment (Jun)</label>
                  <div className="relative">
                    <span className="absolute left-3 top-2 text-sm text-zinc-400">{currencySymbol}</span>
                    <input
                      type="text"
                      value={installment2}
                      onChange={e => setInstallment2(e.target.value)}
                      placeholder="1,000"
                      className="w-full pl-7 pr-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                </div>
              </div>
            </div>
          )}

          {/* Required Documents */}
          <div>
            <label className="block text-sm font-semibold mb-2 flex items-center gap-1.5">
              <Upload className="h-4 w-4 text-zinc-500" />
              Required Documents (for client to upload)
            </label>
            <div className="grid grid-cols-2 gap-2">
              {DOCUMENT_TYPES.map(doc => (
                <label
                  key={doc.id}
                  className={`flex items-center gap-2 p-2 rounded-lg border cursor-pointer transition-colors ${
                    requiredDocs.includes(doc.id)
                      ? 'bg-orange-50 border-orange-300'
                      : 'bg-white border-zinc-200 hover:border-zinc-300'
                  }`}
                >
                  <input
                    type="checkbox"
                    checked={requiredDocs.includes(doc.id)}
                    onChange={() => toggleDoc(doc.id)}
                    className="h-3.5 w-3.5 rounded border-zinc-300 text-orange-600 focus:ring-orange-500"
                  />
                  <span className="text-xs">{doc.name}</span>
                </label>
              ))}
            </div>
          </div>

          {/* Auto-derived summary */}
          {selected.length > 0 && (
            <div className="bg-blue-50 rounded-lg p-3 text-sm space-y-1">
              <p className="font-medium text-blue-900">Auto-derived:</p>
              <p className="text-xs text-blue-800">
                Contract: <span className="font-medium">{derivedContractType}</span>
              </p>
              <p className="text-xs text-blue-800">
                Pipelines: <span className="font-medium">{derivedPipelines.join(', ') || 'none'}</span>
              </p>
              {(paymentType === 'checkout' || paymentType === 'both') && (
                <p className="text-xs text-blue-800">
                  {paymentType === 'both'
                    ? `Client will see both options: bank transfer + card via ${paymentGateway === 'whop' ? 'Whop' : 'Stripe'} (+5%)`
                    : `${paymentGateway === 'whop' ? 'Whop' : 'Stripe'} checkout link (+5% card fee)`}
                </p>
              )}
              <p className="text-xs text-blue-800">
                Bank: <span className="font-medium">{BANK_OPTIONS.find(b => b.value === bankPreference)?.label}</span>
              </p>
              {requiredDocs.length > 0 && (
                <p className="text-xs text-blue-800">
                  Docs required: <span className="font-medium">{requiredDocs.length}</span>
                </p>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-3 p-5 border-t">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm border rounded-md hover:bg-zinc-50"
          >
            Cancel
          </button>
          <button
            onClick={handleSubmit}
            disabled={isPending || selected.length === 0}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded-md bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileText className="h-4 w-4" />}
            Create Offer
          </button>
        </div>
      </div>
    </div>
  )
}

// ── Service row component ──
function ServiceRow({
  service,
  isSelected,
  price,
  currencySymbol,
  onToggle,
  onPriceChange,
}: {
  service: typeof SERVICE_CATALOG[number]
  isSelected: boolean
  price: string
  currencySymbol: string
  onToggle: () => void
  onPriceChange: (price: string) => void
}) {
  return (
    <div
      className={`flex items-center gap-3 p-2.5 rounded-lg border transition-colors cursor-pointer ${
        isSelected
          ? 'bg-blue-50 border-blue-300'
          : 'bg-white border-zinc-200 hover:border-zinc-300'
      }`}
      onClick={() => { if (!isSelected) onToggle() }}
    >
      <input
        type="checkbox"
        checked={isSelected}
        onChange={onToggle}
        onClick={e => e.stopPropagation()}
        className="h-4 w-4 rounded border-zinc-300 text-blue-600 focus:ring-blue-500"
      />
      <span className={`flex-1 text-sm ${isSelected ? 'font-medium text-zinc-900' : 'text-zinc-600'}`}>
        {service.name}
      </span>
      {isSelected && (
        <div className="relative" onClick={e => e.stopPropagation()}>
          <span className="absolute left-2.5 top-1.5 text-sm text-zinc-400">{currencySymbol}</span>
          <input
            type="text"
            value={price}
            onChange={e => onPriceChange(e.target.value)}
            placeholder="0"
            autoFocus
            className="w-28 pl-6 pr-3 py-1.5 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
      )}
    </div>
  )
}
