'use client'

import { useState, useTransition } from 'react'
import { X, Loader2, CreditCard, AlertTriangle } from 'lucide-react'
import { toast } from 'sonner'
import { useRouter } from 'next/navigation'

interface OfferData {
  token: string
  contract_type: string | null
  bundled_pipelines: string[] | null
  cost_summary: Array<{ label: string; total?: string; items?: Array<{ name: string; price: string }> }> | null
}

interface ConfirmPaymentDialogProps {
  open: boolean
  onClose: () => void
  leadId: string
  leadName: string
  offer: OfferData | null
}

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

const CONTRACT_TYPES = [
  { value: 'formation', label: 'Formation (new LLC)' },
  { value: 'onboarding', label: 'Onboarding (existing LLC)' },
  { value: 'tax_return', label: 'Tax Return' },
  { value: 'itin', label: 'ITIN Application' },
]

export function ConfirmPaymentDialog({ open, onClose, leadId, leadName, offer }: ConfirmPaymentDialogProps) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()

  // Payment fields
  const [method, setMethod] = useState('wire')
  const [paymentDate, setPaymentDate] = useState(new Date().toISOString().split('T')[0])
  const [reference, setReference] = useState('')
  const [reason, setReason] = useState('')

  // Mode 2 fields (no offer)
  const [amount, setAmount] = useState('')
  const [currency, setCurrency] = useState<'USD' | 'EUR'>('EUR')
  const [contractType, setContractType] = useState('formation')
  const [selectedPipelines, setSelectedPipelines] = useState<string[]>([])

  const hasOffer = !!offer
  const offerPipelines = Array.isArray(offer?.bundled_pipelines) ? offer.bundled_pipelines : []

  // Derive amount from offer cost_summary
  const offerTotal = (() => {
    if (!offer?.cost_summary || !Array.isArray(offer.cost_summary)) return null
    for (const section of offer.cost_summary) {
      if (section.total) {
        const match = section.total.match(/([\d,.]+)/)
        if (match) return parseFloat(match[1].replace(',', ''))
      }
    }
    return null
  })()

  // Derive currency from cost_summary
  const offerCurrency = (() => {
    if (!offer?.cost_summary || !Array.isArray(offer.cost_summary)) return 'EUR'
    for (const section of offer.cost_summary) {
      if (section.total && section.total.includes('$')) return 'USD'
    }
    return 'EUR'
  })()

  if (!open) return null

  const handlePipelineToggle = (pipeline: string) => {
    setSelectedPipelines(prev =>
      prev.includes(pipeline)
        ? prev.filter(p => p !== pipeline)
        : [...prev, pipeline]
    )
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()

    const finalAmount = hasOffer && offerTotal ? offerTotal : Number(amount)
    const finalCurrency = hasOffer ? offerCurrency : currency
    const finalContractType = hasOffer && offer?.contract_type ? offer.contract_type : contractType
    const finalPipelines = hasOffer ? offerPipelines : selectedPipelines

    if (!finalAmount || finalAmount <= 0) {
      toast.error('Amount is required and must be > 0')
      return
    }

    if (!hasOffer && finalPipelines.length === 0) {
      toast.error('Select at least one service pipeline')
      return
    }

    startTransition(async () => {
      try {
        const res = await fetch('/api/crm/admin-actions/confirm-payment', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            lead_id: leadId,
            payment_method: method,
            payment_date: paymentDate,
            payment_reference: reference || undefined,
            amount: finalAmount,
            currency: finalCurrency,
            contract_type: finalContractType,
            bundled_pipelines: finalPipelines,
            reason: reason || undefined,
          }),
        })

        const data = await res.json()

        if (!res.ok) {
          toast.error(data.error || 'Failed to confirm payment')
          return
        }

        toast.success(`Payment confirmed for ${leadName}`)
        onClose()
        router.refresh()
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'An error occurred')
      }
    })
  }

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 z-50 bg-black/50" onClick={onClose} />

      {/* Dialog */}
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div
          className="bg-white rounded-lg shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto"
          onClick={e => e.stopPropagation()}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-6 py-4 border-b">
            <h2 className="text-lg font-semibold flex items-center gap-2">
              <CreditCard className="h-5 w-5" />
              Confirm Payment
            </h2>
            <button onClick={onClose} className="p-1 rounded hover:bg-zinc-100">
              <X className="h-5 w-5" />
            </button>
          </div>

          <form onSubmit={handleSubmit} className="px-6 py-4 space-y-4">
            {/* Mode indicator */}
            {!hasOffer && (
              <div className="flex items-start gap-2 p-3 bg-amber-50 border border-amber-200 rounded-lg">
                <AlertTriangle className="h-4 w-4 text-amber-600 mt-0.5 shrink-0" />
                <p className="text-sm text-amber-800">
                  No offer found for this lead. Specify services manually.
                  Consider creating an offer first for a cleaner record.
                </p>
              </div>
            )}

            {/* Pre-filled offer info */}
            {hasOffer && (
              <div className="bg-zinc-50 rounded-lg p-3 space-y-2">
                <p className="text-xs font-medium text-zinc-500 uppercase">From Offer</p>
                <div className="grid grid-cols-2 gap-2 text-sm">
                  <div>
                    <span className="text-zinc-500">Amount:</span>{' '}
                    <span className="font-semibold">
                      {offerCurrency === 'EUR' ? '€' : '$'}{offerTotal?.toLocaleString() ?? '—'}
                    </span>
                  </div>
                  <div>
                    <span className="text-zinc-500">Type:</span>{' '}
                    <span className="font-medium capitalize">{offer?.contract_type ?? '—'}</span>
                  </div>
                </div>
                {offerPipelines.length > 0 && (
                  <div>
                    <span className="text-xs text-zinc-500">Pipelines:</span>
                    <div className="flex flex-wrap gap-1 mt-1">
                      {offerPipelines.map(p => (
                        <span key={p} className="text-xs px-2 py-0.5 rounded bg-indigo-50 text-indigo-700 font-medium">
                          {p}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Payment Method + Date */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium mb-1">Payment Method *</label>
                <select
                  value={method}
                  onChange={e => setMethod(e.target.value)}
                  className="w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="wire">Wire Transfer</option>
                  <option value="card">Card</option>
                  <option value="whop">Whop</option>
                  <option value="other">Other</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Payment Date *</label>
                <input
                  type="date"
                  value={paymentDate}
                  onChange={e => setPaymentDate(e.target.value)}
                  className="w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
            </div>

            {/* Reference */}
            <div>
              <label className="block text-sm font-medium mb-1">Reference / Transaction ID</label>
              <input
                type="text"
                value={reference}
                onChange={e => setReference(e.target.value)}
                placeholder="Wire transfer ID, Whop order ID..."
                className="w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>

            {/* Mode 2 — Manual fields (no offer) */}
            {!hasOffer && (
              <>
                {/* Amount + Currency */}
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-sm font-medium mb-1">Amount *</label>
                    <input
                      type="number"
                      step="0.01"
                      value={amount}
                      onChange={e => setAmount(e.target.value)}
                      placeholder="0.00"
                      className="w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium mb-1">Currency</label>
                    <select
                      value={currency}
                      onChange={e => setCurrency(e.target.value as 'USD' | 'EUR')}
                      className="w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                    >
                      <option value="EUR">EUR (€)</option>
                      <option value="USD">USD ($)</option>
                    </select>
                  </div>
                </div>

                {/* Contract Type */}
                <div>
                  <label className="block text-sm font-medium mb-1">Contract Type *</label>
                  <select
                    value={contractType}
                    onChange={e => setContractType(e.target.value)}
                    className="w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                  >
                    {CONTRACT_TYPES.map(ct => (
                      <option key={ct.value} value={ct.value}>{ct.label}</option>
                    ))}
                  </select>
                </div>

                {/* Service Pipelines */}
                <div>
                  <label className="block text-sm font-medium mb-1">Service Pipelines *</label>
                  <div className="grid grid-cols-2 gap-2">
                    {PIPELINE_OPTIONS.map(pipeline => (
                      <label
                        key={pipeline}
                        className="flex items-center gap-2 text-sm p-2 rounded border hover:bg-zinc-50 cursor-pointer"
                      >
                        <input
                          type="checkbox"
                          checked={selectedPipelines.includes(pipeline)}
                          onChange={() => handlePipelineToggle(pipeline)}
                          className="rounded border-zinc-300"
                        />
                        {pipeline}
                      </label>
                    ))}
                  </div>
                </div>
              </>
            )}

            {/* Reason (optional) */}
            <div>
              <label className="block text-sm font-medium mb-1">Reason / Notes</label>
              <textarea
                value={reason}
                onChange={e => setReason(e.target.value)}
                rows={2}
                placeholder="Why is this being confirmed manually?"
                className="w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
              />
            </div>

            {/* Summary */}
            <div className="bg-blue-50 rounded-lg p-3 text-sm text-blue-800">
              <p className="font-medium mb-1">This will:</p>
              <ul className="list-disc list-inside space-y-0.5 text-xs">
                <li>Record payment as Paid</li>
                <li>Convert lead to contact</li>
                <li>Create service deliveries</li>
                <li>Trigger data collection form</li>
                <li>Send activation email to client</li>
              </ul>
            </div>

            {/* Actions */}
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 text-sm border rounded-md hover:bg-zinc-50"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={isPending}
                className="px-4 py-2 text-sm bg-emerald-600 text-white rounded-md hover:bg-emerald-700 disabled:opacity-50 flex items-center gap-2"
              >
                {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <CreditCard className="h-4 w-4" />}
                Confirm Payment
              </button>
            </div>
          </form>
        </div>
      </div>
    </>
  )
}
