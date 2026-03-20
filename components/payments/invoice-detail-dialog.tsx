'use client'

import { useState, useEffect, useTransition } from 'react'
import { X, Loader2, FileText, Send, Bell, Download, Trash2, CheckCircle2, Ban, Plus } from 'lucide-react'
import { cn } from '@/lib/utils'
import { toast } from 'sonner'
import { format, parseISO } from 'date-fns'
import {
  updateInvoice,
  deleteInvoice,
  markInvoicePaid,
  voidInvoice,
  getInvoiceWithItems,
} from '@/app/(dashboard)/payments/invoice-actions'
import type { InvoiceItem } from '@/lib/schemas/invoice'

interface InvoiceDetailDialogProps {
  open: boolean
  onClose: () => void
  paymentId: string
  invoiceNumber: string | null
  invoiceStatus: string | null
  updatedAt: string
}

const STATUS_STYLES: Record<string, { bg: string; text: string }> = {
  Draft: { bg: 'bg-zinc-100', text: 'text-zinc-600' },
  Sent: { bg: 'bg-blue-100', text: 'text-blue-700' },
  Paid: { bg: 'bg-emerald-100', text: 'text-emerald-700' },
  Overdue: { bg: 'bg-red-100', text: 'text-red-700' },
  Voided: { bg: 'bg-zinc-200', text: 'text-zinc-500' },
  Credit: { bg: 'bg-purple-100', text: 'text-purple-700' },
}

function formatDate(d: string | null): string {
  if (!d) return '\u2014'
  try { return format(parseISO(d), 'MMM d, yyyy') } catch { return d }
}

function formatCurrency(amount: number | string | null, currency?: string | null): string {
  if (amount == null) return '\u2014'
  const num = typeof amount === 'string' ? parseFloat(amount) : amount
  if (isNaN(num)) return '\u2014'
  const c = currency === 'EUR' ? '\u20AC' : '$'
  return `${c}${Math.abs(num).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

const emptyItem = (): InvoiceItem => ({
  description: '',
  quantity: 1,
  unit_price: 0,
  amount: 0,
  sort_order: 0,
})

export function InvoiceDetailDialog({ open, onClose, paymentId, invoiceNumber, invoiceStatus, updatedAt }: InvoiceDetailDialogProps) {
  const [isPending, startTransition] = useTransition()
  const [loading, setLoading] = useState(true)
  const [payment, setPayment] = useState<Record<string, unknown> | null>(null)
  const [items, setItems] = useState<InvoiceItem[]>([])
  const [editing, setEditing] = useState(false)
  const [confirmAction, setConfirmAction] = useState<'delete' | 'void' | null>(null)

  // Edit state
  const [editDescription, setEditDescription] = useState('')
  const [editCurrency, setEditCurrency] = useState<'USD' | 'EUR'>('USD')
  const [editIssueDate, setEditIssueDate] = useState('')
  const [editDueDate, setEditDueDate] = useState('')
  const [editDiscount, setEditDiscount] = useState('')
  const [editMessage, setEditMessage] = useState('')
  const [editItems, setEditItems] = useState<InvoiceItem[]>([])

  useEffect(() => {
    if (!open) return
    setLoading(true)
    setEditing(false)
    setConfirmAction(null)
    getInvoiceWithItems(paymentId).then(data => {
      setPayment(data.payment)
      setItems(data.items.map((i: Record<string, unknown>) => ({
        description: (i.description as string) ?? '',
        quantity: Number(i.quantity) || 1,
        unit_price: Number(i.unit_price) || 0,
        amount: Number(i.amount) || 0,
        sort_order: Number(i.sort_order) || 0,
      })))
      setLoading(false)
    }).catch(() => {
      toast.error('Failed to load invoice')
      setLoading(false)
    })
  }, [open, paymentId])

  if (!open) return null

  const status = (payment?.invoice_status as string) ?? invoiceStatus ?? 'Draft'
  const style = STATUS_STYLES[status] ?? STATUS_STYLES.Draft
  const isDraft = status === 'Draft'
  const isSent = status === 'Sent'
  const isOverdue = status === 'Overdue'
  const isPaid = status === 'Paid'
  const isVoided = status === 'Voided'
  const isCredit = status === 'Credit'
  const canEdit = isDraft
  const canDelete = isDraft
  const canSend = isDraft || isOverdue
  const canRemind = isSent || isOverdue
  const canMarkPaid = isSent || isOverdue
  const canVoid = isDraft || isSent || isOverdue

  const startEdit = () => {
    if (!payment) return
    setEditDescription((payment.description as string) ?? '')
    setEditCurrency(((payment.amount_currency as string) ?? 'USD') as 'USD' | 'EUR')
    setEditIssueDate((payment.issue_date as string) ?? '')
    setEditDueDate((payment.due_date as string) ?? '')
    setEditDiscount(String(payment.discount ?? '0'))
    setEditMessage((payment.message as string) ?? '')
    setEditItems(items.length > 0 ? items.map(i => ({ ...i })) : [emptyItem()])
    setEditing(true)
  }

  const updateEditItem = (index: number, field: keyof InvoiceItem, value: string | number) => {
    setEditItems(prev => {
      const updated = [...prev]
      const item = { ...updated[index] }
      if (field === 'description') {
        item.description = value as string
      } else if (field === 'quantity') {
        item.quantity = Number(value) || 0
        item.amount = item.quantity * item.unit_price
      } else if (field === 'unit_price') {
        item.unit_price = Number(value) || 0
        item.amount = item.quantity * item.unit_price
      }
      updated[index] = item
      return updated
    })
  }

  const editSubtotal = editItems.reduce((sum, i) => sum + i.amount, 0)
  const editDiscountNum = Number(editDiscount) || 0
  const editTotal = editSubtotal - editDiscountNum
  const currencySymbol = editCurrency === 'EUR' ? '\u20AC' : '$'

  const handleSaveEdit = () => {
    startTransition(async () => {
      try {
        const result = await updateInvoice(paymentId, updatedAt, {
          description: editDescription,
          amount_currency: editCurrency,
          issue_date: editIssueDate,
          due_date: editDueDate || undefined,
          discount: editDiscountNum,
          message: editMessage || undefined,
          items: editItems.map((item, i) => ({ ...item, sort_order: i })),
        })
        if (result.success) {
          toast.success('Invoice updated')
          setEditing(false)
          onClose()
        } else {
          toast.error(result.error ?? 'Failed to update')
        }
      } catch {
        toast.error('Failed to update invoice')
      }
    })
  }

  const handleDelete = () => {
    startTransition(async () => {
      try {
        const result = await deleteInvoice(paymentId)
        if (result.success) {
          toast.success('Invoice deleted')
          onClose()
        } else {
          toast.error(result.error ?? 'Failed to delete')
        }
      } catch {
        toast.error('Failed to delete invoice')
      }
    })
  }

  const handleVoid = () => {
    startTransition(async () => {
      try {
        const result = await voidInvoice(paymentId, updatedAt)
        if (result.success) {
          toast.success('Invoice voided')
          onClose()
        } else {
          toast.error(result.error ?? 'Failed to void')
        }
      } catch {
        toast.error('Failed to void invoice')
      }
    })
  }

  const handleMarkPaid = () => {
    startTransition(async () => {
      try {
        const result = await markInvoicePaid(paymentId, updatedAt)
        if (result.success) {
          toast.success('Invoice marked as paid')
          onClose()
        } else {
          toast.error(result.error ?? 'Failed to mark paid')
        }
      } catch {
        toast.error('Failed to mark invoice as paid')
      }
    })
  }

  const handleSend = () => {
    startTransition(async () => {
      try {
        const res = await fetch(`/api/invoices/${paymentId}/send`, { method: 'POST' })
        const data = await res.json()
        if (!res.ok) throw new Error(data.error ?? 'Send failed')
        toast.success(`Invoice ${invoiceNumber} sent`)
        onClose()
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Failed to send')
      }
    })
  }

  const handleRemind = () => {
    startTransition(async () => {
      try {
        const res = await fetch(`/api/invoices/${paymentId}/remind`, { method: 'POST' })
        const data = await res.json()
        if (!res.ok) throw new Error(data.error ?? 'Remind failed')
        toast.success(`Reminder sent for ${invoiceNumber}`)
        onClose()
      } catch (err) {
        toast.error(err instanceof Error ? err.message : 'Failed to send reminder')
      }
    })
  }

  const handleDownload = () => {
    window.open(`/api/invoices/${paymentId}/pdf`, '_blank')
  }

  return (
    <>
      <div className="fixed inset-0 z-50 bg-black/50" onClick={onClose} />
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div
          className="bg-white rounded-lg shadow-xl w-full max-w-2xl max-h-[90vh] overflow-y-auto"
          onClick={e => e.stopPropagation()}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-6 py-4 border-b">
            <div className="flex items-center gap-3">
              <FileText className="h-5 w-5 text-zinc-500" />
              <div>
                <h2 className="text-lg font-semibold font-mono">{invoiceNumber ?? 'Invoice'}</h2>
                <span className={cn('text-xs font-medium px-2 py-0.5 rounded', style.bg, style.text)}>
                  {status}
                </span>
              </div>
            </div>
            <button onClick={onClose} className="p-1 rounded hover:bg-zinc-100">
              <X className="h-5 w-5" />
            </button>
          </div>

          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="h-6 w-6 animate-spin text-zinc-400" />
            </div>
          ) : editing ? (
            /* ── Edit Mode ── */
            <div className="px-6 py-4 space-y-4">
              <div>
                <label className="block text-sm font-medium mb-1">Description</label>
                <input type="text" value={editDescription} onChange={e => setEditDescription(e.target.value)}
                  className="w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500" />
              </div>

              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="block text-sm font-medium mb-1">Currency</label>
                  <select value={editCurrency} onChange={e => setEditCurrency(e.target.value as 'USD' | 'EUR')}
                    className="w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500">
                    <option value="USD">USD ($)</option>
                    <option value="EUR">EUR (\u20AC)</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">Issue Date</label>
                  <input type="date" value={editIssueDate} onChange={e => setEditIssueDate(e.target.value)}
                    className="w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500" />
                </div>
                <div>
                  <label className="block text-sm font-medium mb-1">Due Date</label>
                  <input type="date" value={editDueDate} onChange={e => setEditDueDate(e.target.value)}
                    className="w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500" />
                </div>
              </div>

              {/* Line Items */}
              <div>
                <label className="block text-sm font-medium mb-2">Line Items</label>
                <div className="border rounded-md overflow-hidden">
                  <div className="grid grid-cols-[1fr_70px_100px_100px_32px] gap-2 px-3 py-2 bg-zinc-50 text-xs font-medium text-zinc-500">
                    <span>Description</span><span className="text-right">Qty</span><span className="text-right">Price</span><span className="text-right">Amount</span><span />
                  </div>
                  {editItems.map((item, i) => (
                    <div key={i} className="grid grid-cols-[1fr_70px_100px_100px_32px] gap-2 px-3 py-2 border-t items-center">
                      <input type="text" value={item.description} onChange={e => updateEditItem(i, 'description', e.target.value)}
                        className="px-2 py-1 text-sm border rounded focus:outline-none focus:ring-1 focus:ring-blue-500" />
                      <input type="number" step="0.01" value={item.quantity || ''} onChange={e => updateEditItem(i, 'quantity', e.target.value)}
                        className="px-2 py-1 text-sm border rounded text-right focus:outline-none focus:ring-1 focus:ring-blue-500" />
                      <input type="number" step="0.01" value={item.unit_price || ''} onChange={e => updateEditItem(i, 'unit_price', e.target.value)}
                        className="px-2 py-1 text-sm border rounded text-right focus:outline-none focus:ring-1 focus:ring-blue-500" />
                      <span className="text-sm text-right font-medium">{currencySymbol}{item.amount.toFixed(2)}</span>
                      <button type="button" onClick={() => { if (editItems.length > 1) setEditItems(prev => prev.filter((_, idx) => idx !== i)) }}
                        disabled={editItems.length <= 1} className="p-1 rounded hover:bg-red-50 text-zinc-400 hover:text-red-500 disabled:opacity-30">
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  ))}
                  <div className="px-3 py-2 border-t">
                    <button type="button" onClick={() => setEditItems(prev => [...prev, { ...emptyItem(), sort_order: prev.length }])}
                      className="text-sm text-blue-600 hover:text-blue-700 flex items-center gap-1">
                      <Plus className="h-3.5 w-3.5" /> Add line
                    </button>
                  </div>
                </div>
              </div>

              {/* Totals */}
              <div className="flex justify-end">
                <div className="w-56 space-y-1 text-sm">
                  <div className="flex justify-between"><span className="text-zinc-500">Subtotal</span><span>{currencySymbol}{editSubtotal.toFixed(2)}</span></div>
                  <div className="flex justify-between items-center">
                    <span className="text-zinc-500">Discount</span>
                    <input type="number" step="0.01" min="0" value={editDiscount} onChange={e => setEditDiscount(e.target.value)}
                      placeholder="0.00" className="w-24 px-2 py-1 text-sm border rounded text-right focus:outline-none focus:ring-1 focus:ring-blue-500" />
                  </div>
                  <div className="flex justify-between font-semibold border-t pt-1"><span>Total</span><span>{currencySymbol}{editTotal.toFixed(2)}</span></div>
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium mb-1">Payment Terms / Message</label>
                <textarea value={editMessage} onChange={e => setEditMessage(e.target.value)} rows={2}
                  className="w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none" />
              </div>

              <div className="flex justify-end gap-2 pt-2">
                <button onClick={() => setEditing(false)} className="px-4 py-2 text-sm border rounded-md hover:bg-zinc-50">Cancel</button>
                <button onClick={handleSaveEdit} disabled={isPending}
                  className="px-4 py-2 text-sm text-white bg-zinc-900 hover:bg-zinc-800 rounded-md disabled:opacity-50 flex items-center gap-2">
                  {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                  Save Changes
                </button>
              </div>
            </div>
          ) : (
            /* ── View Mode ── */
            <div className="px-6 py-4 space-y-4">
              {/* Info grid */}
              <div className="grid grid-cols-2 gap-x-8 gap-y-2 text-sm">
                <div>
                  <span className="text-zinc-400 text-xs uppercase">Account</span>
                  <p className="font-medium">{(payment?.accounts as Record<string, unknown>)?.company_name as string ?? '\u2014'}</p>
                </div>
                <div>
                  <span className="text-zinc-400 text-xs uppercase">Description</span>
                  <p className="font-medium">{(payment?.description as string) ?? '\u2014'}</p>
                </div>
                <div>
                  <span className="text-zinc-400 text-xs uppercase">Issue Date</span>
                  <p>{formatDate(payment?.issue_date as string)}</p>
                </div>
                <div>
                  <span className="text-zinc-400 text-xs uppercase">Due Date</span>
                  <p>{formatDate(payment?.due_date as string)}</p>
                </div>
                <div>
                  <span className="text-zinc-400 text-xs uppercase">Amount</span>
                  <p className="text-lg font-semibold">{formatCurrency(payment?.total as number, payment?.amount_currency as string)}</p>
                </div>
                <div>
                  <span className="text-zinc-400 text-xs uppercase">Currency</span>
                  <p>{(payment?.amount_currency as string) ?? 'USD'}</p>
                </div>
                {payment?.sent_at && (
                  <div>
                    <span className="text-zinc-400 text-xs uppercase">Sent</span>
                    <p>{formatDate(payment.sent_at as string)}</p>
                  </div>
                )}
                {payment?.paid_date && (
                  <div>
                    <span className="text-zinc-400 text-xs uppercase">Paid</span>
                    <p className="text-emerald-600 font-medium">{formatDate(payment.paid_date as string)}</p>
                  </div>
                )}
              </div>

              {/* Line items */}
              {items.length > 0 && (
                <div>
                  <span className="text-zinc-400 text-xs uppercase">Line Items</span>
                  <table className="w-full text-sm mt-1">
                    <thead>
                      <tr className="text-xs text-zinc-400 border-b">
                        <th className="text-left py-1 font-medium">Description</th>
                        <th className="text-right py-1 font-medium w-16">Qty</th>
                        <th className="text-right py-1 font-medium w-24">Price</th>
                        <th className="text-right py-1 font-medium w-24">Amount</th>
                      </tr>
                    </thead>
                    <tbody>
                      {items.map((item, i) => (
                        <tr key={i} className="border-b border-zinc-100">
                          <td className="py-1.5">{item.description}</td>
                          <td className="py-1.5 text-right text-zinc-500">{item.quantity}</td>
                          <td className="py-1.5 text-right text-zinc-500">{formatCurrency(item.unit_price, payment?.amount_currency as string)}</td>
                          <td className="py-1.5 text-right font-medium">{formatCurrency(item.amount, payment?.amount_currency as string)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <div className="flex justify-end mt-2 text-sm">
                    <div className="w-48">
                      {Number(payment?.discount) > 0 && (
                        <>
                          <div className="flex justify-between"><span className="text-zinc-500">Subtotal</span><span>{formatCurrency(payment?.subtotal as number, payment?.amount_currency as string)}</span></div>
                          <div className="flex justify-between"><span className="text-zinc-500">Discount</span><span>-{formatCurrency(payment?.discount as number, payment?.amount_currency as string)}</span></div>
                        </>
                      )}
                      <div className="flex justify-between font-semibold border-t pt-1">
                        <span>Total</span>
                        <span className={isCredit ? 'text-purple-600' : ''}>{isCredit ? '-' : ''}{formatCurrency(payment?.total as number, payment?.amount_currency as string)}</span>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* Message */}
              {payment?.message && (
                <div>
                  <span className="text-zinc-400 text-xs uppercase">Payment Terms</span>
                  <p className="text-sm mt-1 text-zinc-600">{payment.message as string}</p>
                </div>
              )}

              {/* Confirm delete/void dialog */}
              {confirmAction && (
                <div className="bg-red-50 border border-red-200 rounded-lg p-4">
                  <p className="text-sm font-medium text-red-800">
                    {confirmAction === 'delete' ? 'Delete this invoice? This cannot be undone.' : 'Void this invoice? It will be marked as cancelled.'}
                  </p>
                  <div className="flex gap-2 mt-3">
                    <button onClick={() => setConfirmAction(null)} className="px-3 py-1.5 text-sm border rounded-md hover:bg-white">Cancel</button>
                    <button onClick={confirmAction === 'delete' ? handleDelete : handleVoid} disabled={isPending}
                      className="px-3 py-1.5 text-sm text-white bg-red-600 hover:bg-red-700 rounded-md disabled:opacity-50 flex items-center gap-1">
                      {isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                      {confirmAction === 'delete' ? 'Delete' : 'Void'}
                    </button>
                  </div>
                </div>
              )}

              {/* Action buttons */}
              {!isVoided && !confirmAction && (
                <div className="flex flex-wrap gap-2 pt-2 border-t">
                  {/* Download PDF — always */}
                  <button onClick={handleDownload}
                    className="px-3 py-2 text-sm border rounded-md hover:bg-zinc-50 flex items-center gap-1.5">
                    <Download className="h-4 w-4" /> PDF
                  </button>

                  {/* Send — Draft or Overdue */}
                  {canSend && (
                    <button onClick={handleSend} disabled={isPending}
                      className="px-3 py-2 text-sm text-white bg-blue-600 hover:bg-blue-700 rounded-md disabled:opacity-50 flex items-center gap-1.5">
                      {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} Send
                    </button>
                  )}

                  {/* Remind — Sent or Overdue */}
                  {canRemind && (
                    <button onClick={handleRemind} disabled={isPending}
                      className="px-3 py-2 text-sm text-amber-700 bg-amber-50 border border-amber-200 hover:bg-amber-100 rounded-md disabled:opacity-50 flex items-center gap-1.5">
                      {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Bell className="h-4 w-4" />} Remind
                    </button>
                  )}

                  {/* Mark Paid — Sent or Overdue */}
                  {canMarkPaid && (
                    <button onClick={handleMarkPaid} disabled={isPending}
                      className="px-3 py-2 text-sm text-white bg-emerald-600 hover:bg-emerald-700 rounded-md disabled:opacity-50 flex items-center gap-1.5">
                      {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />} Mark Paid
                    </button>
                  )}

                  {/* Edit — Draft only */}
                  {canEdit && (
                    <button onClick={startEdit}
                      className="px-3 py-2 text-sm border rounded-md hover:bg-zinc-50 flex items-center gap-1.5">
                      Edit
                    </button>
                  )}

                  {/* Spacer */}
                  <div className="flex-1" />

                  {/* Void — Draft, Sent, Overdue */}
                  {canVoid && (
                    <button onClick={() => setConfirmAction('void')}
                      className="px-3 py-2 text-sm text-zinc-500 border rounded-md hover:bg-zinc-50 flex items-center gap-1.5">
                      <Ban className="h-4 w-4" /> Void
                    </button>
                  )}

                  {/* Delete — Draft only */}
                  {canDelete && (
                    <button onClick={() => setConfirmAction('delete')}
                      className="px-3 py-2 text-sm text-red-600 border border-red-200 rounded-md hover:bg-red-50 flex items-center gap-1.5">
                      <Trash2 className="h-4 w-4" /> Delete
                    </button>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </>
  )
}
