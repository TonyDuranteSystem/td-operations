'use client'

import { useState, useEffect, useTransition } from 'react'
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
  /**
   * Caller provides AT LEAST ONE of these identifiers. The dialog forwards
   * whichever is set to /api/crm/admin-actions/confirm-payment, which
   * resolves the offer + activation chain accordingly.
   *
   *   - leadId       → classic lead funnel
   *   - accountId    → existing-account re-entry (One-Time → Client upgrade)
   *   - contactId    → existing-contact re-entry (no current account/lead)
   *   - offerToken   → most specific; pass when the offer is in scope
   */
  leadId?: string
  accountId?: string
  contactId?: string
  offerToken?: string
  /** Display name shown in the dialog header + summary. */
  clientName: string
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

export function ConfirmPaymentDialog({
  open,
  onClose,
  leadId,
  accountId,
  contactId,
  offerToken,
  clientName,
  offer,
}: ConfirmPaymentDialogProps) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()

  // Payment fields
  const [method, setMethod] = useState('wire')
  const [paymentDate, setPaymentDate] = useState(new Date().toISOString().split('T')[0])
  const [reference, setReference] = useState('')
  const [paidByName, setPaidByName] = useState('')
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

  // Prefill amount + currency from the offer when the dialog opens. The fields
  // stay editable so the admin can override (e.g. a $0-setup contract that was
  // actually paid $1000 by wire). Keyed on offer token + open so re-opening
  // re-seeds but mid-edit re-renders don't clobber the admin's input.
  useEffect(() => {
    if (!open || !offer) return
    setAmount(offerTotal != null ? String(offerTotal) : '')
    setCurrency(offerCurrency)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, offer?.token])

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

    const amountTrimmed = amount.trim()
    const finalAmount = Number(amountTrimmed)
    const finalCurrency = currency
    const finalContractType = hasOffer && offer?.contract_type ? offer.contract_type : contractType
    const finalPipelines = hasOffer ? offerPipelines : selectedPipelines

    // $0 is allowed (free / already-settled activation). Only block a blank
    // field, a non-number, or a negative — never silently treat blank as 0.
    if (amountTrimmed === '' || Number.isNaN(finalAmount) || finalAmount < 0) {
      toast.error('Enter an amount (use 0 for a free / already-settled activation)')
      return
    }

    // Mode 2 (no offer + manual pipelines) is only valid for the lead path.
    // The account_id / contact_id / offer_token paths require a real offer —
    // the server returns 400 if not, but we surface a clear message earlier.
    if (!hasOffer) {
      if (!leadId) {
        toast.error('An offer is required for this account/contact. Create an offer first, then confirm payment.')
        return
      }
      if (finalPipelines.length === 0) {
        toast.error('Select at least one service pipeline')
        return
      }
    }

    startTransition(async () => {
      try {
        const res = await fetch('/api/crm/admin-actions/confirm-payment', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            // Pass through whichever identifier(s) the caller provided. The
            // route resolves priority: offer_token > lead_id > account_id >
            // contact_id (see route.ts header for full doc).
            lead_id: leadId || undefined,
            account_id: accountId || undefined,
            contact_id: contactId || undefined,
            offer_token: offerToken || undefined,
            payment_method: method,
            payment_date: paymentDate,
            payment_reference: reference || undefined,
            paid_by_name: paidByName || undefined,
            amount: finalAmount,
            currency: finalCurrency,
            contract_type: finalContractType,
            bundled_pipelines: finalPipelines,
            reason: reason || undefined,
          }),
        })

        const data = await res.json()

        if (!res.ok) {
          // Surface the server's actual error (R099) instead of a generic toast.
          toast.error(data.error || `Failed to confirm payment (HTTP ${res.status})`)
          return
        }

        toast.success(`Payment confirmed for ${clientName}`)
        onClose()
        router.refresh()
      } catch (err) {
        toast.error(err instanceof Error && err.message ? err.message : 'Network error — please try again')
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
            {/* Mode indicator — Mode 2 (manual pipelines) is only valid for
                the lead path. For account/contact/offer_token paths, an offer
                must already exist. */}
            {!hasOffer && leadId && (
              <div className="flex items-start gap-2 p-3 bg-amber-50 border border-amber-200 rounded-lg">
                <AlertTriangle className="h-4 w-4 text-amber-600 mt-0.5 shrink-0" />
                <p className="text-sm text-amber-800">
                  No offer found for this lead. Specify services manually.
                  Consider creating an offer first for a cleaner record.
                </p>
              </div>
            )}
            {!hasOffer && !leadId && (
              <div className="flex items-start gap-2 p-3 bg-red-50 border border-red-200 rounded-lg">
                <AlertTriangle className="h-4 w-4 text-red-600 mt-0.5 shrink-0" />
                <p className="text-sm text-red-800">
                  No offer found. Create and send an offer before confirming payment for this {accountId ? 'account' : 'contact'}.
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
                  <option value="crypto">Crypto</option>
                  <option value="cash">Cash</option>
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

            {/* Paid By (third-party payer) */}
            <div>
              <label className="block text-sm font-medium mb-1">
                Paid By <span className="text-zinc-400 font-normal">(if different from client)</span>
              </label>
              <input
                type="text"
                value={paidByName}
                onChange={e => setPaidByName(e.target.value)}
                placeholder="Leave empty if the client paid directly"
                className="w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>

            {/* Amount + Currency — always editable. Prefilled from the offer
                when one exists, but the admin can override (e.g. a $0-setup
                contract that was actually paid by wire). Enter 0 to activate a
                free / already-settled contract without creating an invoice. */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium mb-1">Amount *</label>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={amount}
                  onChange={e => setAmount(e.target.value)}
                  placeholder="0.00"
                  className="w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                {hasOffer && (
                  <p className="mt-1 text-xs text-zinc-500">
                    Prefilled from offer — edit if the paid amount differs. Use 0 for a free activation (no invoice created).
                  </p>
                )}
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

            {/* Mode 2 — Manual fields (no offer + lead path only) */}
            {!hasOffer && leadId && (
              <>
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

            {/* Summary — items adapt to whichever path the dialog was
                opened from. The lead-funnel path includes the lead→contact
                conversion + form trigger; the account/contact re-entry path
                runs the upgrade and activation chain instead. */}
            <div className="bg-blue-50 rounded-lg p-3 text-sm text-blue-800">
              <p className="font-medium mb-1">This will:</p>
              <ul className="list-disc list-inside space-y-0.5 text-xs">
                <li>Record payment as Paid</li>
                {leadId && <li>Convert lead to contact</li>}
                {!leadId && hasOffer && <li>Upgrade client (account_type → Client when annual)</li>}
                <li>Create service deliveries</li>
                {leadId && <li>Trigger data collection form</li>}
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
