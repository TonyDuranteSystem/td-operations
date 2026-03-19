'use client'

import { useState, useEffect, useTransition } from 'react'
import { useParams, useRouter } from 'next/navigation'
import Link from 'next/link'
import {
  ArrowLeft, User, Mail, MapPin, FileText, Receipt,
  Pencil, Save, X, Loader2, Trash2,
} from 'lucide-react'
import { toast } from 'sonner'
import { format, parseISO } from 'date-fns'
import { cn } from '@/lib/utils'

interface Customer {
  id: string
  name: string
  email: string | null
  address: string | null
  vat_number: string | null
  notes: string | null
}

interface Invoice {
  id: string
  invoice_number: string
  status: string
  currency: string
  total: number
  issue_date: string
}

const STATUS_COLORS: Record<string, string> = {
  Draft: 'bg-zinc-100 text-zinc-700',
  Sent: 'bg-blue-100 text-blue-700',
  Paid: 'bg-emerald-100 text-emerald-700',
  Overdue: 'bg-red-100 text-red-700',
  Cancelled: 'bg-zinc-100 text-zinc-500',
}

export default function CustomerDetailPage() {
  const params = useParams()
  const router = useRouter()
  const customerId = params.id as string

  const [customer, setCustomer] = useState<Customer | null>(null)
  const [invoices, setInvoices] = useState<Invoice[]>([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [editData, setEditData] = useState<Customer | null>(null)

  useEffect(() => {
    async function load() {
      const res = await fetch(`/api/portal/customers/${customerId}`)
      if (!res.ok) { setLoading(false); return }
      const data = await res.json()
      setCustomer(data.customer)
      setInvoices(data.invoices ?? [])
      setEditData(data.customer)
      setLoading(false)
    }
    load()
  }, [customerId])

  const handleSave = async () => {
    if (!editData) return
    setSaving(true)
    try {
      const res = await fetch(`/api/portal/customers/${customerId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(editData),
      })
      if (!res.ok) throw new Error('Failed to save')
      setCustomer(editData)
      setEditing(false)
      toast.success('Customer updated')
    } catch {
      toast.error('Failed to save')
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async () => {
    if (!confirm('Delete this customer? This cannot be undone.')) return
    try {
      const res = await fetch(`/api/portal/customers/${customerId}`, { method: 'DELETE' })
      if (!res.ok) throw new Error('Failed to delete')
      toast.success('Customer deleted')
      router.push('/portal/customers')
    } catch {
      toast.error('Cannot delete — customer may have invoices')
    }
  }

  if (loading) return <div className="p-8 flex justify-center"><Loader2 className="h-6 w-6 animate-spin text-blue-600" /></div>
  if (!customer) return <div className="p-8 text-center"><p className="text-zinc-500">Customer not found</p></div>

  const csym = (c: string) => c === 'EUR' ? '\u20AC' : '$'

  return (
    <div className="p-6 lg:p-8 max-w-4xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-4">
          <Link href="/portal/customers" className="p-2 rounded-lg hover:bg-zinc-100">
            <ArrowLeft className="h-5 w-5" />
          </Link>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight text-zinc-900">{customer.name}</h1>
            {customer.email && <p className="text-sm text-zinc-500">{customer.email}</p>}
          </div>
        </div>
        <div className="flex gap-2">
          {!editing ? (
            <button onClick={() => { setEditData(customer); setEditing(true) }} className="flex items-center gap-2 px-4 py-2 text-sm border rounded-lg hover:bg-zinc-50">
              <Pencil className="h-4 w-4" /> Edit
            </button>
          ) : (
            <>
              <button onClick={handleSave} disabled={saving} className="flex items-center gap-2 px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50">
                {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />} Save
              </button>
              <button onClick={() => { setEditing(false); setEditData(customer) }} className="flex items-center gap-2 px-4 py-2 text-sm border rounded-lg hover:bg-zinc-50">
                <X className="h-4 w-4" /> Cancel
              </button>
            </>
          )}
          <button onClick={handleDelete} className="p-2 text-red-400 hover:text-red-600 hover:bg-red-50 rounded-lg">
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* Customer Info */}
      <div className="bg-white rounded-xl border shadow-sm p-6">
        {editing && editData ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <EditField label="Name" value={editData.name} onChange={v => setEditData({ ...editData, name: v })} />
            <EditField label="Email" value={editData.email ?? ''} onChange={v => setEditData({ ...editData, email: v })} />
            <EditField label="Address" value={editData.address ?? ''} onChange={v => setEditData({ ...editData, address: v })} />
            <EditField label="VAT Number" value={editData.vat_number ?? ''} onChange={v => setEditData({ ...editData, vat_number: v })} />
            <div className="sm:col-span-2">
              <EditField label="Notes" value={editData.notes ?? ''} onChange={v => setEditData({ ...editData, notes: v })} />
            </div>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-sm">
            <InfoRow icon={User} label="Name" value={customer.name} />
            <InfoRow icon={Mail} label="Email" value={customer.email ?? '\u2014'} />
            <InfoRow icon={MapPin} label="Address" value={customer.address ?? '\u2014'} />
            <InfoRow icon={FileText} label="VAT" value={customer.vat_number ?? '\u2014'} />
            {customer.notes && <div className="sm:col-span-2"><InfoRow icon={FileText} label="Notes" value={customer.notes} /></div>}
          </div>
        )}
      </div>

      {/* Invoices for this customer */}
      <div className="bg-white rounded-xl border shadow-sm p-6">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-sm font-semibold text-zinc-900 uppercase tracking-wide">Invoices ({invoices.length})</h2>
          <Link href="/portal/invoices/new" className="text-sm text-blue-600 hover:text-blue-700">New Invoice</Link>
        </div>
        {invoices.length === 0 ? (
          <p className="text-sm text-zinc-400 text-center py-4">No invoices for this customer yet</p>
        ) : (
          <div className="divide-y">
            {invoices.map(inv => (
              <Link key={inv.id} href={`/portal/invoices/${inv.id}`} className="flex items-center justify-between py-3 hover:bg-zinc-50 -mx-2 px-2 rounded-lg">
                <div>
                  <p className="text-sm font-medium text-zinc-900">{inv.invoice_number}</p>
                  <p className="text-xs text-zinc-500">{format(parseISO(inv.issue_date), 'MMM d, yyyy')}</p>
                </div>
                <div className="flex items-center gap-3">
                  <span className={cn('text-xs px-2 py-0.5 rounded-full', STATUS_COLORS[inv.status] ?? 'bg-zinc-100')}>
                    {inv.status}
                  </span>
                  <span className="text-sm font-medium">{csym(inv.currency)}{inv.total.toFixed(2)}</span>
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function InfoRow({ icon: Icon, label, value }: { icon: React.ElementType; label: string; value: string }) {
  return (
    <div className="flex items-start gap-2">
      <Icon className="h-4 w-4 text-zinc-400 mt-0.5 shrink-0" />
      <div>
        <p className="text-xs text-zinc-500">{label}</p>
        <p className="font-medium text-zinc-900">{value}</p>
      </div>
    </div>
  )
}

function EditField({ label, value, onChange }: { label: string; value: string; onChange: (v: string) => void }) {
  return (
    <div>
      <label className="block text-xs text-zinc-500 mb-1">{label}</label>
      <input type="text" value={value} onChange={e => onChange(e.target.value)} className="w-full px-3 py-2 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500" />
    </div>
  )
}
