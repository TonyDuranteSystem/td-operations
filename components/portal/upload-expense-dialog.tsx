'use client'

import { useState, useRef } from 'react'
import { X, Upload, Loader2, FileText } from 'lucide-react'
import { createExpense } from '@/app/portal/invoices/expense-actions'
import { toast } from 'sonner'
import type { Vendor } from '@/app/portal/invoices/vendor-actions'

interface UploadExpenseDialogProps {
  open: boolean
  onClose: () => void
  accountId: string
  vendors: Vendor[]
  locale: string
}

export function UploadExpenseDialog({ open, onClose, accountId, vendors, locale }: UploadExpenseDialogProps) {
  const isIt = locale === 'it'
  const fileRef = useRef<HTMLInputElement>(null)
  const [saving, setSaving] = useState(false)
  const [file, setFile] = useState<File | null>(null)
  const [uploading, setUploading] = useState(false)
  const [form, setForm] = useState({
    vendor_id: '',
    vendor_name: '',
    invoice_number: '',
    description: '',
    currency: 'USD' as 'USD' | 'EUR',
    total: '',
    issue_date: new Date().toISOString().split('T')[0],
    due_date: '',
    category: 'General',
  })

  if (!open) return null

  const selectedVendor = vendors.find(v => v.id === form.vendor_id)

  const handleVendorChange = (vendorId: string) => {
    const vendor = vendors.find(v => v.id === vendorId)
    setForm(f => ({
      ...f,
      vendor_id: vendorId,
      vendor_name: vendor?.name ?? '',
    }))
  }

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0]
    if (f) setFile(f)
  }

  const uploadFile = async (): Promise<{ url: string; name: string } | null> => {
    if (!file) return null
    setUploading(true)
    try {
      // Get signed upload URL
      const res = await fetch('/api/portal/documents/upload-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ account_id: accountId, file_name: file.name }),
      })
      if (!res.ok) throw new Error('Failed to get upload URL')
      const { signedUrl, path } = await res.json()

      // Upload directly to Supabase Storage
      const uploadRes = await fetch(signedUrl, {
        method: 'PUT',
        headers: { 'Content-Type': file.type },
        body: file,
      })
      if (!uploadRes.ok) throw new Error('Upload failed')

      // Construct public URL
      const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
      const publicUrl = `${supabaseUrl}/storage/v1/object/public/portal-uploads/${path}`

      return { url: publicUrl, name: file.name }
    } finally {
      setUploading(false)
    }
  }

  const handleSubmit = async () => {
    if (!form.vendor_name && !form.vendor_id) {
      toast.error(isIt ? 'Seleziona un fornitore' : 'Select a vendor')
      return
    }
    if (!form.total || Number(form.total) <= 0) {
      toast.error(isIt ? 'Importo obbligatorio' : 'Amount is required')
      return
    }

    setSaving(true)
    try {
      let attachment: { url: string; name: string } | null = null
      if (file) {
        attachment = await uploadFile()
      }

      const vendorName = selectedVendor?.name ?? form.vendor_name
      const res = await createExpense({
        account_id: accountId,
        vendor_name: vendorName,
        vendor_id: form.vendor_id || undefined,
        invoice_number: form.invoice_number || undefined,
        description: form.description || undefined,
        currency: form.currency,
        total: Number(form.total),
        issue_date: form.issue_date || undefined,
        due_date: form.due_date || undefined,
        category: form.category || undefined,
        source: file ? 'upload' : 'manual',
        attachment_url: attachment?.url,
        attachment_name: attachment?.name,
      })

      if (!res.success) throw new Error(res.error)
      toast.success(isIt ? 'Spesa registrata' : 'Expense recorded')
      onClose()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Error')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
        <div className="flex items-center justify-between p-5 border-b">
          <h2 className="text-lg font-semibold text-zinc-900">
            {isIt ? 'Registra Spesa' : 'Record Expense'}
          </h2>
          <button onClick={onClose} className="p-1 hover:bg-zinc-100 rounded">
            <X className="h-5 w-5 text-zinc-400" />
          </button>
        </div>

        <div className="p-5 space-y-4">
          {/* Vendor */}
          <div>
            <label className="block text-xs font-medium text-zinc-600 mb-1">{isIt ? 'Fornitore *' : 'Vendor *'}</label>
            {vendors.length > 0 ? (
              <select
                value={form.vendor_id}
                onChange={e => handleVendorChange(e.target.value)}
                className="w-full px-3 py-2 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
              >
                <option value="">{isIt ? '— Seleziona fornitore —' : '— Select vendor —'}</option>
                {vendors.map(v => (
                  <option key={v.id} value={v.id}>{v.name}</option>
                ))}
              </select>
            ) : (
              <input
                value={form.vendor_name}
                onChange={e => setForm(f => ({ ...f, vendor_name: e.target.value }))}
                className="w-full px-3 py-2 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder={isIt ? 'Nome fornitore' : 'Vendor name'}
              />
            )}
          </div>

          {/* Invoice number + Currency */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-zinc-600 mb-1">{isIt ? 'N. Fattura' : 'Invoice #'}</label>
              <input
                value={form.invoice_number}
                onChange={e => setForm(f => ({ ...f, invoice_number: e.target.value }))}
                className="w-full px-3 py-2 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-zinc-600 mb-1">{isIt ? 'Valuta' : 'Currency'}</label>
              <select
                value={form.currency}
                onChange={e => setForm(f => ({ ...f, currency: e.target.value as 'USD' | 'EUR' }))}
                className="w-full px-3 py-2 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
              >
                <option value="USD">USD ($)</option>
                <option value="EUR">EUR (\u20AC)</option>
              </select>
            </div>
          </div>

          {/* Amount + Category */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-zinc-600 mb-1">{isIt ? 'Importo *' : 'Amount *'}</label>
              <input
                type="number"
                step="0.01"
                min="0"
                value={form.total}
                onChange={e => setForm(f => ({ ...f, total: e.target.value }))}
                className="w-full px-3 py-2 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="0.00"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-zinc-600 mb-1">{isIt ? 'Categoria' : 'Category'}</label>
              <select
                value={form.category}
                onChange={e => setForm(f => ({ ...f, category: e.target.value }))}
                className="w-full px-3 py-2 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white"
              >
                <option value="General">General</option>
                <option value="Software">Software</option>
                <option value="Advertising">Advertising</option>
                <option value="Professional Services">Professional Services</option>
                <option value="Office">Office</option>
                <option value="Shipping">Shipping</option>
                <option value="Taxes & Fees">Taxes & Fees</option>
                <option value="Other">Other</option>
              </select>
            </div>
          </div>

          {/* Dates */}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-zinc-600 mb-1">{isIt ? 'Data Emissione' : 'Issue Date'}</label>
              <input
                type="date"
                value={form.issue_date}
                onChange={e => setForm(f => ({ ...f, issue_date: e.target.value }))}
                className="w-full px-3 py-2 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-zinc-600 mb-1">{isIt ? 'Scadenza' : 'Due Date'}</label>
              <input
                type="date"
                value={form.due_date}
                onChange={e => setForm(f => ({ ...f, due_date: e.target.value }))}
                className="w-full px-3 py-2 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
          </div>

          {/* Description */}
          <div>
            <label className="block text-xs font-medium text-zinc-600 mb-1">{isIt ? 'Descrizione' : 'Description'}</label>
            <input
              value={form.description}
              onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
              className="w-full px-3 py-2 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>

          {/* File Upload */}
          <div>
            <label className="block text-xs font-medium text-zinc-600 mb-1">{isIt ? 'Allegato (PDF/Immagine)' : 'Attachment (PDF/Image)'}</label>
            <input
              ref={fileRef}
              type="file"
              accept=".pdf,.jpg,.jpeg,.png,.webp"
              onChange={handleFileChange}
              className="hidden"
            />
            {file ? (
              <div className="flex items-center gap-2 px-3 py-2 border rounded-lg bg-blue-50 text-sm">
                <FileText className="h-4 w-4 text-blue-600 shrink-0" />
                <span className="truncate text-blue-700">{file.name}</span>
                <button onClick={() => setFile(null)} className="ml-auto p-0.5 hover:bg-blue-100 rounded">
                  <X className="h-3.5 w-3.5 text-blue-400" />
                </button>
              </div>
            ) : (
              <button
                onClick={() => fileRef.current?.click()}
                className="w-full flex items-center justify-center gap-2 px-3 py-3 border-2 border-dashed rounded-lg text-sm text-zinc-500 hover:border-blue-300 hover:text-blue-600 transition-colors"
              >
                <Upload className="h-4 w-4" />
                {isIt ? 'Carica fattura' : 'Upload invoice'}
              </button>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="flex justify-end gap-2 p-5 border-t">
          <button onClick={onClose} className="px-4 py-2 text-sm border rounded-lg hover:bg-zinc-50">
            {isIt ? 'Annulla' : 'Cancel'}
          </button>
          <button
            onClick={handleSubmit}
            disabled={saving || uploading}
            className="flex items-center gap-2 px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50"
          >
            {(saving || uploading) && <Loader2 className="h-4 w-4 animate-spin" />}
            {uploading ? (isIt ? 'Caricamento...' : 'Uploading...') : (isIt ? 'Registra' : 'Save')}
          </button>
        </div>
      </div>
    </div>
  )
}
