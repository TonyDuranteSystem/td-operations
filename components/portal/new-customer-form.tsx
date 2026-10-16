'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft, Save, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { useLocale } from '@/lib/portal/use-locale'
import { formatCustomerAddress } from '@/lib/portal/customer-address'

export function NewCustomerForm({ accountId }: { accountId: string }) {
  const router = useRouter()
  const { t } = useLocale()
  const [saving, setSaving] = useState(false)
  const [form, setForm] = useState({
    first_name: '',
    last_name: '',
    company_name: '',
    email: '',
    phone: '',
    address: '',
    postal_code: '',
    city: '',
    region: '',
    country: '',
    vat_number: '',
    notes: '',
  })

  const update = (field: string, value: string) => setForm(f => ({ ...f, [field]: value }))

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!form.first_name.trim() && !form.company_name.trim()) {
      toast.error(t('custForm.nameRequired'))
      return
    }

    setSaving(true)
    try {
      const displayName = form.company_name.trim()
        || `${form.first_name.trim()} ${form.last_name.trim()}`.trim()
      const fullAddress = formatCustomerAddress({
        street: form.address, postalCode: form.postal_code, city: form.city, region: form.region, country: form.country,
      })

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
          postal_code: form.postal_code.trim() || null,
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
      toast.success(t('invForm.customerCreated'))
      router.push('/portal/customers')
    } catch (err) {
      toast.error(err instanceof Error ? err.message : t('invForm.customerFailed'))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <Link href="/portal/customers" className="p-2 rounded-lg hover:bg-zinc-100">
          <ArrowLeft className="h-5 w-5" />
        </Link>
        <h1 className="text-2xl font-semibold tracking-tight text-zinc-900">{t('custForm.title')}</h1>
      </div>

      <form onSubmit={handleSubmit} className="bg-white rounded-xl border shadow-sm p-6 space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <Field label={t('customers.firstName')} value={form.first_name} onChange={v => update('first_name', v)} />
          <Field label={t('customers.lastName')} value={form.last_name} onChange={v => update('last_name', v)} />
        </div>
        <Field label={t('custForm.companyName')} value={form.company_name} onChange={v => update('company_name', v)} placeholder={t('custForm.companyPlaceholder')} />
        <div className="grid grid-cols-2 gap-4">
          <Field label={t('customers.email')} value={form.email} onChange={v => update('email', v)} type="email" />
          <Field label={t('customers.phone')} value={form.phone} onChange={v => update('phone', v)} type="tel" />
        </div>
        <Field label={t('customers.address')} value={form.address} onChange={v => update('address', v)} placeholder={t('custForm.streetPlaceholder')} />
        <div className="grid grid-cols-2 gap-4">
          <Field label={t('customers.postalCode')} value={form.postal_code} onChange={v => update('postal_code', v)} />
          <Field label={t('customers.city')} value={form.city} onChange={v => update('city', v)} />
        </div>
        <div className="grid grid-cols-2 gap-4">
          <Field label={t('custForm.regionState')} value={form.region} onChange={v => update('region', v)} />
          <Field label={t('customers.country')} value={form.country} onChange={v => update('country', v)} />
        </div>
        <Field label={t('customers.vat')} value={form.vat_number} onChange={v => update('vat_number', v)} hint={t('customers.vatHint')} />
        <div>
          <label className="block text-sm font-medium text-zinc-700 mb-1.5">{t('customers.notes')}</label>
          <textarea value={form.notes} onChange={e => update('notes', e.target.value)} rows={2}
            className="w-full px-3 py-2.5 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none" />
        </div>

        <div className="flex justify-end gap-3 pt-2">
          <Link href="/portal/customers" className="px-4 py-2.5 text-sm border rounded-lg hover:bg-zinc-50">{t('common.cancel')}</Link>
          <button type="submit" disabled={saving}
            className="flex items-center gap-2 px-5 py-2.5 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50">
            {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            {t('custForm.create')}
          </button>
        </div>
      </form>
    </div>
  )
}

function Field({ label, value, onChange, type = 'text', placeholder, hint }: {
  label: string; value: string; onChange: (v: string) => void; type?: string; placeholder?: string; hint?: string
}) {
  return (
    <div>
      <label className="block text-sm font-medium text-zinc-700 mb-1.5">{label}</label>
      <input type={type} value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder}
        className="w-full px-3 py-2.5 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500" />
      {hint && <p className="mt-1 text-xs text-zinc-500">{hint}</p>}
    </div>
  )
}
