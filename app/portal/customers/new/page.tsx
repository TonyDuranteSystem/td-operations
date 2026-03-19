'use client'

import { useState, useEffect } from 'react'
import { useRouter } from 'next/navigation'
import Link from 'next/link'
import { ArrowLeft, Save, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { createCustomer } from '@/app/portal/invoices/actions'

export default function NewCustomerPage() {
  const router = useRouter()
  const [accountId, setAccountId] = useState('')
  const [saving, setSaving] = useState(false)
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [address, setAddress] = useState('')
  const [vatNumber, setVatNumber] = useState('')
  const [notes, setNotes] = useState('')

  useEffect(() => {
    const match = document.cookie.match(/portal_account_id=([^;]+)/)
    if (match) setAccountId(match[1])
  }, [])

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!name.trim()) { toast.error('Name is required'); return }
    if (!accountId) { toast.error('No account selected'); return }

    setSaving(true)
    const result = await createCustomer({
      account_id: accountId,
      name: name.trim(),
      email: email.trim() || undefined,
      address: address.trim() || undefined,
      vat_number: vatNumber.trim() || undefined,
      notes: notes.trim() || undefined,
    })
    setSaving(false)

    if (result.success) {
      toast.success('Customer created')
      router.push('/portal/customers')
    } else {
      toast.error(result.error ?? 'Failed to create customer')
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
        <div>
          <label className="block text-sm font-medium text-zinc-700 mb-1.5">Name *</label>
          <input type="text" value={name} onChange={e => setName(e.target.value)} required autoFocus
            className="w-full px-3 py-2.5 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500" />
        </div>
        <div>
          <label className="block text-sm font-medium text-zinc-700 mb-1.5">Email</label>
          <input type="email" value={email} onChange={e => setEmail(e.target.value)}
            placeholder="customer@example.com"
            className="w-full px-3 py-2.5 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500" />
        </div>
        <div>
          <label className="block text-sm font-medium text-zinc-700 mb-1.5">Address</label>
          <input type="text" value={address} onChange={e => setAddress(e.target.value)}
            className="w-full px-3 py-2.5 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500" />
        </div>
        <div>
          <label className="block text-sm font-medium text-zinc-700 mb-1.5">VAT Number</label>
          <input type="text" value={vatNumber} onChange={e => setVatNumber(e.target.value)}
            className="w-full px-3 py-2.5 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500" />
        </div>
        <div>
          <label className="block text-sm font-medium text-zinc-700 mb-1.5">Notes</label>
          <textarea value={notes} onChange={e => setNotes(e.target.value)} rows={2}
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
