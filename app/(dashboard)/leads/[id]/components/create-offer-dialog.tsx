'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { FileText, Loader2, X, Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'

const CONTRACT_TYPES = [
  { value: 'formation', label: 'LLC Formation' },
  { value: 'onboarding', label: 'Client Onboarding' },
  { value: 'tax_return', label: 'Tax Return' },
  { value: 'itin', label: 'ITIN Application' },
]

const PIPELINE_OPTIONS = [
  'Company Formation',
  'ITIN',
  'Tax Return',
  'EIN',
  'Banking Fintech',
  'Annual Renewal',
  'CMRA Mailing Address',
  'Company Closure',
]

const PAYMENT_TYPES = [
  { value: 'bank_transfer', label: 'Bank Transfer' },
  { value: 'checkout', label: 'Whop Checkout (Card +5%)' },
  { value: 'none', label: 'No payment link' },
]

interface ServiceItem {
  name: string
  price: string
  description?: string
}

interface CreateOfferDialogProps {
  open: boolean
  onClose: () => void
  leadId: string
  leadName: string
  leadEmail: string
  leadLanguage?: string | null
  leadReferrer?: string | null
  leadReferrerType?: string | null
}

export function CreateOfferDialog({
  open,
  onClose,
  leadId,
  leadName,
  leadEmail,
  leadLanguage,
  leadReferrer,
  leadReferrerType,
}: CreateOfferDialogProps) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()

  const [contractType, setContractType] = useState('formation')
  const [language, setLanguage] = useState(
    leadLanguage === 'Italian' || leadLanguage === 'it' ? 'it' : 'en'
  )
  const [paymentType, setPaymentType] = useState('bank_transfer')
  const [currency, setCurrency] = useState('EUR')

  // Services
  const [services, setServices] = useState<ServiceItem[]>([
    { name: 'Company Formation', price: '' },
  ])

  // Bundled pipelines
  const [pipelines, setPipelines] = useState<string[]>(['Company Formation'])

  // Recurring costs (year 2+)
  const [installment1, setInstallment1] = useState('')
  const [installment2, setInstallment2] = useState('')

  const addService = () => {
    setServices([...services, { name: '', price: '' }])
  }

  const removeService = (idx: number) => {
    setServices(services.filter((_, i) => i !== idx))
  }

  const updateService = (idx: number, field: keyof ServiceItem, value: string) => {
    const updated = [...services]
    updated[idx] = { ...updated[idx], [field]: value }
    setServices(updated)
  }

  const togglePipeline = (p: string) => {
    setPipelines(prev =>
      prev.includes(p) ? prev.filter(x => x !== p) : [...prev, p]
    )
  }

  const totalAmount = services.reduce((sum, s) => {
    const n = parseFloat(s.price.replace(/[^0-9.]/g, ''))
    return sum + (isNaN(n) ? 0 : n)
  }, 0)

  const currencySymbol = currency === 'EUR' ? '€' : '$'

  const handleSubmit = () => {
    // Validate
    const validServices = services.filter(s => s.name.trim() && s.price.trim())
    if (validServices.length === 0) {
      toast.error('Add at least one service with name and price')
      return
    }

    if (pipelines.length === 0) {
      toast.error('Select at least one bundled pipeline')
      return
    }

    startTransition(async () => {
      try {
        // Build services JSONB
        const servicesJson = validServices.map(s => ({
          name: s.name,
          price: `${currencySymbol}${s.price.replace(/[^0-9.]/g, '')}`,
          description: s.description || undefined,
        }))

        // Build cost_summary JSONB
        const costItems = validServices.map(s => ({
          name: s.name,
          price: `${currencySymbol}${s.price.replace(/[^0-9.]/g, '')}`,
        }))

        const costSummary = [{
          label: 'Setup Fee',
          total: `${currencySymbol}${totalAmount.toLocaleString('en-US')}`,
          items: costItems,
        }]

        // Build recurring costs if provided
        let recurringCosts = null
        if (installment1 || installment2) {
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

        const res = await fetch('/api/crm/admin-actions/create-offer', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            lead_id: leadId,
            client_name: leadName,
            client_email: leadEmail,
            language,
            contract_type: contractType,
            payment_type: paymentType,
            services: servicesJson,
            cost_summary: costSummary,
            recurring_costs: recurringCosts,
            bundled_pipelines: pipelines,
            referrer_name: leadReferrer || null,
            referrer_type: leadReferrerType || null,
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

  const showRecurring = contractType === 'formation' || contractType === 'onboarding'

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
            <p className="text-xs text-muted-foreground mb-1">Client (from lead — not editable)</p>
            <p className="text-sm font-medium">{leadName}</p>
            <p className="text-sm text-zinc-600">{leadEmail}</p>
            {leadReferrer && (
              <p className="text-xs text-blue-600 mt-1">Referrer: {leadReferrer} ({leadReferrerType || 'client'})</p>
            )}
          </div>

          {/* Contract Type + Language */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium mb-1">Contract Type</label>
              <select
                value={contractType}
                onChange={e => setContractType(e.target.value)}
                className="w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                {CONTRACT_TYPES.map(t => (
                  <option key={t.value} value={t.value}>{t.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Language</label>
              <select
                value={language}
                onChange={e => setLanguage(e.target.value)}
                className="w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="en">English</option>
                <option value="it">Italian</option>
              </select>
            </div>
          </div>

          {/* Currency + Payment */}
          <div className="grid grid-cols-2 gap-4">
            <div>
              <label className="block text-sm font-medium mb-1">Currency</label>
              <select
                value={currency}
                onChange={e => setCurrency(e.target.value)}
                className="w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="EUR">EUR (€)</option>
                <option value="USD">USD ($)</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Payment Method</label>
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

          {/* Services */}
          <div>
            <div className="flex items-center justify-between mb-2">
              <label className="text-sm font-medium">Services</label>
              <button
                onClick={addService}
                className="inline-flex items-center gap-1 text-xs text-blue-600 hover:text-blue-800"
              >
                <Plus className="h-3 w-3" /> Add service
              </button>
            </div>
            <div className="space-y-2">
              {services.map((s, idx) => (
                <div key={idx} className="flex gap-2 items-start">
                  <input
                    type="text"
                    value={s.name}
                    onChange={e => updateService(idx, 'name', e.target.value)}
                    placeholder="Service name"
                    className="flex-1 px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                  <div className="relative">
                    <span className="absolute left-3 top-2 text-sm text-zinc-400">{currencySymbol}</span>
                    <input
                      type="text"
                      value={s.price}
                      onChange={e => updateService(idx, 'price', e.target.value)}
                      placeholder="0"
                      className="w-28 pl-7 pr-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                  {services.length > 1 && (
                    <button
                      onClick={() => removeService(idx)}
                      className="p-2 text-zinc-400 hover:text-red-600"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  )}
                </div>
              ))}
            </div>
            {totalAmount > 0 && (
              <p className="text-sm font-semibold text-right mt-2">
                Total: {currencySymbol}{totalAmount.toLocaleString('en-US')}
              </p>
            )}
          </div>

          {/* Bundled Pipelines */}
          <div>
            <label className="block text-sm font-medium mb-2">Bundled Pipelines (service deliveries to create)</label>
            <div className="flex flex-wrap gap-2">
              {PIPELINE_OPTIONS.map(p => (
                <button
                  key={p}
                  type="button"
                  onClick={() => togglePipeline(p)}
                  className={`text-xs px-2.5 py-1.5 rounded-full border transition-colors ${
                    pipelines.includes(p)
                      ? 'bg-indigo-100 text-indigo-700 border-indigo-300'
                      : 'bg-white text-zinc-500 border-zinc-200 hover:border-zinc-400'
                  }`}
                >
                  {p}
                </button>
              ))}
            </div>
          </div>

          {/* Recurring Costs */}
          {showRecurring && (
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

          {/* Summary */}
          <div className="bg-blue-50 rounded-lg p-3 text-sm">
            <p className="font-medium text-blue-900 mb-1">This will create:</p>
            <ul className="text-blue-800 space-y-0.5 text-xs">
              <li>- Offer linked to lead ({leadName})</li>
              <li>- Contract type: {CONTRACT_TYPES.find(t => t.value === contractType)?.label}</li>
              <li>- {pipelines.length} pipeline(s): {pipelines.join(', ') || 'none'}</li>
              {paymentType === 'checkout' && <li>- Whop checkout link auto-created (+5% card fee)</li>}
              {totalAmount > 0 && <li>- Total: {currencySymbol}{totalAmount.toLocaleString('en-US')}</li>}
            </ul>
          </div>
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
            disabled={isPending}
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
