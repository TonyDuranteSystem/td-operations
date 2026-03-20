'use client'

import { useState, useTransition } from 'react'
import { X, Loader2, Save, ArrowRight } from 'lucide-react'
import { toast } from 'sonner'
import { DEAL_STAGE, SERVICE_TYPE, PAYMENT_STATUS } from '@/lib/constants'
import { updateDeal } from '@/app/(dashboard)/pipeline/actions'
import type { UpdateDealInput } from '@/lib/schemas/deal'

interface DealItem {
  id: string
  deal_name: string
  stage: string | null
  amount: number | null
  amount_currency: string | null
  close_date: string | null
  deal_type: string | null
  deal_category: string | null
  service_type: string | null
  payment_status: string | null
  notes: string | null
  account_id: string | null
  company_name: string | null
  created_at: string
  updated_at: string
}

interface EditDealDialogProps {
  open: boolean
  onClose: () => void
  deal: DealItem
}

export function EditDealDialog({ open, onClose, deal }: EditDealDialogProps) {
  const [isPending, startTransition] = useTransition()
  const [dealName, setDealName] = useState(deal.deal_name)
  const [stage, setStage] = useState(deal.stage ?? 'Initial Consultation')
  const [amount, setAmount] = useState(deal.amount?.toString() ?? '')
  const [amountCurrency, setAmountCurrency] = useState(deal.amount_currency ?? 'USD')
  const [serviceType, setServiceType] = useState(deal.service_type ?? '')
  const [closeDate, setCloseDate] = useState(deal.close_date ?? '')
  const [paymentStatus, setPaymentStatus] = useState(deal.payment_status ?? '')
  const [notes, setNotes] = useState(deal.notes ?? '')

  if (!open) return null

  const currentStageIdx = DEAL_STAGE.indexOf(stage as typeof DEAL_STAGE[number])
  const nextStage = currentStageIdx >= 0 && currentStageIdx < DEAL_STAGE.length - 1
    ? DEAL_STAGE[currentStageIdx + 1]
    : null

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()

    startTransition(async () => {
      const input: UpdateDealInput = {
        id: deal.id,
        updated_at: deal.updated_at,
        deal_name: dealName.trim(),
        stage: stage as typeof DEAL_STAGE[number],
        amount: amount ? parseFloat(amount) : undefined,
        amount_currency: amountCurrency as 'USD' | 'EUR',
        service_type: (serviceType || undefined) as typeof SERVICE_TYPE[number] | undefined,
        close_date: closeDate || undefined,
        payment_status: paymentStatus || undefined,
        notes: notes.trim() || undefined,
      }

      const result = await updateDeal(input)

      if (result.success) {
        toast.success('Deal aggiornato')
        onClose()
      } else {
        toast.error(result.error ?? 'Errore aggiornamento')
      }
    })
  }

  const handleAdvanceStage = () => {
    if (!nextStage) return
    setStage(nextStage)
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
            <div>
              <h2 className="text-lg font-semibold">Edit Deal</h2>
              {deal.company_name && (
                <p className="text-sm text-muted-foreground">{deal.company_name}</p>
              )}
            </div>
            <button onClick={onClose} className="p-1 rounded hover:bg-zinc-100">
              <X className="h-5 w-5" />
            </button>
          </div>

          {/* Form */}
          <form onSubmit={handleSubmit} className="px-6 py-4 space-y-4">
            {/* Deal Name */}
            <div>
              <label className="block text-sm font-medium mb-1">Deal Name *</label>
              <input
                type="text"
                value={dealName}
                onChange={e => setDealName(e.target.value)}
                className="w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>

            {/* Stage + Quick advance */}
            <div>
              <label className="block text-sm font-medium mb-1">Stage</label>
              <div className="flex items-center gap-2">
                <select
                  value={stage}
                  onChange={e => setStage(e.target.value)}
                  className="flex-1 px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  {DEAL_STAGE.map(s => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
                {nextStage && (
                  <button
                    type="button"
                    onClick={handleAdvanceStage}
                    className="flex items-center gap-1 px-3 py-2 text-xs font-medium bg-blue-50 text-blue-700 rounded-md hover:bg-blue-100 transition-colors whitespace-nowrap"
                  >
                    <ArrowRight className="h-3 w-3" />
                    {nextStage}
                  </button>
                )}
              </div>
            </div>

            {/* Amount + Currency */}
            <div className="grid grid-cols-3 gap-3">
              <div className="col-span-2">
                <label className="block text-sm font-medium mb-1">Amount</label>
                <input
                  type="number"
                  value={amount}
                  onChange={e => setAmount(e.target.value)}
                  placeholder="0"
                  className="w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Currency</label>
                <select
                  value={amountCurrency}
                  onChange={e => setAmountCurrency(e.target.value)}
                  className="w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="USD">USD</option>
                  <option value="EUR">EUR</option>
                </select>
              </div>
            </div>

            {/* Service Type + Payment Status */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium mb-1">Service Type</label>
                <select
                  value={serviceType}
                  onChange={e => setServiceType(e.target.value)}
                  className="w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="">None</option>
                  {SERVICE_TYPE.map(s => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Payment Status</label>
                <select
                  value={paymentStatus}
                  onChange={e => setPaymentStatus(e.target.value)}
                  className="w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="">None</option>
                  {PAYMENT_STATUS.map(s => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
              </div>
            </div>

            {/* Close Date */}
            <div>
              <label className="block text-sm font-medium mb-1">Close Date</label>
              <input
                type="date"
                value={closeDate}
                onChange={e => setCloseDate(e.target.value)}
                className="w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>

            {/* Notes */}
            <div>
              <label className="block text-sm font-medium mb-1">Notes</label>
              <textarea
                value={notes}
                onChange={e => setNotes(e.target.value)}
                rows={3}
                placeholder="Notes..."
                className="w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
              />
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
                className="px-4 py-2 text-sm bg-zinc-900 text-white rounded-md hover:bg-zinc-800 disabled:opacity-50 flex items-center gap-2"
              >
                {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
                Save
              </button>
            </div>
          </form>
        </div>
      </div>
    </>
  )
}
