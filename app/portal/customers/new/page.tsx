'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft, Save, Loader2 } from 'lucide-react'
import { toast } from 'sonner'

export default function NewCustomerPage() {
  const router = useRouter()
  const [accountId, setAccountId] = useState('')
  const [saving, setSaving] = useState(false)
  const [form, setForm] = useState({
    first_name: '',
    last_name: '',
    company_name: '',
    email: '',
    phone: '',
    address: '',
    city: '',
    region: '',
    country: '',
    vat_number: '',
    notes: '',
  })

  useEffect(() => {
    const match = document.cookie.match(/portal_account_id=([^;]+)/)
    if (match) setAccountId(match[1])
  }, [])

  const update = (field: string, value: string) => setForm(f => ({ ...f, [field]: value }))

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!form.first_name.trim() && !form.company_name.trim()) {
      toast.error('First name or company name is required')
      return
    }
    if (!accountId) { toast.error('No account selected'); return }

    setSaving(true)
    try {
      const displayName = form.company_name.trim()
        || `${form.first_name.trim()} ${form.last_name.trim()}`.trim()
      const fullAddress = [form.address, form.city, form.region, form.country]
        .filter(Boolean).join(', ')

      const res = await fetch('/api/portal/customers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          account_id: accountId,
          name: displayName,
          first_name: form.first_name.trim() || null,
          last_name: form.last_name.trim() || null,
          company_name: form.company_name.trim() || null,
          email: form.email.trim() || null,
          phone: form.phone.trim() || null,
          address: fullAddress || null,
          city: form.city.trim() || null,
          region: form.region.trim() || null,
          country: form.country.trim() || null,
          vat_number: form.vat_number.trim() || null,
          notes: form.notes.trim() || null,
        }),
      })
      if (!res.ok) {
        const data = await res.json()
        throw new Error(data.error || 'Failed to create')
      }
      toast.success('Customer created')
      router.push('/portal/customers')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to create customer')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="p-6 lg:p-8 max-w-lg mx-auto space-y-6">
      <div className="flex items-center gap-4">
        <Link href="/portal/customers" className="p-2 rounded-lg hover:bg-zinc-100">
          <ArrowLeft className="h-5 w-5" />
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-900">New Customer</h1>
      </div>

      <form onSubmit={handleSubmit} className="bg-white rounded-xl border shadow-sm p-6 space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <Field label="First Name" value={form.first_name} onChange={v => update('first_name', v)} />
          <Field label="Last Name" value={form.last_name} onChange={v => update('last_name', v)} />
        </div>
        <Field label="Company Name" value={form.company_name} onChange={v => update('company_name', v)} placeholder="Leave empty for individual customers" />
        <div className="grid grid-cols-2 gap-4">
          <Field label="Email" value={form.email} onChange={v => update('email', v)} type="email" />
          <Field label="Phone" value={form.phone} onChange={v => update('phone', v)} type="tel" />
        </div>
        <Field label="Address" value={form.address} onChange={v => update('address', v)} placeholder="Street address" />
        <div className="grid grid-cols-3 gap-4">
          <Field label="City" value={form.city} onChange={v => update('city', v)} />
          <Field label="Region/State" value={form.region} onChange={v => update('region', v)} />
          <Field label="Country" value={form.country} onChange={v => update('country', v)} />
        </div>
        <Field label="VAT Number" value={form.vat_number} onChange={v => update('vat_number', v)} />
        <div>
          <label className="block text-sm font-medium text-zinc-700 mb-1.5">Notes</label>
          <textarea value={form.notes} onChange={e => update('notes', e.target.value)} rows={2}
            className="w-full px-3 py-2.5 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none" />
        </div>

        <div className="flex justify-end gap-3 pt-2">
          <Link href="/portal/customers" className="px-4 py-2.5 text-sm border rounded-lg hover:bg-zinc-50">Cancel</Link>
          <button type="submit" disabled={saving}
            className="flex items-center gap-2 px-5 py-2.5 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50">
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            Create Customer
          </button>
        </div>
      </form>
    </div>
  )
}

function Field({ label, value, onChange, type = 'text', placeholder }: {
  label: string; value: string; onChange: (v: string) => void; type?: string; placeholder?: string
}) {
  return (
    <div>
      <label className="block text-sm font-medium text-zinc-700 mb-1.5">{label}</label>
      <input type={type} value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder}
        className="w-full px-3 py-2.5 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500" />
    </div>
  )
}
