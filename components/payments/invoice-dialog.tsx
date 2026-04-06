'use client'

import { useState, useTransition } from 'react'
import { X, Loader2, Plus, Trash2, FileText, CreditCard, Landmark, Building2 as BankIcon } from 'lucide-react'
import { toast } from 'sonner'
import { AccountCombobox } from '@/components/shared/account-combobox'
import { ServiceTypeSelect } from '@/components/shared/service-type-select'
import { createInvoice, createCreditNote } from '@/app/(dashboard)/payments/invoice-actions'
import type { CreateInvoiceInput, CreateCreditNoteInput, InvoiceItem } from '@/lib/schemas/invoice'

interface InvoiceDialogProps {
  open: boolean
  onClose: () => void
  mode?: 'invoice' | 'credit'
  /** Override the default createInvoice action (e.g. to use createUnifiedInvoice) */
  onCreateInvoice?: (input: CreateInvoiceInput) => Promise<{ success: boolean; error?: string; data?: { id: string; invoice_number: string } }>
}

const emptyItem = (): InvoiceItem => ({
  description: '',
  quantity: 1,
  unit_price: 0,
  amount: 0,
  sort_order: 0,
})

export function InvoiceDialog({ open, onClose, mode = 'invoice', onCreateInvoice }: InvoiceDialogProps) {
  const [isPending, startTransition] = useTransition()
  const [accountId, setAccountId] = useState<string | undefined>()
  const [accountName, setAccountName] = useState<string | undefined>()
  const [description, setDescription] = useState('')
  const [currency, setCurrency] = useState<'USD' | 'EUR'>('USD')
  const [issueDate, setIssueDate] = useState(new Date().toISOString().split('T')[0])
  const [dueDate, setDueDate] = useState('')
  const [discount, setDiscount] = useState('')
  const [message, setMessage] = useState('')
  const [paymentMethod, setPaymentMethod] = useState<'bank_transfer' | 'card' | 'both'>('both')
  const [bankPreference, setBankPreference] = useState<'auto' | 'relay' | 'mercury' | 'revolut' | 'airwallex'>('auto')
  const [items, setItems] = useState<InvoiceItem[]>([emptyItem()])
  const [errors, setErrors] = useState<Record<string, string>>({})

  if (!open) return null

  const isCredit = mode === 'credit'

  const subtotal = items.reduce((sum, item) => sum + item.amount, 0)
  const discountNum = Number(discount) || 0
  const total = isCredit ? -subtotal : subtotal - discountNum

  const updateItem = (index: number, field: keyof InvoiceItem, value: string | number) => {
    setItems(prev => {
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

  const addItem = () => {
    setItems(prev => [...prev, { ...emptyItem(), sort_order: prev.length }])
  }

  const removeItem = (index: number) => {
    if (items.length <= 1) return
    setItems(prev => prev.filter((_, i) => i !== index))
  }

  const resetForm = () => {
    setAccountId(undefined)
    setAccountName(undefined)
    setDescription('')
    setCurrency('USD')
    setIssueDate(new Date().toISOString().split('T')[0])
    setDueDate('')
    setDiscount('')
    setMessage('')
    setPaymentMethod('both')
    setBankPreference('auto')
    setItems([emptyItem()])
    setErrors({})
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    setErrors({})

    const newErrors: Record<string, string> = {}
    if (!accountId) newErrors.account_id = 'Account required'
    if (!description.trim()) newErrors.description = 'Description required'
    if (items.some(i => !i.description.trim())) newErrors.items = 'All items need a description'
    if (items.some(i => i.amount === 0)) newErrors.items = 'All items need an amount'

    if (Object.keys(newErrors).length > 0) {
      setErrors(newErrors)
      return
    }

    startTransition(async () => {
      if (isCredit) {
        const input: CreateCreditNoteInput = {
          account_id: accountId!,
          description: description.trim(),
          amount_currency: currency,
          issue_date: issueDate,
          items: items.map((item, i) => ({ ...item, sort_order: i })),
        }
        const result = await createCreditNote(input)
        if (result.success) {
          toast.success(`Credit note ${result.data?.invoice_number} created`)
          resetForm()
          onClose()
        } else {
          toast.error(result.error ?? 'Error creating credit note')
        }
      } else {
        const input: CreateInvoiceInput = {
          account_id: accountId!,
          description: description.trim(),
          amount_currency: currency,
          issue_date: issueDate,
          due_date: dueDate || undefined,
          discount: discountNum,
          message: message.trim() || undefined,
          payment_method: paymentMethod,
          bank_preference: bankPreference,
          items: items.map((item, i) => ({ ...item, sort_order: i })),
        }
        const result = onCreateInvoice
          ? await onCreateInvoice(input)
          : await createInvoice(input)
        if (result.success) {
          toast.success(`Invoice ${result.data?.invoice_number} created as Draft`)
          resetForm()
          onClose()
        } else {
          toast.error(result.error ?? 'Error creating invoice')
        }
      }
    })
  }

  const handleClose = () => {
    resetForm()
    onClose()
  }

  const currencySymbol = currency === 'EUR' ? '€' : '$'

  return (
    <>
      <div className="fixed inset-0 z-50 bg-black/50" onClick={handleClose} />
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div
          className="bg-white rounded-lg shadow-xl w-full max-w-2xl max-h-[90vh] overflow-y-auto"
          onClick={e => e.stopPropagation()}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-6 py-4 border-b">
            <div className="flex items-center gap-2">
              <FileText className="h-5 w-5 text-zinc-500" />
              <h2 className="text-lg font-semibold">
                {isCredit ? 'New Credit Note' : 'New Invoice'}
              </h2>
            </div>
            <button onClick={handleClose} className="p-1 rounded hover:bg-zinc-100">
              <X className="h-5 w-5" />
            </button>
          </div>

          <form onSubmit={handleSubmit} className="px-6 py-4 space-y-4">
            {/* Account */}
            <div>
              <label className="block text-sm font-medium mb-1">Account *</label>
              <AccountCombobox
                value={accountId}
                displayValue={accountName}
                onChange={(id, name) => { setAccountId(id); setAccountName(name) }}
              />
              {errors.account_id && <p className="text-xs text-red-600 mt-1">{errors.account_id}</p>}
            </div>

            {/* Service Type */}
            <div>
              <label className="block text-sm font-medium mb-1">Service *</label>
              {isCredit ? (
                <input
                  type="text"
                  value={description}
                  onChange={e => setDescription(e.target.value)}
                  autoFocus
                  placeholder="Referral credit — Partner Name"
                  className="w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              ) : (
                <ServiceTypeSelect
                  value={description}
                  onChange={(name, defaultPrice, defaultCurrency) => {
                    setDescription(name)
                    // Auto-fill first line item with service name and price
                    if (defaultPrice != null && items.length === 1 && items[0].amount === 0) {
                      setItems([{
                        description: name,
                        quantity: 1,
                        unit_price: defaultPrice,
                        amount: defaultPrice,
                        sort_order: 0,
                      }])
                    }
                    if (defaultCurrency) {
                      setCurrency(defaultCurrency as 'USD' | 'EUR')
                    }
                  }}
                  placeholder="Select service type..."
                />
              )}
              {errors.description && <p className="text-xs text-red-600 mt-1">{errors.description}</p>}
            </div>

            {/* Currency + Dates */}
            <div className="grid grid-cols-3 gap-3">
              <div>
                <label className="block text-sm font-medium mb-1">Currency</label>
                <select
                  value={currency}
                  onChange={e => setCurrency(e.target.value as 'USD' | 'EUR')}
                  className="w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="USD">USD ($)</option>
                  <option value="EUR">EUR (€)</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Issue Date *</label>
                <input
                  type="date"
                  value={issueDate}
                  onChange={e => setIssueDate(e.target.value)}
                  required
                  className="w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              {!isCredit && (
                <div>
                  <label className="block text-sm font-medium mb-1">Due Date</label>
                  <input
                    type="date"
                    value={dueDate}
                    onChange={e => setDueDate(e.target.value)}
                    className="w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
              )}
            </div>

            {/* Line Items */}
            <div>
              <label className="block text-sm font-medium mb-2">Line Items *</label>
              <div className="border rounded-md overflow-hidden">
                {/* Header */}
                <div className="grid grid-cols-[1fr_80px_100px_100px_32px] gap-2 px-3 py-2 bg-zinc-50 text-xs font-medium text-zinc-500">
                  <span>Description</span>
                  <span className="text-right">Qty</span>
                  <span className="text-right">Unit Price</span>
                  <span className="text-right">Amount</span>
                  <span />
                </div>

                {/* Items */}
                {items.map((item, i) => (
                  <div key={i} className="grid grid-cols-[1fr_80px_100px_100px_32px] gap-2 px-3 py-2 border-t items-center">
                    <input
                      type="text"
                      value={item.description}
                      onChange={e => updateItem(i, 'description', e.target.value)}
                      placeholder="Service description"
                      className="px-2 py-1 text-sm border rounded focus:outline-none focus:ring-1 focus:ring-blue-500"
                    />
                    <input
                      type="number"
                      step="0.01"
                      min="0"
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
                      {currencySymbol}{item.amount.toFixed(2)}
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

                {/* Add item */}
                <div className="px-3 py-2 border-t">
                  <button
                    type="button"
                    onClick={addItem}
                    className="text-sm text-blue-600 hover:text-blue-700 flex items-center gap-1"
                  >
                    <Plus className="h-3.5 w-3.5" /> Add line
                  </button>
                </div>
              </div>
              {errors.items && <p className="text-xs text-red-600 mt-1">{errors.items}</p>}
            </div>

            {/* Totals */}
            <div className="flex justify-end">
              <div className="w-64 space-y-1 text-sm">
                <div className="flex justify-between">
                  <span className="text-zinc-500">Subtotal</span>
                  <span>{currencySymbol}{subtotal.toFixed(2)}</span>
                </div>
                {!isCredit && (
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
                )}
                <div className="flex justify-between font-semibold border-t pt-1">
                  <span>Total</span>
                  <span className={isCredit ? 'text-purple-600' : ''}>
                    {isCredit ? '-' : ''}{currencySymbol}{Math.abs(total).toFixed(2)}
                  </span>
                </div>
              </div>
            </div>

            {/* Payment Method + Bank Account (invoice only) */}
            {!isCredit && (
              <div className="space-y-3">
                <div>
                  <label className="block text-sm font-medium mb-2">Payment Method *</label>
                  <div className="flex gap-2">
                    {([
                      { value: 'both', label: 'Both', desc: 'Bank + Card', icon: BankIcon },
                      { value: 'bank_transfer', label: 'Bank Transfer', desc: 'Wire only', icon: Landmark },
                      { value: 'card', label: 'Card', desc: 'Stripe only', icon: CreditCard },
                    ] as const).map(opt => (
                      <button
                        key={opt.value}
                        type="button"
                        onClick={() => setPaymentMethod(opt.value)}
                        className={`flex-1 flex items-center gap-2 px-3 py-2.5 rounded-lg border-2 text-left transition-all ${
                          paymentMethod === opt.value
                            ? 'border-blue-500 bg-blue-50 text-blue-700'
                            : 'border-zinc-200 hover:border-zinc-300 text-zinc-600'
                        }`}
                      >
                        <opt.icon className={`h-4 w-4 shrink-0 ${paymentMethod === opt.value ? 'text-blue-500' : 'text-zinc-400'}`} />
                        <div>
                          <p className="text-sm font-medium">{opt.label}</p>
                          <p className="text-[10px] text-zinc-400">{opt.desc}</p>
                        </div>
                      </button>
                    ))}
                  </div>
                </div>

                {/* Bank Account Selector — shown when bank transfer is selected */}
                {(paymentMethod === 'bank_transfer' || paymentMethod === 'both') && (
                  <div>
                    <label className="block text-sm font-medium mb-1">Bank Account</label>
                    <select
                      value={bankPreference}
                      onChange={e => setBankPreference(e.target.value as typeof bankPreference)}
                      className="w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                    >
                      <option value="auto">Auto — {currency === 'EUR' ? 'Airwallex (EUR)' : 'Relay (USD)'}</option>
                      <option value="relay">Relay Financial (USD)</option>
                      <option value="mercury">Mercury (USD)</option>
                      <option value="revolut">Revolut (USD)</option>
                      <option value="airwallex">Airwallex (EUR)</option>
                    </select>
                    <p className="text-[10px] text-zinc-400 mt-1">
                      Bank details will be included in the invoice message automatically.
                    </p>
                  </div>
                )}
              </div>
            )}

            {/* Message (invoice only) */}
            {!isCredit && (
              <div>
                <label className="block text-sm font-medium mb-1">Additional Notes</label>
                <textarea
                  value={message}
                  onChange={e => setMessage(e.target.value)}
                  rows={2}
                  placeholder="Any additional payment terms or notes..."
                  className="w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
                />
              </div>
            )}

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
                className={`px-4 py-2 text-sm text-white rounded-md disabled:opacity-50 flex items-center gap-2 ${
                  isCredit
                    ? 'bg-purple-600 hover:bg-purple-700'
                    : 'bg-zinc-900 hover:bg-zinc-800'
                }`}
              >
                {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileText className="h-4 w-4" />}
                {isCredit ? 'Create Credit Note' : 'Save as Draft'}
              </button>
            </div>
          </form>
        </div>
      </div>
    </>
  )
}
