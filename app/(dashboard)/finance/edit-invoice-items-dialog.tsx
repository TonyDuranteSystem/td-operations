'use client'

import { useState, useEffect, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { X, Plus, Trash2, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { updateInvoiceItems, getInvoiceWithItems } from '@/app/(dashboard)/shared/invoice-actions'
import type { InvoiceRecord } from './all-invoices-tab'

interface EditableItem {
  description: string
  quantity: number
  unit_price: number
}

const emptyItem = (): EditableItem => ({ description: '', quantity: 1, unit_price: 0 })

/**
 * The Draft-only line-item editor (dev job ef5da377) — a new, focused dialog
 * rather than the old Payment Tracker page's version rebuilt in place. That
 * version also let you edit description/currency/dates/message, all of
 * which already have a home in Finance's existing "Edit" dialog (total-only,
 * every status) — duplicating those fields here would give two different
 * dialogs two different ways to change the same thing. This one does only
 * what nothing else in Finance can: the line items themselves and the
 * discount that depends on them.
 *
 * Fetches fresh on open rather than trusting the board row: the board's flat
 * invoice list doesn't carry line items or updated_at, and even if it did,
 * both can go stale between the list loading and this dialog opening — the
 * save itself is guarded against that (updateInvoiceItems's compare-and-swap
 * lock), but starting from a fresh read means the common case never hits it.
 */
export function EditInvoiceItemsDialog({ invoice, onClose }: { invoice: InvoiceRecord; onClose: () => void }) {
  const [isPending, startTransition] = useTransition()
  const router = useRouter()
  const [loading, setLoading] = useState(true)
  const [updatedAt, setUpdatedAt] = useState<string | null>(null)
  const [items, setItems] = useState<EditableItem[]>([emptyItem()])
  const [discount, setDiscount] = useState('0')

  useEffect(() => {
    let cancelled = false
    getInvoiceWithItems(invoice.id).then(data => {
      if (cancelled) return
      const payment = data.payment as Record<string, unknown> | null
      setUpdatedAt((payment?.updated_at as string) ?? null)
      setDiscount(String(payment?.discount ?? 0))
      setItems(
        data.items.length > 0
          ? data.items.map((i: Record<string, unknown>) => ({
              description: (i.description as string) ?? '',
              quantity: Number(i.quantity) || 1,
              unit_price: Number(i.unit_price) || 0,
            }))
          : [emptyItem()],
      )
      setLoading(false)
    }).catch(() => {
      toast.error('Failed to load this invoice\'s line items.')
      onClose()
    })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- runs once per mount (dialog is remounted via `key` semantics by its parent opening/closing it), same pattern as the old page's own detail dialog
  }, [invoice.id])

  const currencySymbol = invoice.currency === 'EUR' ? '€' : '$'
  const subtotal = items.reduce((sum, i) => sum + i.quantity * i.unit_price, 0)
  const discountNum = Number(discount) || 0
  const total = Math.max(0, subtotal - discountNum)

  const updateItem = (index: number, field: 'description' | 'quantity' | 'unit_price', value: string) => {
    setItems(prev => {
      const next = [...prev]
      const item = { ...next[index] }
      if (field === 'description') item.description = value
      else if (field === 'quantity') item.quantity = Number(value) || 0
      else item.unit_price = Number(value) || 0
      next[index] = item
      return next
    })
  }

  const removeItem = (index: number) => {
    if (items.length <= 1) return
    setItems(prev => prev.filter((_, i) => i !== index))
  }

  const handleSave = () => {
    if (!updatedAt) return
    if (items.some(i => !i.description.trim())) {
      toast.error('Every line needs a description.')
      return
    }
    startTransition(async () => {
      const result = await updateInvoiceItems(invoice.id, updatedAt, {
        discount: discountNum,
        items: items.map((item, i) => ({ ...item, sort_order: i })),
      })
      if (result.success) {
        toast.success(`${invoice.invoice_number} updated`)
        router.refresh()
        onClose()
      } else {
        toast.error(result.error ?? 'Failed to update')
      }
    })
  }

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50 p-4" onClick={onClose}>
      <div
        className="bg-white rounded-xl shadow-xl w-full max-w-2xl max-h-[90vh] overflow-y-auto p-6 space-y-4"
        onClick={e => e.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h3 className="font-semibold text-lg">Edit Items — {invoice.invoice_number}</h3>
          <button onClick={onClose} className="text-zinc-400 hover:text-zinc-600">
            <X className="w-5 h-5" />
          </button>
        </div>

        {loading ? (
          <div className="py-12 flex justify-center">
            <Loader2 className="w-5 h-5 animate-spin text-zinc-400" />
          </div>
        ) : (
          <>
            <div>
              <label className="block text-sm font-medium mb-2">Line Items</label>
              <div className="border rounded-md overflow-x-auto">
                <div className="min-w-[420px]">
                  <div className="grid grid-cols-[1fr_70px_100px_100px_32px] gap-2 px-3 py-2 bg-zinc-50 text-xs font-medium text-zinc-500">
                    <span>Description</span><span className="text-right">Qty</span><span className="text-right">Price</span><span className="text-right">Amount</span><span />
                  </div>
                  {items.map((item, i) => (
                    <div key={i} className="grid grid-cols-[1fr_70px_100px_100px_32px] gap-2 px-3 py-2 border-t items-center">
                      <input
                        type="text"
                        value={item.description}
                        onChange={e => updateItem(i, 'description', e.target.value)}
                        placeholder="Description"
                        className="px-2 py-1 text-sm border rounded focus:outline-none focus:ring-1 focus:ring-blue-500"
                      />
                      <input
                        type="number"
                        step="0.01"
                        value={item.quantity || ''}
                        onChange={e => updateItem(i, 'quantity', e.target.value)}
                        className="px-2 py-1 text-sm border rounded text-right focus:outline-none focus:ring-1 focus:ring-blue-500"
                      />
                      <input
                        type="number"
                        step="0.01"
                        value={item.unit_price || ''}
                        onChange={e => updateItem(i, 'unit_price', e.target.value)}
                        className="px-2 py-1 text-sm border rounded text-right focus:outline-none focus:ring-1 focus:ring-blue-500"
                      />
                      <span className="text-sm text-right font-medium">
                        {currencySymbol}{(item.quantity * item.unit_price).toFixed(2)}
                      </span>
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
                    <button
                      type="button"
                      onClick={() => setItems(prev => [...prev, emptyItem()])}
                      className="text-sm text-blue-600 hover:text-blue-700 flex items-center gap-1"
                    >
                      <Plus className="h-3.5 w-3.5" /> Add line
                    </button>
                  </div>
                </div>
              </div>
            </div>

            <div className="flex justify-end">
              <div className="w-56 space-y-1 text-sm">
                <div className="flex justify-between"><span className="text-zinc-500">Subtotal</span><span>{currencySymbol}{subtotal.toFixed(2)}</span></div>
                <div className="flex justify-between items-center">
                  <span className="text-zinc-500">Discount</span>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={discount}
                    onChange={e => setDiscount(e.target.value)}
                    placeholder="0.00"
                    className="w-24 px-2 py-1 text-sm border rounded text-right focus:outline-none focus:ring-1 focus:ring-blue-500"
                  />
                </div>
                <div className="flex justify-between font-semibold border-t pt-1"><span>Total</span><span>{currencySymbol}{total.toFixed(2)}</span></div>
              </div>
            </div>

            <div className="flex justify-end gap-2 pt-2">
              <button onClick={onClose} className="px-4 py-2 text-sm rounded-lg border hover:bg-zinc-50">
                Cancel
              </button>
              <button
                onClick={handleSave}
                disabled={isPending}
                className="px-4 py-2 text-sm rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 flex items-center gap-2"
              >
                {isPending && <Loader2 className="w-3 h-3 animate-spin" />}
                Save Items
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
