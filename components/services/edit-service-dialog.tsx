'use client'

import { useState, useTransition } from 'react'
import { X, Loader2, ChevronRight, CheckCircle2 } from 'lucide-react'
import { toast } from 'sonner'
import { SERVICE_TYPE, SERVICE_STATUS } from '@/lib/constants'
import { updateService, advanceServiceStep, completeService } from '@/app/(dashboard)/services/actions'

interface ServiceItem {
  id: string
  service_name: string
  service_type: string
  account_id: string
  status: string
  current_step: number | null
  total_steps: number | null
  amount: number | null
  amount_currency: string | null
  sla_due_date: string | null
  blocked_waiting_external: boolean
  blocked_reason: string | null
  notes: string | null
  company_name: string
  updated_at: string
}

interface EditServiceDialogProps {
  open: boolean
  onClose: () => void
  service: ServiceItem
}

export function EditServiceDialog({ open, onClose, service }: EditServiceDialogProps) {
  const [isPending, startTransition] = useTransition()
  const [serviceName, setServiceName] = useState(service.service_name)
  const [serviceType, setServiceType] = useState(service.service_type)
  const [status, setStatus] = useState(service.status)
  const [currentStep, setCurrentStep] = useState<string>(service.current_step?.toString() ?? '')
  const [totalSteps, setTotalSteps] = useState<string>(service.total_steps?.toString() ?? '')
  const [amount, setAmount] = useState<string>(service.amount?.toString() ?? '')
  const [amountCurrency, setAmountCurrency] = useState(service.amount_currency ?? 'USD')
  const [blocked, setBlocked] = useState(service.blocked_waiting_external ?? false)
  const [blockedReason, setBlockedReason] = useState(service.blocked_reason ?? '')
  const [slaDueDate, setSlaDueDate] = useState(service.sla_due_date ?? '')
  const [notes, setNotes] = useState(service.notes ?? '')

  if (!open) return null

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()

    if (!serviceName.trim()) {
      toast.error('Service name is required')
      return
    }

    startTransition(async () => {
      const result = await updateService({
        id: service.id,
        updated_at: service.updated_at,
        service_name: serviceName.trim(),
        service_type: serviceType as typeof SERVICE_TYPE[number],
        status: status as typeof SERVICE_STATUS[number],
        current_step: currentStep ? parseInt(currentStep) : undefined,
        total_steps: totalSteps ? parseInt(totalSteps) : undefined,
        amount: amount ? parseFloat(amount) : undefined,
        amount_currency: amountCurrency as 'USD' | 'EUR',
        blocked_waiting_external: blocked,
        blocked_reason: blocked ? blockedReason || undefined : undefined,
        sla_due_date: slaDueDate || undefined,
        notes: notes.trim() || undefined,
      })

      if (result.success) {
        toast.success('Service updated')
        onClose()
      } else {
        toast.error(result.error ?? 'Failed to update service')
      }
    })
  }

  const handleAdvanceStep = () => {
    startTransition(async () => {
      const result = await advanceServiceStep(service.id, service.updated_at)
      if (result.success) {
        toast.success('Step advanced')
        onClose()
      } else {
        toast.error(result.error ?? 'Failed to advance step')
      }
    })
  }

  const handleComplete = () => {
    startTransition(async () => {
      const result = await completeService(service.id, service.updated_at)
      if (result.success) {
        toast.success('Service completed')
        onClose()
      } else {
        toast.error(result.error ?? 'Failed to complete service')
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
            <div>
              <h2 className="text-lg font-semibold">Edit Service</h2>
              <p className="text-xs text-muted-foreground">{service.company_name}</p>
            </div>
            <button onClick={onClose} className="p-1 rounded hover:bg-zinc-100">
              <X className="h-5 w-5" />
            </button>
          </div>

          {/* Quick Actions */}
          <div className="px-6 pt-4 flex gap-2">
            {service.current_step != null && service.total_steps != null && service.current_step < service.total_steps && (
              <button
                type="button"
                disabled={isPending}
                onClick={handleAdvanceStep}
                className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium rounded-md bg-blue-100 text-blue-700 hover:bg-blue-200 disabled:opacity-50"
              >
                {isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <ChevronRight className="h-3 w-3" />}
                Advance Step ({(service.current_step ?? 0) + 1}/{service.total_steps})
              </button>
            )}
            {service.status !== 'Completed' && (
              <button
                type="button"
                disabled={isPending}
                onClick={handleComplete}
                className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium rounded-md bg-emerald-100 text-emerald-700 hover:bg-emerald-200 disabled:opacity-50"
              >
                {isPending ? <Loader2 className="h-3 w-3 animate-spin" /> : <CheckCircle2 className="h-3 w-3" />}
                Mark Complete
              </button>
            )}
          </div>

          {/* Form */}
          <form onSubmit={handleSubmit} className="px-6 py-4 space-y-4">
            {/* Service Name */}
            <div>
              <label className="block text-sm font-medium mb-1">Service Name *</label>
              <input
                type="text"
                value={serviceName}
                onChange={e => setServiceName(e.target.value)}
                className="w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
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

            {/* Current Step + Total Steps (side by side) */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium mb-1">Current Step</label>
                <input
                  type="number"
                  min="0"
                  value={currentStep}
                  onChange={e => setCurrentStep(e.target.value)}
                  placeholder="0"
                  className="w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Total Steps</label>
                <input
                  type="number"
                  min="1"
                  value={totalSteps}
                  onChange={e => setTotalSteps(e.target.value)}
                  placeholder="e.g. 5"
                  className="w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
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

            {/* Blocked */}
            <div>
              <label className="flex items-center gap-2 text-sm font-medium cursor-pointer">
                <input
                  type="checkbox"
                  checked={blocked}
                  onChange={e => setBlocked(e.target.checked)}
                  className="rounded border-zinc-300"
                />
                Blocked (waiting external)
              </label>
              {blocked && (
                <input
                  type="text"
                  value={blockedReason}
                  onChange={e => setBlockedReason(e.target.value)}
                  placeholder="Reason for block..."
                  className="w-full mt-2 px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              )}
            </div>

            {/* SLA Due Date */}
            <div>
              <label className="block text-sm font-medium mb-1">SLA Due Date</label>
              <input
                type="date"
                value={slaDueDate}
                onChange={e => setSlaDueDate(e.target.value)}
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
                {isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                Save Changes
              </button>
            </div>
          </form>
        </div>
      </div>
    </>
  )
}
