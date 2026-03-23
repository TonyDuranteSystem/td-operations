'use client'

import { useState, useTransition } from 'react'
import { X, Loader2, Save, CheckCircle2 } from 'lucide-react'
import { toast } from 'sonner'
import { PAYMENT_STATUS, PAYMENT_PERIOD } from '@/lib/constants'
import { updatePayment } from '@/app/(dashboard)/payments/actions'

interface PaymentItem {
  id: string
  account_id: string
  description: string | null
  amount: string | number
  amount_currency: string | null
  period: string | null
  year: number | null
  due_date: string | null
  paid_date: string | null
  status: string | null
  payment_method: string | null
  installment: string | null
  amount_paid: string | number | null
  amount_due: string | number | null
  followup_stage: string | null
  delay_approved_until: string | null
  company_name: string | null
  updated_at: string
  notes?: string | null
}

interface EditPaymentDialogProps {
  open: boolean
  onClose: () => void
  payment: PaymentItem
}

export function EditPaymentDialog({ open, onClose, payment }: EditPaymentDialogProps) {
  const [isPending, startTransition] = useTransition()
  const [description, setDescription] = useState(payment.description ?? '')
  const [amount, setAmount] = useState(String(payment.amount ?? ''))
  const [amountCurrency, setAmountCurrency] = useState(payment.amount_currency ?? 'USD')
  const [dueDate, setDueDate] = useState(payment.due_date ?? '')
  const [status, setStatus] = useState(payment.status ?? 'Pending')
  const [period, setPeriod] = useState(payment.period ?? '')
  const [year, setYear] = useState(payment.year != null ? String(payment.year) : '')
  const [paymentMethod, setPaymentMethod] = useState(payment.payment_method ?? '')
  const [paidDate, setPaidDate] = useState(payment.paid_date ?? '')
  const [notes, setNotes] = useState(payment.notes ?? '')
  const [followupStage, setFollowupStage] = useState(payment.followup_stage ?? '')
  const [delayApprovedUntil, setDelayApprovedUntil] = useState(payment.delay_approved_until ?? '')

  if (!open) return null

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()

    startTransition(async () => {
      const result = await updatePayment({
        id: payment.id,
        updated_at: payment.updated_at,
        description: description.trim() || undefined,
        amount: amount ? Number(amount) : undefined,
        amount_currency: (amountCurrency as 'USD' | 'EUR') || undefined,
        due_date: dueDate || undefined,
        status: (status as typeof PAYMENT_STATUS[number]) || undefined,
        period: (period as typeof PAYMENT_PERIOD[number]) || undefined,
        year: year ? Number(year) : undefined,
        payment_method: paymentMethod.trim() || undefined,
        paid_date: paidDate || undefined,
        notes: notes.trim() || undefined,
        followup_stage: followupStage || null,
        delay_approved_until: delayApprovedUntil || null,
      })

      if (result.success) {
        toast.success('Payment updated')
        onClose()
      } else {
        toast.error(result.error ?? 'Update failed')
      }
    })
  }

  const handleMarkPaid = () => {
    const today = new Date().toISOString().split('T')[0]
    setStatus('Paid')
    setPaidDate(today)
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
            <h2 className="text-lg font-semibold">Edit Payment</h2>
            <button onClick={onClose} className="p-1 rounded hover:bg-zinc-100">
              <X className="h-5 w-5" />
            </button>
          </div>

          {/* Form */}
          <form onSubmit={handleSubmit} className="px-6 py-4 space-y-4">
            {/* Company (read-only) */}
            {payment.company_name && (
              <div>
                <label className="block text-sm font-medium mb-1">Company</label>
                <p className="text-sm text-muted-foreground">{payment.company_name}</p>
              </div>
            )}

            {/* Description */}
            <div>
              <label className="block text-sm font-medium mb-1">Description</label>
              <input
                type="text"
                value={description}
                onChange={e => setDescription(e.target.value)}
                autoFocus
                className="w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>

            {/* Amount + Currency (side by side) */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium mb-1">Amount</label>
                <input
                  type="number"
                  step="0.01"
                  value={amount}
                  onChange={e => setAmount(e.target.value)}
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
                  <option value="USD">USD ($)</option>
                  <option value="EUR">EUR (&euro;)</option>
                </select>
              </div>
            </div>

            {/* Due Date + Status (side by side) */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium mb-1">Due Date</label>
                <input
                  type="date"
                  value={dueDate}
                  onChange={e => setDueDate(e.target.value)}
                  className="w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Status</label>
                <select
                  value={status}
                  onChange={e => setStatus(e.target.value)}
                  className="w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  {PAYMENT_STATUS.map(s => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
              </div>
            </div>

            {/* Period + Year (side by side) */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium mb-1">Period</label>
                <select
                  value={period}
                  onChange={e => setPeriod(e.target.value)}
                  className="w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="">None</option>
                  {PAYMENT_PERIOD.map(p => (
                    <option key={p} value={p}>{p}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Year</label>
                <input
                  type="number"
                  value={year}
                  onChange={e => setYear(e.target.value)}
                  placeholder="2026"
                  className="w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
            </div>

            {/* Payment Method */}
            <div>
              <label className="block text-sm font-medium mb-1">Payment Method</label>
              <input
                type="text"
                value={paymentMethod}
                onChange={e => setPaymentMethod(e.target.value)}
                placeholder="Wire, Wise, Stripe..."
                className="w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>

            {/* Paid Date (only when status = Paid) */}
            {status === 'Paid' && (
              <div>
                <label className="block text-sm font-medium mb-1">Paid Date</label>
                <input
                  type="date"
                  value={paidDate}
                  onChange={e => setPaidDate(e.target.value)}
                  className="w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
            )}

            {/* Follow-up + Delay Approved */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium mb-1">Follow-up Stage</label>
                <select
                  value={followupStage}
                  onChange={e => setFollowupStage(e.target.value)}
                  className="w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="">None</option>
                  <option value="Day 7">Day 7 — Reminder</option>
                  <option value="Day 14">Day 14 — 2nd Notice</option>
                  <option value="Day 21">Day 21 — Final Warning</option>
                  <option value="Day 30">Day 30 — Service Suspension</option>
                  <option value="Day 45">Day 45 — Delinquent</option>
                  <option value="Day 60">Day 60 — Collections</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Delay Approved Until</label>
                <input
                  type="date"
                  value={delayApprovedUntil}
                  onChange={e => setDelayApprovedUntil(e.target.value)}
                  className="w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
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
            <div className="flex items-center justify-between pt-2">
              <div>
                {status !== 'Paid' && (
                  <button
                    type="button"
                    onClick={handleMarkPaid}
                    className="inline-flex items-center gap-1.5 px-3 py-2 text-sm bg-emerald-100 text-emerald-700 rounded-md hover:bg-emerald-200 transition-colors"
                  >
                    <CheckCircle2 className="h-4 w-4" />
                    Mark as Paid
                  </button>
                )}
              </div>
              <div className="flex gap-2">
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
            </div>
          </form>
        </div>
      </div>
    </>
  )
}
