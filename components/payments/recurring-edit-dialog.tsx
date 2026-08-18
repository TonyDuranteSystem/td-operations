'use client'

import { useState, useEffect, useTransition } from 'react'
import { X, Loader2, Plus, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import {
  getRecurringInvoiceTemplateForEdit,
  updateRecurringInvoiceTemplate,
  type RecurringTemplateEditRow,
} from '@/app/(dashboard)/payments/recurring-invoice-actions'
import { RECURRING_FREQUENCIES, type RecurringInvoiceFrequency, type UpdateRecurringInvoiceInput } from '@/lib/schemas/recurring-invoice'

const FREQUENCY_LABELS: Record<RecurringInvoiceFrequency, string> = {
  weekly: 'Weekly',
  biweekly: 'Every 2 weeks',
  monthly: 'Monthly',
  quarterly: 'Quarterly',
  yearly: 'Yearly',
}

interface ItemDraft {
  description: string
  quantity: number
  unit_price: number
}

export function RecurringEditDialog({
  templateId,
  onClose,
  onSaved,
}: {
  templateId: string
  onClose: () => void
  onSaved: (nextRunDateChanged: boolean) => void
}) {
  const [loading, setLoading] = useState(true)
  const [row, setRow] = useState<RecurringTemplateEditRow | null>(null)
  const [label, setLabel] = useState('')
  const [description, setDescription] = useState('')
  const [currency, setCurrency] = useState<'USD' | 'EUR'>('USD')
  const [frequency, setFrequency] = useState<RecurringInvoiceFrequency>('monthly')
  const [dueDateOffsetDays, setDueDateOffsetDays] = useState(0)
  const [paymentMethod, setPaymentMethod] = useState<'bank_transfer' | 'card' | 'both' | ''>('')
  const [bankPreference, setBankPreference] = useState('')
  const [message, setMessage] = useState('')
  const [notes, setNotes] = useState('')
  const [items, setItems] = useState<ItemDraft[]>([{ description: '', quantity: 1, unit_price: 0 }])
  const [error, setError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  useEffect(() => {
    getRecurringInvoiceTemplateForEdit(templateId)
      .then((r) => {
        setRow(r)
        setLabel(r.label)
        setDescription(r.description ?? '')
        setCurrency(r.currency)
        setFrequency(r.frequency)
        setDueDateOffsetDays(r.due_date_offset_days)
        setPaymentMethod((r.payment_method as 'bank_transfer' | 'card' | 'both' | null) ?? '')
        setBankPreference(r.bank_preference ?? '')
        setMessage(r.message ?? '')
        setNotes(r.notes ?? '')
        setItems(r.items.length ? r.items : [{ description: '', quantity: 1, unit_price: 0 }])
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Failed to load'))
      .finally(() => setLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [templateId])

  function updateItem(i: number, field: keyof ItemDraft, value: string) {
    setItems((prev) =>
      prev.map((it, idx) =>
        idx === i
          ? { ...it, [field]: field === 'description' ? value : Number(value) || 0 }
          : it,
      ),
    )
  }
  function addItem() {
    setItems((prev) => [...prev, { description: '', quantity: 1, unit_price: 0 }])
  }
  function removeItem(i: number) {
    setItems((prev) => (prev.length > 1 ? prev.filter((_, idx) => idx !== i) : prev))
  }

  function handleSave() {
    if (!row) return
    setError(null)
    const input: UpdateRecurringInvoiceInput = {
      label: label.trim(),
      description: description.trim(),
      amount_currency: currency,
      due_date_offset_days: dueDateOffsetDays,
      frequency,
      payment_method: paymentMethod || undefined,
      bank_preference: bankPreference.trim() || undefined,
      message: message.trim() || undefined,
      notes: notes.trim() || undefined,
      items: items.map((i) => ({ description: i.description, quantity: i.quantity, unit_price: i.unit_price })),
    }
    startTransition(async () => {
      const result = await updateRecurringInvoiceTemplate(row.id, row.updated_at, input)
      if (result.success) {
        toast.success(
          result.data?.next_run_date_changed
            ? 'Schedule updated — next bill date recalculated for the new frequency'
            : 'Schedule updated',
        )
        onSaved(!!result.data?.next_run_date_changed)
      } else {
        setError(result.error ?? 'Failed to save')
      }
    })
  }

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-lg shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between px-4 py-3 border-b sticky top-0 bg-white">
          <h2 className="font-semibold">Edit Recurring Invoice</h2>
          <button type="button" onClick={onClose} className="p-1 rounded hover:bg-zinc-100">
            <X className="h-4 w-4" />
          </button>
        </div>

        {loading ? (
          <div className="p-8 flex justify-center">
            <Loader2 className="h-5 w-5 animate-spin text-zinc-400" />
          </div>
        ) : !row ? (
          <div className="p-4 text-sm text-red-600">{error ?? 'Could not load this schedule.'}</div>
        ) : (
          <div className="p-4 space-y-4">
            {error && <p className="text-sm text-red-600">{error}</p>}

            <div>
              <label className="block text-sm font-medium mb-1">Internal name</label>
              <input
                type="text"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                className="w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Service description</label>
              <input
                type="text"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                className="w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium mb-1">Repeats</label>
                <select
                  value={frequency}
                  onChange={(e) => setFrequency(e.target.value as RecurringInvoiceFrequency)}
                  className="w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  {RECURRING_FREQUENCIES.map((f) => (
                    <option key={f} value={f}>{FREQUENCY_LABELS[f]}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Currency</label>
                <select
                  value={currency}
                  onChange={(e) => setCurrency(e.target.value as 'USD' | 'EUR')}
                  className="w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="USD">USD</option>
                  <option value="EUR">EUR</option>
                </select>
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium mb-1">Due, days after billing</label>
              <input
                type="number"
                min={0}
                value={dueDateOffsetDays}
                onChange={(e) => setDueDateOffsetDays(Math.max(0, Number(e.target.value) || 0))}
                className="w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>

            <div>
              <label className="block text-sm font-medium mb-2">Line Items</label>
              <div className="border rounded-md overflow-hidden">
                <div className="grid grid-cols-[1fr_60px_80px_32px] gap-2 px-3 py-2 bg-zinc-50 text-xs font-medium text-zinc-500">
                  <span>Description</span>
                  <span className="text-right">Qty</span>
                  <span className="text-right">Price</span>
                  <span />
                </div>
                {items.map((item, i) => (
                  <div key={i} className="grid grid-cols-[1fr_60px_80px_32px] gap-2 px-3 py-2 border-t items-center">
                    <input
                      type="text"
                      value={item.description}
                      onChange={(e) => updateItem(i, 'description', e.target.value)}
                      className="px-2 py-1 text-sm border rounded focus:outline-none focus:ring-1 focus:ring-blue-500"
                    />
                    <input
                      type="number"
                      step="0.01"
                      min="0"
                      value={item.quantity || ''}
                      onChange={(e) => updateItem(i, 'quantity', e.target.value)}
                      className="px-2 py-1 text-sm border rounded text-right focus:outline-none focus:ring-1 focus:ring-blue-500"
                    />
                    <input
                      type="number"
                      step="0.01"
                      value={item.unit_price || ''}
                      onChange={(e) => updateItem(i, 'unit_price', e.target.value)}
                      className="px-2 py-1 text-sm border rounded text-right focus:outline-none focus:ring-1 focus:ring-blue-500"
                    />
                    <button
                      type="button"
                      onClick={() => removeItem(i)}
                      disabled={items.length <= 1}
                      className="p-1 rounded hover:bg-red-50 text-zinc-400 hover:text-red-500 disabled:opacity-30"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  </div>
                ))}
                <div className="px-3 py-2 border-t">
                  <button type="button" onClick={addItem} className="text-sm text-blue-600 hover:text-blue-700 flex items-center gap-1">
                    <Plus className="h-3.5 w-3.5" /> Add line
                  </button>
                </div>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-sm font-medium mb-1">Payment method</label>
                <select
                  value={paymentMethod}
                  onChange={(e) => setPaymentMethod(e.target.value as 'bank_transfer' | 'card' | 'both' | '')}
                  className="w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="">Auto</option>
                  <option value="bank_transfer">Bank transfer</option>
                  <option value="card">Card</option>
                  <option value="both">Both</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Bank</label>
                <input
                  type="text"
                  value={bankPreference}
                  onChange={(e) => setBankPreference(e.target.value)}
                  placeholder="Auto"
                  className="w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
            </div>

            <div>
              <label className="block text-sm font-medium mb-1">Message on invoice</label>
              <textarea
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                rows={2}
                className="w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div>
              <label className="block text-sm font-medium mb-1">Internal notes</label>
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={2}
                className="w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>

            <div className="flex justify-end gap-2 pt-2 border-t">
              <button type="button" onClick={onClose} className="px-4 py-2 text-sm rounded-md border hover:bg-zinc-50">
                Cancel
              </button>
              <button
                type="button"
                onClick={handleSave}
                disabled={isPending || !label.trim() || !description.trim()}
                className="px-4 py-2 text-sm rounded-md bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 flex items-center gap-2"
              >
                {isPending && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                Save
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
