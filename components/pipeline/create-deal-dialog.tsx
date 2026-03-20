'use client'

import { useState, useTransition } from 'react'
import { X, Loader2, Plus } from 'lucide-react'
import { toast } from 'sonner'
import { DEAL_STAGE, SERVICE_TYPE } from '@/lib/constants'
import { AccountCombobox } from '@/components/shared/account-combobox'
import { createDeal } from '@/app/(dashboard)/pipeline/actions'
import type { CreateDealInput } from '@/lib/schemas/deal'

interface CreateDealDialogProps {
  open: boolean
  onClose: () => void
}

export function CreateDealDialog({ open, onClose }: CreateDealDialogProps) {
  const [isPending, startTransition] = useTransition()
  const [dealName, setDealName] = useState('')
  const [accountId, setAccountId] = useState<string | undefined>()
  const [accountName, setAccountName] = useState<string | undefined>()
  const [stage, setStage] = useState('Initial Consultation')
  const [amount, setAmount] = useState('')
  const [amountCurrency, setAmountCurrency] = useState('USD')
  const [serviceType, setServiceType] = useState('')
  const [closeDate, setCloseDate] = useState('')
  const [notes, setNotes] = useState('')
  const [errors, setErrors] = useState<Record<string, string>>({})

  if (!open) return null

  const resetForm = () => {
    setDealName('')
    setAccountId(undefined)
    setAccountName(undefined)
    setStage('Initial Consultation')
    setAmount('')
    setAmountCurrency('USD')
    setServiceType('')
    setCloseDate('')
    setNotes('')
    setErrors({})
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    setErrors({})

    const newErrors: Record<string, string> = {}
    if (!dealName.trim()) newErrors.deal_name = 'Deal name is required'
    if (!accountId) newErrors.account_id = 'Account is required'
    if (Object.keys(newErrors).length > 0) {
      setErrors(newErrors)
      return
    }

    startTransition(async () => {
      const input: CreateDealInput = {
        deal_name: dealName.trim(),
        account_id: accountId!,
        stage: stage as typeof DEAL_STAGE[number],
        amount: amount ? parseFloat(amount) : undefined,
        amount_currency: amountCurrency as 'USD' | 'EUR',
        service_type: (serviceType || undefined) as typeof SERVICE_TYPE[number] | undefined,
        close_date: closeDate || undefined,
        notes: notes.trim() || undefined,
      }

      const result = await createDeal(input)

      if (result.success) {
        toast.success('Deal creato')
        resetForm()
        onClose()
      } else {
        toast.error(result.error ?? 'Errore creazione deal')
      }
    })
  }

  const handleClose = () => {
    resetForm()
    onClose()
  }

  return (
    <>
      {/* Backdrop */}
      <div className="fixed inset-0 z-50 bg-black/50" onClick={handleClose} />

      {/* Dialog */}
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div
          className="bg-white rounded-lg shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto"
          onClick={e => e.stopPropagation()}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-6 py-4 border-b">
            <h2 className="text-lg font-semibold">New Deal</h2>
            <button onClick={handleClose} className="p-1 rounded hover:bg-zinc-100">
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
                autoFocus
                placeholder="e.g., Company Formation - Acme LLC"
                className="w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              {errors.deal_name && (
                <p className="text-xs text-red-600 mt-1">{errors.deal_name}</p>
              )}
            </div>

            {/* Account */}
            <div>
              <label className="block text-sm font-medium mb-1">Account *</label>
              <AccountCombobox
                value={accountId}
                displayValue={accountName}
                onChange={(id, name) => { setAccountId(id); setAccountName(name) }}
              />
              {errors.account_id && (
                <p className="text-xs text-red-600 mt-1">{errors.account_id}</p>
              )}
            </div>

            {/* Stage + Service Type */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium mb-1">Stage</label>
                <select
                  value={stage}
                  onChange={e => setStage(e.target.value)}
                  className="w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  {DEAL_STAGE.map(s => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
              </div>
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
                placeholder="Additional details..."
                className="w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
              />
            </div>

            {/* Actions */}
            <div className="flex justify-end gap-2 pt-2">
              <button
                type="button"
                onClick={handleClose}
                className="px-4 py-2 text-sm border rounded-md hover:bg-zinc-50"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={isPending}
                className="px-4 py-2 text-sm bg-zinc-900 text-white rounded-md hover:bg-zinc-800 disabled:opacity-50 flex items-center gap-2"
              >
                {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                Create
              </button>
            </div>
          </form>
        </div>
      </div>
    </>
  )
}
