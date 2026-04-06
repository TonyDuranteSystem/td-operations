'use client'

import { useState, useMemo, useTransition } from 'react'
import { Search, Plus, CheckCircle2, Ban, Loader2, X, FileText } from 'lucide-react'
import { createTDExpense, markTDExpensePaid, voidTDExpense } from './expense-actions'
import { toast } from 'sonner'
import { format, parseISO } from 'date-fns'

export interface TDExpenseRecord {
  id: string
  vendor_name: string
  invoice_number: string | null
  description: string | null
  currency: string
  total: number
  issue_date: string | null
  due_date: string | null
  paid_date: string | null
  status: string
  payment_method: string | null
  category: string | null
  account_id: string | null
  notes: string | null
  accounts: { company_name: string } | null
}

const STATUS_COLORS: Record<string, string> = {
  Pending: 'bg-amber-100 text-amber-700',
  Paid: 'bg-emerald-100 text-emerald-700',
  Overdue: 'bg-red-100 text-red-700',
  Cancelled: 'bg-zinc-100 text-zinc-500',
}

const CATEGORY_COLORS: Record<string, string> = {
  Operations: 'bg-blue-50 text-blue-700',
  Legal: 'bg-purple-50 text-purple-700',
  Accounting: 'bg-indigo-50 text-indigo-700',
  Software: 'bg-cyan-50 text-cyan-700',
  'Filing Fees': 'bg-orange-50 text-orange-700',
  Shipping: 'bg-amber-50 text-amber-700',
  'Registered Agent': 'bg-emerald-50 text-emerald-700',
  Office: 'bg-zinc-50 text-zinc-600',
  Marketing: 'bg-pink-50 text-pink-700',
  Other: 'bg-zinc-50 text-zinc-600',
}

const STATUS_TABS = ['All', 'Pending', 'Paid', 'Overdue']
const CATEGORIES = ['Operations', 'Legal', 'Accounting', 'Software', 'Filing Fees', 'Shipping', 'Registered Agent', 'Office', 'Marketing', 'Other']

function fmtDate(d: string | null): string {
  if (!d) return '—'
  try { return format(parseISO(d), 'MMM d, yyyy') } catch { return d }
}

export function ExpensesTab({ expenses }: { expenses: TDExpenseRecord[] }) {
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('All')
  const [showNewExpense, setShowNewExpense] = useState(false)
  const [isPending, startTransition] = useTransition()

  // Stats
  const stats = useMemo(() => {
    const active = expenses.filter(e => e.status !== 'Cancelled')
    return {
      total: active.reduce((s, e) => s + Number(e.total), 0),
      paid: active.filter(e => e.status === 'Paid').reduce((s, e) => s + Number(e.total), 0),
      pending: active.filter(e => ['Pending', 'Overdue'].includes(e.status)).reduce((s, e) => s + Number(e.total), 0),
      count: active.length,
    }
  }, [expenses])

  // Status counts
  const statusCounts = useMemo(() => {
    const counts: Record<string, number> = { All: expenses.length }
    for (const e of expenses) { counts[e.status] = (counts[e.status] ?? 0) + 1 }
    return counts
  }, [expenses])

  const filtered = expenses.filter(e => {
    if (statusFilter !== 'All' && e.status !== statusFilter) return false
    if (search) {
      const q = search.toLowerCase()
      return (e.vendor_name?.toLowerCase().includes(q)) ||
        (e.invoice_number?.toLowerCase().includes(q)) ||
        (e.description?.toLowerCase().includes(q)) ||
        (e.category?.toLowerCase().includes(q))
    }
    return true
  })

  const handleMarkPaid = (id: string) => {
    startTransition(async () => {
      const result = await markTDExpensePaid(id)
      if (result.success) toast.success('Expense marked as paid')
      else toast.error(result.error ?? 'Failed')
    })
  }

  const handleVoid = (id: string) => {
    startTransition(async () => {
      const result = await voidTDExpense(id)
      if (result.success) toast.success('Expense voided')
      else toast.error(result.error ?? 'Failed')
    })
  }

  return (
    <div className="h-full overflow-auto p-6 space-y-4">
      {/* Stats */}
      <div className="grid grid-cols-4 gap-3">
        <div className="bg-white rounded-lg border p-4">
          <p className="text-xs text-muted-foreground uppercase">Total Expenses</p>
          <p className="text-xl font-semibold mt-1">${stats.total.toLocaleString(undefined, { minimumFractionDigits: 2 })}</p>
        </div>
        <div className="bg-white rounded-lg border p-4">
          <p className="text-xs text-muted-foreground uppercase">Paid</p>
          <p className="text-xl font-semibold text-emerald-600 mt-1">${stats.paid.toLocaleString(undefined, { minimumFractionDigits: 2 })}</p>
        </div>
        <div className="bg-white rounded-lg border p-4">
          <p className="text-xs text-muted-foreground uppercase">Pending</p>
          <p className="text-xl font-semibold text-amber-600 mt-1">${stats.pending.toLocaleString(undefined, { minimumFractionDigits: 2 })}</p>
        </div>
        <div className="bg-white rounded-lg border p-4">
          <p className="text-xs text-muted-foreground uppercase">Count</p>
          <p className="text-xl font-semibold mt-1">{stats.count}</p>
        </div>
      </div>

      {/* Toolbar */}
      <div className="flex items-center gap-3">
        <div className="relative flex-1 max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search by vendor, invoice #, or description..."
            className="w-full pl-9 pr-3 py-2 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <div className="flex gap-1">
          {STATUS_TABS.map(tab => (
            <button
              key={tab}
              onClick={() => setStatusFilter(tab)}
              className={`px-3 py-1.5 text-xs rounded-lg font-medium transition-colors ${
                statusFilter === tab ? 'bg-blue-600 text-white' : 'bg-muted text-muted-foreground hover:bg-muted/80'
              }`}
            >
              {tab} ({statusCounts[tab] ?? 0})
            </button>
          ))}
        </div>
        <button
          onClick={() => setShowNewExpense(true)}
          className="flex items-center gap-2 px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 ml-auto"
        >
          <Plus className="h-4 w-4" />
          New Expense
        </button>
      </div>

      {/* Table */}
      <div className="bg-white rounded-lg border overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b bg-muted/50 text-muted-foreground text-xs uppercase">
              <th className="text-left px-4 py-3">Vendor</th>
              <th className="text-left px-4 py-3">Invoice #</th>
              <th className="text-left px-4 py-3">Description</th>
              <th className="text-right px-4 py-3">Amount</th>
              <th className="text-left px-4 py-3">Category</th>
              <th className="text-left px-4 py-3">Date</th>
              <th className="text-left px-4 py-3">Status</th>
              <th className="text-left px-4 py-3">Client</th>
              <th className="text-right px-4 py-3">Actions</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={9} className="text-center py-12 text-muted-foreground">
                  <FileText className="h-10 w-10 mx-auto mb-2 text-muted-foreground/30" />
                  No expenses found
                </td>
              </tr>
            ) : filtered.map(exp => (
              <tr key={exp.id} className="border-b last:border-b-0 hover:bg-muted/30 transition-colors">
                <td className="px-4 py-3 font-medium">{exp.vendor_name}</td>
                <td className="px-4 py-3 text-muted-foreground text-xs">{exp.invoice_number || '—'}</td>
                <td className="px-4 py-3 text-muted-foreground max-w-[200px] truncate">{exp.description || '—'}</td>
                <td className="px-4 py-3 text-right font-medium">
                  {exp.currency === 'EUR' ? '€' : '$'}{Number(exp.total).toLocaleString(undefined, { minimumFractionDigits: 2 })}
                </td>
                <td className="px-4 py-3">
                  {exp.category && (
                    <span className={`text-[10px] px-1.5 py-0.5 rounded ${CATEGORY_COLORS[exp.category] ?? CATEGORY_COLORS.Other}`}>
                      {exp.category}
                    </span>
                  )}
                </td>
                <td className="px-4 py-3 text-xs text-muted-foreground">{fmtDate(exp.issue_date)}</td>
                <td className="px-4 py-3">
                  <span className={`text-xs px-2 py-0.5 rounded-full ${STATUS_COLORS[exp.status] ?? 'bg-zinc-100'}`}>
                    {exp.status}
                  </span>
                </td>
                <td className="px-4 py-3 text-xs text-muted-foreground">{exp.accounts?.company_name || '—'}</td>
                <td className="px-4 py-3 text-right">
                  <div className="flex items-center justify-end gap-1">
                    {['Pending', 'Overdue'].includes(exp.status) && (
                      <button
                        onClick={() => handleMarkPaid(exp.id)}
                        disabled={isPending}
                        title="Mark as Paid"
                        className="p-1.5 rounded hover:bg-emerald-50 text-emerald-600"
                      >
                        {isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <CheckCircle2 className="h-3.5 w-3.5" />}
                      </button>
                    )}
                    {exp.status !== 'Cancelled' && exp.status !== 'Paid' && (
                      <button
                        onClick={() => handleVoid(exp.id)}
                        disabled={isPending}
                        title="Void"
                        className="p-1.5 rounded hover:bg-red-50 text-red-500"
                      >
                        <Ban className="h-3.5 w-3.5" />
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* New Expense Dialog */}
      {showNewExpense && (
        <NewExpenseDialog onClose={() => setShowNewExpense(false)} />
      )}
    </div>
  )
}

// ── New Expense Dialog ──

function NewExpenseDialog({ onClose }: { onClose: () => void }) {
  const [isPending, startTransition] = useTransition()
  const [vendor, setVendor] = useState('')
  const [invoiceNum, setInvoiceNum] = useState('')
  const [description, setDescription] = useState('')
  const [amount, setAmount] = useState('')
  const [currency, setCurrency] = useState<'USD' | 'EUR'>('USD')
  const [category, setCategory] = useState('Operations')
  const [issueDate, setIssueDate] = useState(new Date().toISOString().split('T')[0])
  const [dueDate, setDueDate] = useState('')
  const [markPaid, setMarkPaid] = useState(false)
  const [notes, setNotes] = useState('')

  const handleSubmit = () => {
    if (!vendor.trim()) { toast.error('Vendor name required'); return }
    const total = parseFloat(amount)
    if (isNaN(total) || total <= 0) { toast.error('Valid amount required'); return }

    startTransition(async () => {
      const result = await createTDExpense({
        vendor_name: vendor.trim(),
        invoice_number: invoiceNum.trim() || undefined,
        description: description.trim() || undefined,
        currency,
        total,
        issue_date: issueDate || undefined,
        due_date: dueDate || undefined,
        category,
        mark_as_paid: markPaid,
        notes: notes.trim() || undefined,
      })
      if (result.success) {
        toast.success('Expense created')
        onClose()
      } else {
        toast.error(result.error ?? 'Failed to create')
      }
    })
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-black/40" onClick={onClose} />
      <div className="relative bg-white rounded-xl shadow-xl w-full max-w-lg mx-4 p-6 max-h-[90vh] overflow-auto">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-lg font-semibold">New Expense</h3>
          <button onClick={onClose} className="p-1 hover:bg-muted rounded"><X className="h-4 w-4" /></button>
        </div>

        <div className="space-y-3">
          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1">Vendor *</label>
            <input value={vendor} onChange={e => setVendor(e.target.value)} className="w-full px-3 py-2 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500" placeholder="e.g. Harbor Compliance, AWS, State of Florida" />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1">Invoice #</label>
              <input value={invoiceNum} onChange={e => setInvoiceNum(e.target.value)} className="w-full px-3 py-2 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1">Category</label>
              <select value={category} onChange={e => setCategory(e.target.value)} className="w-full px-3 py-2 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500">
                {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1">Description</label>
            <input value={description} onChange={e => setDescription(e.target.value)} className="w-full px-3 py-2 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500" placeholder="What is this expense for?" />
          </div>

          <div className="grid grid-cols-3 gap-3">
            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1">Amount *</label>
              <input type="number" step="0.01" value={amount} onChange={e => setAmount(e.target.value)} className="w-full px-3 py-2 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1">Currency</label>
              <select value={currency} onChange={e => setCurrency(e.target.value as 'USD' | 'EUR')} className="w-full px-3 py-2 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500">
                <option value="USD">USD</option>
                <option value="EUR">EUR</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1">Issue Date</label>
              <input type="date" value={issueDate} onChange={e => setIssueDate(e.target.value)} className="w-full px-3 py-2 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-muted-foreground mb-1">Due Date</label>
              <input type="date" value={dueDate} onChange={e => setDueDate(e.target.value)} className="w-full px-3 py-2 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500" />
            </div>
            <div className="flex items-end">
              <label className="flex items-center gap-2 text-sm cursor-pointer">
                <input type="checkbox" checked={markPaid} onChange={e => setMarkPaid(e.target.checked)} className="rounded border-gray-300" />
                Already paid
              </label>
            </div>
          </div>

          <div>
            <label className="block text-xs font-medium text-muted-foreground mb-1">Notes</label>
            <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={2} className="w-full px-3 py-2 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none" />
          </div>
        </div>

        <div className="flex justify-end gap-2 mt-5">
          <button onClick={onClose} className="px-4 py-2 text-sm border rounded-lg hover:bg-muted">Cancel</button>
          <button
            onClick={handleSubmit}
            disabled={isPending}
            className="flex items-center gap-2 px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
          >
            {isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
            Create Expense
          </button>
        </div>
      </div>
    </div>
  )
}
