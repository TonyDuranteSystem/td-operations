'use client'

import { useState, useTransition } from 'react'
import { X, Loader2, Plus } from 'lucide-react'
import { toast } from 'sonner'
import { SERVICE_TYPE, SERVICE_STATUS } from '@/lib/constants'
import { AccountCombobox } from '@/components/shared/account-combobox'
import { createService } from '@/app/(dashboard)/services/actions'
import type { CreateServiceInput } from '@/lib/schemas/service'

interface CreateServiceDialogProps {
  open: boolean
  onClose: () => void
}

export function CreateServiceDialog({ open, onClose }: CreateServiceDialogProps) {
  const [isPending, startTransition] = useTransition()
  const [serviceName, setServiceName] = useState('')
  const [serviceType, setServiceType] = useState<string>(SERVICE_TYPE[0])
  const [status, setStatus] = useState<string>('Not Started')
  const [amount, setAmount] = useState('')
  const [amountCurrency, setAmountCurrency] = useState('USD')
  const [totalSteps, setTotalSteps] = useState('')
  const [notes, setNotes] = useState('')
  const [accountId, setAccountId] = useState<string | undefined>()
  const [accountName, setAccountName] = useState<string | undefined>()
  const [errors, setErrors] = useState<Record<string, string>>({})

  if (!open) return null

  const resetForm = () => {
    setServiceName('')
    setServiceType(SERVICE_TYPE[0])
    setStatus('Not Started')
    setAmount('')
    setAmountCurrency('USD')
    setTotalSteps('')
    setNotes('')
    setAccountId(undefined)
    setAccountName(undefined)
    setErrors({})
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    setErrors({})

    if (!serviceName.trim()) {
      setErrors({ service_name: 'Service name is required' })
      return
    }
    if (!accountId) {
      setErrors({ account_id: 'Account is required' })
      return
    }

    startTransition(async () => {
      const result = await createService({
        account_id: accountId,
        service_name: serviceName.trim(),
        service_type: serviceType as CreateServiceInput['service_type'],
        status: status as CreateServiceInput['status'],
        amount: amount ? parseFloat(amount) : undefined,
        amount_currency: amountCurrency as 'USD' | 'EUR',
        total_steps: totalSteps ? parseInt(totalSteps) : undefined,
        notes: notes.trim() || undefined,
      })

      if (result.success) {
        toast.success('Service created')
        resetForm()
        onClose()
      } else {
        toast.error(result.error ?? 'Failed to create service')
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
            <h2 className="text-lg font-semibold">New Service</h2>
            <button onClick={handleClose} className="p-1 rounded hover:bg-zinc-100">
              <X className="h-5 w-5" />
            </button>
          </div>

          {/* Form */}
          <form onSubmit={handleSubmit} className="px-6 py-4 space-y-4">
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

            {/* Service Name */}
            <div>
              <label className="block text-sm font-medium mb-1">Service Name *</label>
              <input
                type="text"
                value={serviceName}
                onChange={e => setServiceName(e.target.value)}
                autoFocus
                placeholder="e.g. Company Formation - ABC LLC"
                className="w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              {errors.service_name && (
                <p className="text-xs text-red-600 mt-1">{errors.service_name}</p>
              )}
            </div>

            {/* Service Type + Status (side by side) */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium mb-1">Service Type</label>
                <select
                  value={serviceType}
                  onChange={e => setServiceType(e.target.value)}
                  className="w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  {SERVICE_TYPE.map(t => (
                    <option key={t} value={t}>{t}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Status</label>
                <select
                  value={status}
                  onChange={e => setStatus(e.target.value)}
                  className="w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  {SERVICE_STATUS.map(s => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
              </div>
            </div>

            {/* Amount + Currency (side by side) */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium mb-1">Amount</label>
                <input
                  type="number"
                  step="0.01"
                  min="0"
                  value={amount}
                  onChange={e => setAmount(e.target.value)}
                  placeholder="0.00"
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

            {/* Total Steps */}
            <div>
              <label className="block text-sm font-medium mb-1">Total Steps</label>
              <input
                type="number"
                min="1"
                value={totalSteps}
                onChange={e => setTotalSteps(e.target.value)}
                placeholder="Number of steps (optional)"
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
                placeholder="Additional notes..."
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
