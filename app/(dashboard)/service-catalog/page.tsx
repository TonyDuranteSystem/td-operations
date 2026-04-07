'use client'

import { useState, useEffect, useCallback } from 'react'
import { Plus, Pencil, Trash2, RotateCcw, Loader2, Package } from 'lucide-react'
import { toast } from 'sonner'

interface ServiceItem {
  id: string
  name: string
  slug: string
  category: string
  pipeline: string | null
  contract_type: string | null
  has_annual: boolean
  default_price: number | null
  default_currency: string | null
  description: string | null
  sort_order: number
  active: boolean
  created_at: string
  updated_at: string
}

const CATEGORY_OPTIONS = [
  { value: 'primary', label: 'Primary (Annual Management)' },
  { value: 'standalone', label: 'Standalone' },
  { value: 'addon', label: 'Add-on' },
]

const CATEGORY_LABELS: Record<string, string> = {
  primary: 'Annual Management',
  standalone: 'Standalone Services',
  addon: 'Add-ons',
}

const CATEGORY_ORDER = ['primary', 'standalone', 'addon']

const emptyForm = {
  name: '',
  slug: '',
  category: 'addon',
  pipeline: '',
  contract_type: '',
  has_annual: false,
  default_price: '',
  default_currency: 'USD',
  description: '',
}

export default function ServiceCatalogPage() {
  const [services, setServices] = useState<ServiceItem[]>([])
  const [loading, setLoading] = useState(true)
  const [showInactive, setShowInactive] = useState(false)
  const [modalOpen, setModalOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [form, setForm] = useState(emptyForm)

  const fetchServices = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(`/api/service-catalog?include_inactive=${showInactive}`)
      const data = await res.json()
      setServices(data.services ?? [])
    } catch {
      toast.error('Failed to load services')
    } finally {
      setLoading(false)
    }
  }, [showInactive])

  useEffect(() => { fetchServices() }, [fetchServices])

  const openAdd = () => {
    setForm(emptyForm)
    setEditingId(null)
    setModalOpen(true)
  }

  const openEdit = (svc: ServiceItem) => {
    setForm({
      name: svc.name,
      slug: svc.slug,
      category: svc.category,
      pipeline: svc.pipeline || '',
      contract_type: svc.contract_type || '',
      has_annual: svc.has_annual,
      default_price: svc.default_price != null ? String(svc.default_price) : '',
      default_currency: svc.default_currency || 'USD',
      description: svc.description || '',
    })
    setEditingId(svc.id)
    setModalOpen(true)
  }

  const handleSave = async () => {
    if (!form.name.trim()) {
      toast.error('Service name is required')
      return
    }
    setSaving(true)
    try {
      const body: Record<string, unknown> = {
        name: form.name.trim(),
        category: form.category,
        pipeline: form.pipeline.trim() || null,
        contract_type: form.contract_type.trim() || null,
        has_annual: form.has_annual,
        default_price: form.default_price ? Number(form.default_price) : null,
        default_currency: form.default_currency,
        description: form.description.trim() || null,
      }

      if (editingId) {
        body.id = editingId
        if (form.slug.trim()) body.slug = form.slug.trim()
      } else {
        if (form.slug.trim()) body.slug = form.slug.trim()
      }

      const res = await fetch('/api/service-catalog', {
        method: editingId ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (!res.ok) {
        toast.error(data.error || 'Failed to save')
        return
      }
      toast.success(editingId ? 'Service updated' : 'Service created')
      setModalOpen(false)
      fetchServices()
    } catch {
      toast.error('Error saving service')
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (id: string) => {
    setDeletingId(id)
    try {
      const res = await fetch('/api/service-catalog', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      })
      if (!res.ok) {
        const data = await res.json()
        toast.error(data.error || 'Failed to deactivate')
        return
      }
      toast.success('Service deactivated')
      fetchServices()
    } catch {
      toast.error('Error deactivating service')
    } finally {
      setDeletingId(null)
    }
  }

  const handleReactivate = async (id: string) => {
    try {
      const res = await fetch('/api/service-catalog', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, active: true }),
      })
      if (!res.ok) {
        const data = await res.json()
        toast.error(data.error || 'Failed to reactivate')
        return
      }
      toast.success('Service reactivated')
      fetchServices()
    } catch {
      toast.error('Error reactivating service')
    }
  }

  const grouped = CATEGORY_ORDER.map(cat => ({
    category: cat,
    label: CATEGORY_LABELS[cat] || cat,
    items: services.filter(s => s.category === cat),
  })).filter(g => g.items.length > 0)

  // Services that don't match known categories
  const otherServices = services.filter(s => !CATEGORY_ORDER.includes(s.category))
  if (otherServices.length > 0) {
    grouped.push({ category: 'other', label: 'Other', items: otherServices })
  }

  return (
    <div className="max-w-5xl mx-auto px-6 py-8">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center gap-3">
          <Package className="h-6 w-6 text-blue-600" />
          <h1 className="text-2xl font-bold">Service Catalog</h1>
          <span className="text-sm text-muted-foreground">
            {services.length} service{services.length !== 1 ? 's' : ''}
          </span>
        </div>
        <div className="flex items-center gap-3">
          <label className="flex items-center gap-2 text-sm text-muted-foreground">
            <input
              type="checkbox"
              checked={showInactive}
              onChange={e => setShowInactive(e.target.checked)}
              className="rounded border-zinc-300"
            />
            Show inactive
          </label>
          <button
            onClick={openAdd}
            className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded-md bg-blue-600 text-white hover:bg-blue-700"
          >
            <Plus className="h-4 w-4" />
            Add Service
          </button>
        </div>
      </div>

      {/* Loading */}
      {loading && (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </div>
      )}

      {/* Service Groups */}
      {!loading && grouped.map(group => (
        <div key={group.category} className="mb-8">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground mb-3">
            {group.label}
          </h2>
          <div className="bg-white border rounded-lg divide-y">
            {group.items.map(svc => (
              <div
                key={svc.id}
                className={`flex items-center gap-4 px-4 py-3 ${!svc.active ? 'opacity-50' : ''}`}
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium truncate">{svc.name}</span>
                    <span className="text-xs text-muted-foreground font-mono">{svc.slug}</span>
                    {!svc.active && (
                      <span className="text-xs bg-red-100 text-red-700 px-1.5 py-0.5 rounded">Inactive</span>
                    )}
                  </div>
                  <div className="flex items-center gap-3 mt-0.5">
                    {svc.pipeline && (
                      <span className="text-xs text-blue-600">Pipeline: {svc.pipeline}</span>
                    )}
                    {svc.contract_type && (
                      <span className="text-xs text-purple-600">Contract: {svc.contract_type}</span>
                    )}
                    {svc.has_annual && (
                      <span className="text-xs text-green-600">Annual</span>
                    )}
                    {svc.default_price != null && (
                      <span className="text-xs text-zinc-500">
                        {svc.default_currency === 'EUR' ? '\u20AC' : '$'}{svc.default_price}
                      </span>
                    )}
                    {svc.description && (
                      <span className="text-xs text-zinc-400 truncate max-w-[200px]">{svc.description}</span>
                    )}
                  </div>
                </div>
                <div className="flex items-center gap-1">
                  <button
                    onClick={() => openEdit(svc)}
                    className="p-1.5 rounded hover:bg-zinc-100 text-zinc-500"
                    title="Edit"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                  </button>
                  {svc.active ? (
                    <button
                      onClick={() => handleDelete(svc.id)}
                      disabled={deletingId === svc.id}
                      className="p-1.5 rounded hover:bg-red-50 text-zinc-500 hover:text-red-600"
                      title="Deactivate"
                    >
                      {deletingId === svc.id ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <Trash2 className="h-3.5 w-3.5" />
                      )}
                    </button>
                  ) : (
                    <button
                      onClick={() => handleReactivate(svc.id)}
                      className="p-1.5 rounded hover:bg-green-50 text-zinc-500 hover:text-green-600"
                      title="Reactivate"
                    >
                      <RotateCcw className="h-3.5 w-3.5" />
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}

      {!loading && services.length === 0 && (
        <div className="text-center py-12 text-muted-foreground">
          <Package className="h-10 w-10 mx-auto mb-3 opacity-30" />
          <p className="text-sm">No services found. Add your first service to get started.</p>
        </div>
      )}

      {/* Add/Edit Modal */}
      {modalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-lg mx-4 max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between p-5 border-b">
              <h2 className="text-lg font-semibold">{editingId ? 'Edit Service' : 'Add Service'}</h2>
              <button onClick={() => setModalOpen(false)} className="p-1 rounded hover:bg-zinc-100 text-zinc-500">
                &times;
              </button>
            </div>
            <div className="p-5 space-y-4">
              {/* Name */}
              <div>
                <label className="block text-xs font-medium mb-1">Name *</label>
                <input
                  type="text"
                  value={form.name}
                  onChange={e => setForm(f => ({ ...f, name: e.target.value }))}
                  placeholder="e.g. Certificate of Incumbency"
                  className="w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>

              {/* Slug */}
              <div>
                <label className="block text-xs font-medium mb-1">Slug {editingId ? '' : '(auto-generated if empty)'}</label>
                <input
                  type="text"
                  value={form.slug}
                  onChange={e => setForm(f => ({ ...f, slug: e.target.value }))}
                  placeholder="certificate_of_incumbency"
                  className="w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 font-mono"
                />
              </div>

              {/* Category */}
              <div>
                <label className="block text-xs font-medium mb-1">Category</label>
                <select
                  value={form.category}
                  onChange={e => setForm(f => ({ ...f, category: e.target.value }))}
                  className="w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                >
                  {CATEGORY_OPTIONS.map(o => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
              </div>

              {/* Pipeline + Contract Type */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium mb-1">Pipeline</label>
                  <input
                    type="text"
                    value={form.pipeline}
                    onChange={e => setForm(f => ({ ...f, pipeline: e.target.value }))}
                    placeholder="e.g. Company Formation"
                    className="w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1">Contract Type</label>
                  <input
                    type="text"
                    value={form.contract_type}
                    onChange={e => setForm(f => ({ ...f, contract_type: e.target.value }))}
                    placeholder="e.g. formation"
                    className="w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                  />
                </div>
              </div>

              {/* Has Annual + Default Price */}
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="flex items-center gap-2 text-xs font-medium mt-2">
                    <input
                      type="checkbox"
                      checked={form.has_annual}
                      onChange={e => setForm(f => ({ ...f, has_annual: e.target.checked }))}
                      className="rounded border-zinc-300"
                    />
                    Has Annual Renewal
                  </label>
                </div>
                <div>
                  <label className="block text-xs font-medium mb-1">Default Price</label>
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={form.default_price}
                      onChange={e => setForm(f => ({ ...f, default_price: e.target.value }))}
                      placeholder="0"
                      className="flex-1 px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                    />
                    <select
                      value={form.default_currency}
                      onChange={e => setForm(f => ({ ...f, default_currency: e.target.value }))}
                      className="w-20 px-2 py-2 text-sm border rounded-md"
                    >
                      <option value="USD">USD</option>
                      <option value="EUR">EUR</option>
                    </select>
                  </div>
                </div>
              </div>

              {/* Description */}
              <div>
                <label className="block text-xs font-medium mb-1">Description</label>
                <textarea
                  value={form.description}
                  onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
                  rows={2}
                  placeholder="Brief description of this service..."
                  className="w-full px-3 py-2 text-sm border rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 resize-none"
                />
              </div>
            </div>

            {/* Footer */}
            <div className="flex justify-end gap-3 p-5 border-t">
              <button
                onClick={() => setModalOpen(false)}
                className="px-4 py-2 text-sm border rounded-md hover:bg-zinc-50"
              >
                Cancel
              </button>
              <button
                onClick={handleSave}
                disabled={saving}
                className="inline-flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded-md bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
              >
                {saving && <Loader2 className="h-4 w-4 animate-spin" />}
                {editingId ? 'Save Changes' : 'Create Service'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
