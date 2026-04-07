'use client'

import { useState } from 'react'
import { Search, Plus, Building2, Pencil, Trash2, X, Loader2, Mail, Phone, MapPin, User } from 'lucide-react'
import { createVendor, updateVendor, deleteVendor, type Vendor } from '@/app/portal/invoices/vendor-actions'
import { toast } from 'sonner'

interface VendorListProps {
  vendors: Vendor[]
  accountId: string
  locale: string
}

const EMPTY_FORM = {
  name: '',
  contact_person: '',
  email: '',
  phone: '',
  vat_number: '',
  address: '',
  notes: '',
}

export function VendorList({ vendors: initialVendors, accountId, locale }: VendorListProps) {
  const [search, setSearch] = useState('')
  const [showForm, setShowForm] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [form, setForm] = useState(EMPTY_FORM)
  const [saving, setSaving] = useState(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)

  const isIt = locale === 'it'

  const filtered = initialVendors.filter(v => {
    if (!search) return true
    const q = search.toLowerCase()
    return v.name.toLowerCase().includes(q) ||
      v.email?.toLowerCase().includes(q) ||
      v.contact_person?.toLowerCase().includes(q)
  })

  const openNew = () => {
    setForm(EMPTY_FORM)
    setEditingId(null)
    setShowForm(true)
  }

  const openEdit = (v: Vendor) => {
    setForm({
      name: v.name,
      contact_person: v.contact_person ?? '',
      email: v.email ?? '',
      phone: v.phone ?? '',
      vat_number: v.vat_number ?? '',
      address: v.address ?? '',
      notes: v.notes ?? '',
    })
    setEditingId(v.id)
    setShowForm(true)
  }

  const handleSave = async () => {
    if (!form.name.trim()) {
      toast.error(isIt ? 'Il nome è obbligatorio' : 'Name is required')
      return
    }
    setSaving(true)
    try {
      if (editingId) {
        const res = await updateVendor(editingId, form)
        if (!res.success) throw new Error(res.error)
        toast.success(isIt ? 'Fornitore aggiornato' : 'Vendor updated')
      } else {
        const res = await createVendor({ account_id: accountId, ...form })
        if (!res.success) throw new Error(res.error)
        toast.success(isIt ? 'Fornitore creato' : 'Vendor created')
      }
      setShowForm(false)
      setEditingId(null)
      setForm(EMPTY_FORM)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Error')
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (id: string) => {
    if (!confirm(isIt ? 'Eliminare questo fornitore?' : 'Delete this vendor?')) return
    setDeletingId(id)
    try {
      const res = await deleteVendor(id)
      if (!res.success) throw new Error(res.error)
      toast.success(isIt ? 'Fornitore eliminato' : 'Vendor deleted')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Error')
    } finally {
      setDeletingId(null)
    }
  }

  return (
    <div className="space-y-4">
      {/* Search + Add */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-zinc-400" />
          <input
            type="text"
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder={isIt ? 'Cerca fornitore...' : 'Search vendors...'}
            className="w-full pl-9 pr-3 py-2.5 text-sm border rounded-lg bg-white focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
        </div>
        <button
          onClick={openNew}
          className="flex items-center justify-center gap-2 px-4 py-2.5 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 transition-colors"
        >
          <Plus className="h-4 w-4" />
          {isIt ? 'Nuovo Fornitore' : 'New Vendor'}
        </button>
      </div>

      {/* Vendor Form (inline) */}
      {showForm && (
        <div className="bg-white rounded-xl border shadow-sm p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-zinc-700">
              {editingId ? (isIt ? 'Modifica Fornitore' : 'Edit Vendor') : (isIt ? 'Nuovo Fornitore' : 'New Vendor')}
            </h3>
            <button onClick={() => { setShowForm(false); setEditingId(null) }} className="p-1 hover:bg-zinc-100 rounded">
              <X className="h-4 w-4 text-zinc-400" />
            </button>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-medium text-zinc-600 mb-1">{isIt ? 'Ragione Sociale *' : 'Company Name *'}</label>
              <input
                value={form.name}
                onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                className="w-full px-3 py-2 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="Acme Inc."
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-zinc-600 mb-1">{isIt ? 'Referente' : 'Contact Person'}</label>
              <input
                value={form.contact_person}
                onChange={e => setForm(f => ({ ...f, contact_person: e.target.value }))}
                className="w-full px-3 py-2 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="John Smith"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-zinc-600 mb-1">Email</label>
              <input
                type="email"
                value={form.email}
                onChange={e => setForm(f => ({ ...f, email: e.target.value }))}
                className="w-full px-3 py-2 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="vendor@example.com"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-zinc-600 mb-1">{isIt ? 'Telefono' : 'Phone'}</label>
              <input
                value={form.phone}
                onChange={e => setForm(f => ({ ...f, phone: e.target.value }))}
                className="w-full px-3 py-2 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="+1 555-0123"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-zinc-600 mb-1">{isIt ? 'P.IVA / Tax ID' : 'VAT / Tax ID'}</label>
              <input
                value={form.vat_number}
                onChange={e => setForm(f => ({ ...f, vat_number: e.target.value }))}
                className="w-full px-3 py-2 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="US12-3456789"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-zinc-600 mb-1">{isIt ? 'Indirizzo' : 'Address'}</label>
              <input
                value={form.address}
                onChange={e => setForm(f => ({ ...f, address: e.target.value }))}
                className="w-full px-3 py-2 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="123 Main St, City, State"
              />
            </div>
          </div>
          <div>
            <label className="block text-xs font-medium text-zinc-600 mb-1">{isIt ? 'Note' : 'Notes'}</label>
            <textarea
              value={form.notes}
              onChange={e => setForm(f => ({ ...f, notes: e.target.value }))}
              rows={2}
              className="w-full px-3 py-2 text-sm border rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
            />
          </div>

          <div className="flex justify-end gap-2">
            <button onClick={() => { setShowForm(false); setEditingId(null) }} className="px-4 py-2 text-sm border rounded-lg hover:bg-zinc-50">
              {isIt ? 'Annulla' : 'Cancel'}
            </button>
            <button onClick={handleSave} disabled={saving} className="flex items-center gap-2 px-4 py-2 text-sm bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50">
              {saving && <Loader2 className="h-4 w-4 animate-spin" />}
              {editingId ? (isIt ? 'Salva' : 'Save') : (isIt ? 'Crea' : 'Create')}
            </button>
          </div>
        </div>
      )}

      {/* Vendor Cards */}
      {filtered.length === 0 ? (
        <div className="bg-white rounded-xl border shadow-sm p-12 text-center">
          <Building2 className="h-12 w-12 text-zinc-300 mx-auto mb-3" />
          <h3 className="text-lg font-medium text-zinc-900 mb-1">{isIt ? 'Nessun fornitore' : 'No vendors yet'}</h3>
          <p className="text-sm text-zinc-500">{isIt ? 'Aggiungi i tuoi fornitori per tracciare le spese' : 'Add your vendors to track expenses'}</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {filtered.map(v => (
            <div key={v.id} className="bg-white rounded-xl border shadow-sm p-4 space-y-2 hover:border-blue-200 transition-colors">
              <div className="flex items-start justify-between">
                <div className="flex items-center gap-2 min-w-0">
                  <div className="h-8 w-8 rounded-full bg-blue-50 flex items-center justify-center shrink-0">
                    <Building2 className="h-4 w-4 text-blue-600" />
                  </div>
                  <div className="min-w-0">
                    <p className="font-medium text-sm truncate">{v.name}</p>
                    {v.contact_person && (
                      <p className="text-xs text-zinc-500 flex items-center gap-1">
                        <User className="h-3 w-3" />{v.contact_person}
                      </p>
                    )}
                  </div>
                </div>
                <div className="flex gap-1 shrink-0">
                  <button onClick={() => openEdit(v)} className="p-1.5 rounded hover:bg-zinc-100 text-zinc-400 hover:text-zinc-700">
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                  <button
                    onClick={() => handleDelete(v.id)}
                    disabled={deletingId === v.id}
                    className="p-1.5 rounded hover:bg-red-50 text-zinc-400 hover:text-red-600 disabled:opacity-50"
                  >
                    {deletingId === v.id ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Trash2 className="h-3.5 w-3.5" />}
                  </button>
                </div>
              </div>
              <div className="space-y-0.5 text-xs text-zinc-500">
                {v.email && <p className="flex items-center gap-1.5"><Mail className="h-3 w-3" />{v.email}</p>}
                {v.phone && <p className="flex items-center gap-1.5"><Phone className="h-3 w-3" />{v.phone}</p>}
                {v.address && <p className="flex items-center gap-1.5"><MapPin className="h-3 w-3" /><span className="truncate">{v.address}</span></p>}
                {v.vat_number && <p className="text-zinc-400">VAT: {v.vat_number}</p>}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
