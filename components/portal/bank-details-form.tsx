'use client'

import { useState } from 'react'
import { Loader2, Save, Landmark } from 'lucide-react'
import { toast } from 'sonner'
import { useRouter } from 'next/navigation'

interface BankDetails {
  account_holder?: string
  bank_name?: string
  iban?: string
  swift_bic?: string
  account_number?: string
  routing_number?: string
  notes?: string
}

interface BankDetailsFormProps {
  accountId: string
  initialData: BankDetails | null
}

export function BankDetailsForm({ accountId, initialData }: BankDetailsFormProps) {
  const router = useRouter()
  const [saving, setSaving] = useState(false)
  const [data, setData] = useState<BankDetails>({
    account_holder: initialData?.account_holder ?? '',
    bank_name: initialData?.bank_name ?? '',
    iban: initialData?.iban ?? '',
    swift_bic: initialData?.swift_bic ?? '',
    account_number: initialData?.account_number ?? '',
    routing_number: initialData?.routing_number ?? '',
    notes: initialData?.notes ?? '',
  })

  const update = (field: keyof BankDetails, value: string) => {
    setData(prev => ({ ...prev, [field]: value }))
  }

  const handleSave = async () => {
    setSaving(true)
    try {
      const res = await fetch('/api/portal/payment-settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account_id: accountId, bank_details: data }),
      })
      if (!res.ok) throw new Error('Failed to save')
      toast.success('Bank details saved')
      router.refresh()
    } catch {
      toast.error('Failed to save bank details')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        <Field label="Account Holder" value={data.account_holder ?? ''} onChange={v => update('account_holder', v)} placeholder="John Doe" />
        <Field label="Bank Name" value={data.bank_name ?? ''} onChange={v => update('bank_name', v)} placeholder="Chase, Deutsche Bank..." />
        <Field label="IBAN" value={data.iban ?? ''} onChange={v => update('iban', v)} placeholder="DE89 3704 0044 0532 0130 00" />
        <Field label="SWIFT / BIC" value={data.swift_bic ?? ''} onChange={v => update('swift_bic', v)} placeholder="COBADEFFXXX" />
        <Field label="Account Number" value={data.account_number ?? ''} onChange={v => update('account_number', v)} placeholder="For domestic transfers" />
        <Field label="Routing Number" value={data.routing_number ?? ''} onChange={v => update('routing_number', v)} placeholder="For US domestic transfers" />
      </div>
      <Field label="Additional Notes" value={data.notes ?? ''} onChange={v => update('notes', v)} placeholder="Payment reference, special instructions..." />
      <p className="text-xs text-zinc-400">These details will appear on your invoices automatically.</p>
      <button
        onClick={handleSave}
        disabled={saving}
        className="flex items-center gap-2 px-5 py-2.5 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 transition-colors"
      >
        {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
        Save Bank Details
      </button>
    </div>
  )
}

function Field({ label, value, onChange, placeholder }: { label: string; value: string; onChange: (v: string) => void; placeholder?: string }) {
  return (
    <div>
      <label className="block text-xs font-medium text-zinc-600 mb-1">{label}</label>
      <input
        type="text"
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        className="w-full px-3 py-2 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
      />
    </div>
  )
}
