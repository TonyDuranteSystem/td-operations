'use client'

import { useState, useEffect, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Plus, Trash2, ArrowLeft, Loader2, Save, Landmark } from 'lucide-react'
import { toast } from 'sonner'
import { createInvoice, updateInvoice, createCustomer } from '@/app/portal/invoices/actions'
import { useLocale } from '@/lib/portal/use-locale'
import Link from 'next/link'

interface Customer {
  id: string
  name: string
  email: string | null
}

interface LineItem {
  description: string
  quantity: number
  unit_price: number
  amount: number
}

interface Template {
  id: string
  name: string
  customer_id: string | null
  currency: string
  items: { description: string; quantity: number; unit_price: number }[]
  message: string | null
}

interface InvoiceFormProps {
  accountId: string
  customers: Customer[]
  templates?: Template[]
  mode: 'create' | 'edit'
  initialData?: {
    id?: string
    customerId: string
    currency: 'USD' | 'EUR'
    discount: number
    issueDate: string
    dueDate: string
    notes: string
    message: string
    bankAccountId?: string | null
    items: LineItem[]
  }
}

export function InvoiceForm({ accountId, customers, templates, mode, initialData }: InvoiceFormProps) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const { t } = useLocale()

  // Customer
  const [customerId, setCustomerId] = useState(initialData?.customerId ?? '')
  const [showNewCustomer, setShowNewCustomer] = useState(false)
  const [newCustomerName, setNewCustomerName] = useState('')
  const [newCustomerEmail, setNewCustomerEmail] = useState('')
  const [customerList, setCustomerList] = useState(customers)

  // Invoice fields
  const [currency, setCurrency] = useState<'USD' | 'EUR'>(initialData?.currency ?? 'USD')
  const [discount, setDiscount] = useState(initialData?.discount ?? 0)
  const [issueDate, setIssueDate] = useState(initialData?.issueDate ?? new Date().toISOString().split('T')[0])
  const [dueDate, setDueDate] = useState(initialData?.dueDate ?? '')
  const [notes, setNotes] = useState(initialData?.notes ?? '')
  const [message, setMessage] = useState(initialData?.message ?? '')
  const [recurringFrequency, setRecurringFrequency] = useState<string>('')
  const [recurringEndDate, setRecurringEndDate] = useState('')

  // Bank account
  const [bankAccountId, setBankAccountId] = useState<string>(initialData?.bankAccountId ?? '')
  const [bankAccounts, setBankAccounts] = useState<{ id: string; label: string; currency: string }[]>([])

  useEffect(() => {
    fetch(`/api/portal/bank-accounts?account_id=${accountId}`)
      .then(r => r.json())
      .then(data => {
        const list = Array.isArray(data) ? data : []
        setBankAccounts(list)
        // Auto-select the show_on_invoice account if none selected
        if (!bankAccountId && list.length > 0) {
          const defaultAcc = list.find((a: { show_on_invoice?: boolean }) => a.show_on_invoice) || list[0]
          setBankAccountId(defaultAcc.id)
        }
      })
      .catch(() => {})
  }, [accountId]) // eslint-disable-line react-hooks/exhaustive-deps

  // Line items
  const [items, setItems] = useState<LineItem[]>(
    initialData?.items ?? [{ description: '', quantity: 1, unit_price: 0, amount: 0 }]
  )

  const subtotal = items.reduce((sum, item) => sum + item.amount, 0)
  const total = Math.max(subtotal - discount, 0)
  const currencySymbol = currency === 'EUR' ? '\u20AC' : '$'

  const updateItem = (index: number, field: keyof LineItem, value: string | number) => {
    setItems(prev => {
      const updated = [...prev]
      const item = { ...updated[index], [field]: value }
      // Recalculate amount
      if (field === 'quantity' || field === 'unit_price') {
        item.amount = Number(item.quantity) * Number(item.unit_price)
      }
      updated[index] = item
      return updated
    })
  }

  const addItem = () => {
    setItems(prev => [...prev, { description: '', quantity: 1, unit_price: 0, amount: 0 }])
  }

  const removeItem = (index: number) => {
    if (items.length <= 1) return
    setItems(prev => prev.filter((_, i) => i !== index))
  }

  const handleCreateCustomer = async () => {
    if (!newCustomerName.trim()) return
    const result = await createCustomer({
      account_id: accountId,
      name: newCustomerName.trim(),
      email: newCustomerEmail.trim() || undefined,
    })
    if (result.success && result.data) {
      setCustomerList(prev => [...prev, { id: result.data!.id, name: newCustomerName, email: newCustomerEmail || null }])
      setCustomerId(result.data.id)
      setShowNewCustomer(false)
      setNewCustomerName('')
      setNewCustomerEmail('')
      toast.success('Customer created')
    } else {
      toast.error(result.error ?? 'Failed to create customer')
    }
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()

    if (!customerId) {
      toast.error('Please select a customer')
      return
    }
    if (items.some(item => !item.description.trim())) {
      toast.error('All line items need a description')
      return
    }

    startTransition(async () => {
      const itemsPayload = items.map((item, i) => ({
        ...item,
        quantity: Number(item.quantity),
        unit_price: Number(item.unit_price),
        amount: Number(item.quantity) * Number(item.unit_price),
        sort_order: i,
      }))

      if (mode === 'edit' && initialData?.id) {
        const result = await updateInvoice({
          id: initialData.id,
          account_id: accountId,
          customer_id: customerId,
          currency,
          discount,
          issue_date: issueDate,
          due_date: dueDate || undefined,
          notes: notes || undefined,
          message: message || undefined,
          bank_account_id: bankAccountId || null,
          items: itemsPayload,
        })
        if (result.success) {
          toast.success('Invoice updated')
          router.push(`/portal/invoices/${initialData.id}`)
        } else {
          toast.error(result.error ?? 'Failed to update invoice')
        }
      } else {
        const result = await createInvoice({
          account_id: accountId,
          customer_id: customerId,
          currency,
          discount,
          issue_date: issueDate,
          due_date: dueDate || undefined,
          notes: notes || undefined,
          message: message || undefined,
          recurring_frequency: (recurringFrequency as 'monthly' | 'quarterly' | 'yearly') || null,
          recurring_end_date: recurringEndDate || null,
          bank_account_id: bankAccountId || null,
          items: itemsPayload,
        })
        if (result.success) {
          toast.success(`Invoice ${result.data?.invoice_number} created`)
          router.push('/portal/invoices')
        } else {
          toast.error(result.error ?? 'Failed to create invoice')
        }
      }
    })
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-4">
        <Link href="/portal/invoices" className="p-2 rounded-lg hover:bg-zinc-100">
          <ArrowLeft className="h-5 w-5" />
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-900">
          {mode === 'create' ? t('invoices.newInvoice') : t('invoices.editInvoice')}
        </h1>
      </div>

      <div className="bg-white rounded-xl border shadow-sm p-6 space-y-6">
        {/* From Template */}
        {mode === 'create' && templates && templates.length > 0 && (
          <div>
            <label className="block text-sm font-medium text-zinc-700 mb-1.5">From Template</label>
            <select
              onChange={e => {
                const tmpl = templates.find(t => t.id === e.target.value)
                if (!tmpl) return
                if (tmpl.customer_id) setCustomerId(tmpl.customer_id)
                setCurrency(tmpl.currency as 'USD' | 'EUR')
                setItems(tmpl.items.map(i => ({ ...i, amount: i.quantity * i.unit_price })))
                if (tmpl.message) setMessage(tmpl.message)
              }}
              defaultValue=""
              className="w-full px-3 py-2.5 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="">Select a template...</option>
              {templates.map(t => (
                <option key={t.id} value={t.id}>{t.name} ({t.items.length} items, {t.currency})</option>
              ))}
            </select>
          </div>
        )}

        {/* Customer + Currency Row */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-zinc-700 mb-1.5">{t('invoices.customer')} *</label>
            {showNewCustomer ? (
              <div className="space-y-2">
                <input
                  type="text"
                  value={newCustomerName}
                  onChange={e => setNewCustomerName(e.target.value)}
                  placeholder="Customer name"
                  autoFocus
                  className="w-full px-3 py-2.5 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                <input
                  type="email"
                  value={newCustomerEmail}
                  onChange={e => setNewCustomerEmail(e.target.value)}
                  placeholder="Email (optional)"
                  className="w-full px-3 py-2.5 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                <div className="flex gap-2">
                  <button type="button" onClick={handleCreateCustomer} className="px-3 py-1.5 text-xs bg-blue-600 text-white rounded-lg hover:bg-blue-700">Add</button>
                  <button type="button" onClick={() => setShowNewCustomer(false)} className="px-3 py-1.5 text-xs border rounded-lg hover:bg-zinc-50">Cancel</button>
                </div>
              </div>
            ) : (
              <div className="flex gap-2">
                <select
                  value={customerId}
                  onChange={e => setCustomerId(e.target.value)}
                  className="flex-1 px-3 py-2.5 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  <option value="">Select customer...</option>
                  {customerList.map(c => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
                <button type="button" onClick={() => setShowNewCustomer(true)} className="px-3 py-2.5 text-xs border rounded-lg hover:bg-zinc-50 shrink-0">
                  + New
                </button>
              </div>
            )}
          </div>
          <div>
            <label className="block text-sm font-medium text-zinc-700 mb-1.5">{t('invoices.currency')}</label>
            <select
              value={currency}
              onChange={e => setCurrency(e.target.value as 'USD' | 'EUR')}
              className="w-full px-3 py-2.5 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="USD">$ (USD)</option>
              <option value="EUR">&euro; (EUR)</option>
            </select>
          </div>
        </div>

        {/* Dates */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <div>
            <label className="block text-sm font-medium text-zinc-700 mb-1.5">{t('invoices.issueDate')}</label>
            <input
              type="date"
              value={issueDate}
              onChange={e => setIssueDate(e.target.value)}
              className="w-full px-3 py-2.5 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-zinc-700 mb-1.5">{t('invoices.dueDate')}</label>
            <input
              type="date"
              value={dueDate}
              onChange={e => setDueDate(e.target.value)}
              className="w-full px-3 py-2.5 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
        </div>

        {/* Recurring */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <div>
            <label className="block text-sm font-medium text-zinc-700 mb-1.5">{t('invoices.recurring')}</label>
            <select
              value={recurringFrequency}
              onChange={e => setRecurringFrequency(e.target.value)}
              className="w-full px-3 py-2.5 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="">{t('invoices.oneTime')}</option>
              <option value="monthly">{t('invoices.monthly')}</option>
              <option value="quarterly">{t('invoices.quarterly')}</option>
              <option value="yearly">{t('invoices.yearly')}</option>
            </select>
          </div>
          {recurringFrequency && (
            <div className="sm:col-span-2">
              <label className="block text-sm font-medium text-zinc-700 mb-1.5">End Date (optional)</label>
              <input
                type="date"
                value={recurringEndDate}
                onChange={e => setRecurringEndDate(e.target.value)}
                className="w-full px-3 py-2.5 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
              <p className="text-xs text-zinc-400 mt-1">Leave empty for indefinite recurring</p>
            </div>
          )}
        </div>

        {/* Line Items */}
        <div>
          <label className="block text-sm font-medium text-zinc-700 mb-3">{t('invoices.lineItems')}</label>
          <div className="space-y-2">
            {/* Header */}
            <div className="hidden sm:grid sm:grid-cols-[1fr,80px,100px,100px,40px] gap-2 text-xs font-medium text-zinc-500 uppercase px-1">
              <span>Description</span>
              <span>Qty</span>
              <span>Price</span>
              <span>Amount</span>
              <span></span>
            </div>

            {items.map((item, i) => (
              <div key={i} className="grid grid-cols-1 sm:grid-cols-[1fr,80px,100px,100px,40px] gap-2 items-start">
                <input
                  type="text"
                  value={item.description}
                  onChange={e => updateItem(i, 'description', e.target.value)}
                  placeholder="Item description"
                  className="px-3 py-2 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                <input
                  type="number"
                  value={item.quantity}
                  onChange={e => updateItem(i, 'quantity', Number(e.target.value))}
                  min="0.01"
                  step="0.01"
                  className="px-3 py-2 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                <input
                  type="number"
                  value={item.unit_price}
                  onChange={e => updateItem(i, 'unit_price', Number(e.target.value))}
                  min="0"
                  step="0.01"
                  className="px-3 py-2 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
                <div className="px-3 py-2 text-sm bg-zinc-50 border rounded-lg text-zinc-700 font-medium">
                  {currencySymbol}{(Number(item.quantity) * Number(item.unit_price)).toFixed(2)}
                </div>
                <button
                  type="button"
                  onClick={() => removeItem(i)}
                  disabled={items.length <= 1}
                  className="p-2 rounded-lg text-zinc-400 hover:text-red-500 hover:bg-red-50 disabled:opacity-30 transition-colors"
                >
                  <Trash2 className="h-4 w-4" />
                </button>
              </div>
            ))}
          </div>
          <button
            type="button"
            onClick={addItem}
            className="mt-3 flex items-center gap-1.5 text-sm text-blue-600 hover:text-blue-700"
          >
            <Plus className="h-4 w-4" />
            {t('invoices.addItem')}
          </button>
        </div>

        {/* Totals */}
        <div className="flex justify-end">
          <div className="w-64 space-y-2 text-sm">
            <div className="flex justify-between">
              <span className="text-zinc-500">{t('invoices.subtotal')}</span>
              <span className="font-medium">{currencySymbol}{subtotal.toFixed(2)}</span>
            </div>
            <div className="flex justify-between items-center">
              <span className="text-zinc-500">{t('invoices.discount')}</span>
              <input
                type="number"
                value={discount}
                onChange={e => setDiscount(Number(e.target.value))}
                min="0"
                step="0.01"
                className="w-24 px-2 py-1 text-sm border rounded-lg text-right focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div className="flex justify-between pt-2 border-t font-semibold text-base">
              <span>{t('invoices.total')}</span>
              <span>{currencySymbol}{total.toFixed(2)}</span>
            </div>
          </div>
        </div>

        {/* Message */}
        <div>
          <label className="block text-sm font-medium text-zinc-700 mb-1.5">{t('invoices.message')}</label>
          <textarea
            value={message}
            onChange={e => setMessage(e.target.value)}
            rows={3}
            placeholder="Payment terms, bank details, thank you note..."
            className="w-full px-3 py-2.5 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
          />
        </div>

        {/* Bank Account for Invoice */}
        {bankAccounts.length > 0 && (
          <div>
            <label className="block text-sm font-medium text-zinc-700 mb-1.5">
              <Landmark className="h-4 w-4 inline mr-1.5 -mt-0.5" />
              {t('bank.showOnInvoice') || 'Bank Account on Invoice'}
            </label>
            <select
              value={bankAccountId}
              onChange={e => setBankAccountId(e.target.value)}
              className="w-full px-3 py-2.5 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
            >
              <option value="">None — no bank details on invoice</option>
              {bankAccounts.map(ba => (
                <option key={ba.id} value={ba.id}>{ba.label} ({ba.currency})</option>
              ))}
            </select>
            <p className="text-xs text-zinc-400 mt-1">
              {t('bank.autoNote') || 'Choose which bank account details appear on this invoice'}
            </p>
          </div>
        )}

        {/* Notes (internal) */}
        <div>
          <label className="block text-sm font-medium text-zinc-700 mb-1.5">{t('invoices.internalNotes')}</label>
          <textarea
            value={notes}
            onChange={e => setNotes(e.target.value)}
            rows={2}
            placeholder="Notes for your reference (not shown to customer)"
            className="w-full px-3 py-2.5 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
          />
        </div>
      </div>

      {/* Actions */}
      <div className="flex justify-end gap-3">
        <Link
          href="/portal/invoices"
          className="px-4 py-2.5 text-sm border rounded-lg hover:bg-zinc-50"
        >
          Cancel
        </Link>
        <button
          type="submit"
          disabled={isPending}
          className="flex items-center gap-2 px-6 py-2.5 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors"
        >
          {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
          {mode === 'create' ? t('invoices.create') : t('invoices.save')}
        </button>
      </div>
    </form>
  )
}
