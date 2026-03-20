'use client'

import { useState, useTransition } from 'react'
import { X, Loader2, Plus } from 'lucide-react'
import { toast } from 'sonner'
import { PAYMENT_STATUS, PAYMENT_PERIOD } from '@/lib/constants'
import { AccountCombobox } from '@/components/shared/account-combobox'
import { createPayment } from '@/app/(dashboard)/payments/actions'
import type { CreatePaymentInput } from '@/lib/schemas/payment'

interface CreatePaymentDialogProps {
  open: boolean
  onClose: () => void
}

export function CreatePaymentDialog({ open, onClose }: CreatePaymentDialogProps) {
  const [isPending, startTransition] = useTransition()
  const [accountId, setAccountId] = useState<string | undefined>()
  const [accountName, setAccountName] = useState<string | undefined>()
  const [description, setDescription] = useState('')
  const [amount, setAmount] = useState('')
  const [amountCurrency, setAmountCurrency] = useState('USD')
  const [dueDate, setDueDate] = useState('')
  const [status, setStatus] = useState('Pending')
  const [period, setPeriod] = useState('')
  const [year, setYear] = useState('')
  const [paymentMethod, setPaymentMethod] = useState('')
  const [notes, setNotes] = useState('')
  const [errors, setErrors] = useState<Record<string, string>>({})

  if (!open) return null

  const resetForm = () => {
    setAccountId(undefined)
    setAccountName(undefined)
    setDescription('')
    setAmount('')
    setAmountCurrency('USD')
    setDueDate('')
    setStatus('Pending')
    setPeriod('')
    setYear('')
    setPaymentMethod('')
    setNotes('')
    setErrors({})
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    setErrors({})

    const newErrors: Record<string, string> = {}
    if (!accountId) newErrors.account_id = 'Account obbligatorio'
    if (!description.trim()) newErrors.description = 'Descrizione obbligatoria'
    if (!amount || Number(amount) <= 0) newErrors.amount = 'Importo non valido'

    if (Object.keys(newErrors).length > 0) {
      setErrors(newErrors)
      return
    }

    startTransition(async () => {
      const input: CreatePaymentInput = {
        account_id: accountId!,
        description: description.trim(),
        amount: Number(amount),
        amount_currency: amountCurrency as 'USD' | 'EUR',
        due_date: dueDate || undefined,
        status: status as typeof PAYMENT_STATUS[number],
        period: (period || undefined) as CreatePaymentInput['period'],
        year: year ? Number(year) : undefined,
        payment_method: paymentMethod.trim() || undefined,
        notes: notes.trim() || undefined,
      }

      const result = await createPayment(input)

      if (result.success) {
        toast.success('Pagamento creato')
        resetForm()
        onClose()
      } else {
        toast.error(result.error ?? 'Errore nella creazione')
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
            <h2 className="text-lg font-semibold">Nuovo Pagamento</h2>
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

            {/* Description */}
            <div>
              <label className="block text-sm font-medium mb-1">Descrizione *</label>
              <input
                type="text"
                value={description}
                onChange={e => setDescription(e.target.value)}
                autoFocus
                placeholder="Es: RA Agent Fee 2026"
                className="w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              {errors.description && (
                <p className="text-xs text-red-600 mt-1">{errors.description}</p>
              )}
            </div>

            {/* Amount + Currency (side by side) */}
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium mb-1">Importo *</label>
                <input
                  type="number"
                  step="0.01"
                  value={amount}
                  onChange={e => setAmount(e.target.value)}
                  placeholder="0.00"
                  className="w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                {errors.amount && (
                  <p className="text-xs text-red-600 mt-1">{errors.amount}</p>
                )}
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Valuta</label>
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
                <label className="block text-sm font-medium mb-1">Scadenza</label>
                <input
                  type="date"
                  value={dueDate}
                  onChange={e => setDueDate(e.target.value)}
                  className="w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Stato</label>
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
                <label className="block text-sm font-medium mb-1">Periodo</label>
                <select
                  value={period}
                  onChange={e => setPeriod(e.target.value)}
                  className="w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="">Nessuno</option>
                  {PAYMENT_PERIOD.map(p => (
                    <option key={p} value={p}>{p}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Anno</label>
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
              <label className="block text-sm font-medium mb-1">Metodo di pagamento</label>
              <input
                type="text"
                value={paymentMethod}
                onChange={e => setPaymentMethod(e.target.value)}
                placeholder="Wire, Wise, Stripe..."
                className="w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>

            {/* Notes */}
            <div>
              <label className="block text-sm font-medium mb-1">Note</label>
              <textarea
                value={notes}
                onChange={e => setNotes(e.target.value)}
                rows={3}
                placeholder="Note aggiuntive..."
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
                Annulla
              </button>
              <button
                type="submit"
                disabled={isPending}
                className="px-4 py-2 text-sm bg-zinc-900 text-white rounded-md hover:bg-zinc-800 disabled:opacity-50 flex items-center gap-2"
              >
                {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                Crea
              </button>
            </div>
          </form>
        </div>
      </div>
    </>
  )
}
