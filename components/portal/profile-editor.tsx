'use client'

import { useState } from 'react'
import { Save, Loader2, Pencil, X } from 'lucide-react'
import { toast } from 'sonner'
import { useRouter } from 'next/navigation'

interface ProfileEditorProps {
  contactId: string
  initialData: {
    full_name: string
    email: string
    phone: string
    language: string
    citizenship: string
    residency: string
  }
}

export function ProfileEditor({ contactId, initialData }: ProfileEditorProps) {
  const router = useRouter()
  const [editing, setEditing] = useState(false)
  const [saving, setSaving] = useState(false)
  const [data, setData] = useState(initialData)

  const handleSave = async () => {
    setSaving(true)
    try {
      const res = await fetch('/api/portal/profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ contact_id: contactId, ...data }),
      })
      if (!res.ok) throw new Error('Failed to save')
      toast.success('Profile updated')
      setEditing(false)
      router.refresh()
    } catch {
      toast.error('Failed to save profile')
    } finally {
      setSaving(false)
    }
  }

  if (!editing) {
    return (
      <div className="space-y-3">
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-sm">
          <Field label="Full Name" value={data.full_name} />
          <Field label="Email" value={data.email} />
          <Field label="Phone" value={data.phone} />
          <Field label="Language" value={data.language} />
          <Field label="Citizenship" value={data.citizenship} />
          <Field label="Residency" value={data.residency} />
        </div>
        <button
          onClick={() => setEditing(true)}
          className="flex items-center gap-2 text-sm text-blue-600 hover:text-blue-700"
        >
          <Pencil className="h-3.5 w-3.5" />
          Edit
        </button>
      </div>
    )
  }

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <EditField label="Full Name" value={data.full_name} onChange={v => setData(d => ({ ...d, full_name: v }))} />
        <EditField label="Email" value={data.email} onChange={v => setData(d => ({ ...d, email: v }))} disabled />
        <EditField label="Phone" value={data.phone} onChange={v => setData(d => ({ ...d, phone: v }))} placeholder="+1 555 123 4567" />
        <EditField label="Language" value={data.language} onChange={v => setData(d => ({ ...d, language: v }))} placeholder="English, Italian" />
        <EditField label="Citizenship" value={data.citizenship} onChange={v => setData(d => ({ ...d, citizenship: v }))} />
        <EditField label="Residency" value={data.residency} onChange={v => setData(d => ({ ...d, residency: v }))} />
      </div>
      <div className="flex gap-2">
        <button
          onClick={handleSave}
          disabled={saving}
          className="flex items-center gap-2 px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
        >
          {saving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
          Save
        </button>
        <button
          onClick={() => { setEditing(false); setData(initialData) }}
          className="flex items-center gap-2 px-4 py-2 text-sm border rounded-lg hover:bg-zinc-50"
        >
          <X className="h-4 w-4" />
          Cancel
        </button>
      </div>
    </div>
  )
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <p className="text-xs text-zinc-500 mb-0.5">{label}</p>
      <p className="font-medium text-zinc-900">{value || '\u2014'}</p>
    </div>
  )
}

function EditField({ label, value, onChange, disabled, placeholder }: {
  label: string; value: string; onChange: (v: string) => void; disabled?: boolean; placeholder?: string
}) {
  return (
    <div>
      <label className="block text-xs text-zinc-500 mb-1">{label}</label>
      <input
        type="text"
        value={value}
        onChange={e => onChange(e.target.value)}
        disabled={disabled}
        placeholder={placeholder}
        className="w-full px-3 py-2 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-zinc-50 disabled:text-zinc-400"
      />
    </div>
  )
}
