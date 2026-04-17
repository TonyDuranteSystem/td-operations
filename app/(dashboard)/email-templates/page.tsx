'use client'

import { useState, useEffect, useCallback } from 'react'
import { Plus, Pencil, Trash2, RotateCcw, Loader2, Mail, X } from 'lucide-react'
import { toast } from 'sonner'

interface EmailTemplate {
  id: string
  template_name: string
  subject_template: string
  body_template: string
  language: string | null
  category: string | null
  service_type: string | null
  placeholders: string[] | null
  active: boolean
  notes: string | null
  updated_at: string | null
}

const CATEGORY_SUGGESTIONS = [
  'Payment',
  'Documents',
  'Follow-up',
  'Onboarding',
  'Tax',
  'Banking',
  'Portal',
  'Other',
]

const LANGUAGE_OPTIONS = [
  { value: '', label: '-- any --' },
  { value: 'it', label: 'Italian (it)' },
  { value: 'en', label: 'English (en)' },
]

interface FormState {
  template_name: string
  subject_template: string
  body_template: string
  language: string
  category: string
  placeholders: string
  notes: string
}

const emptyForm: FormState = {
  template_name: '',
  subject_template: '',
  body_template: '',
  language: '',
  category: '',
  placeholders: '',
  notes: '',
}

export default function EmailTemplatesPage() {
  const [templates, setTemplates] = useState<EmailTemplate[]>([])
  const [loading, setLoading] = useState(true)
  const [showInactive, setShowInactive] = useState(false)
  const [modalOpen, setModalOpen] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [deletingId, setDeletingId] = useState<string | null>(null)
  const [form, setForm] = useState<FormState>(emptyForm)

  const fetchTemplates = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(`/api/inbox/templates?include_inactive=${showInactive}`)
      const data = await res.json()
      setTemplates(data.templates ?? [])
    } catch {
      toast.error('Failed to load templates')
    } finally {
      setLoading(false)
    }
  }, [showInactive])

  useEffect(() => { fetchTemplates() }, [fetchTemplates])

  const openAdd = () => {
    setForm(emptyForm)
    setEditingId(null)
    setModalOpen(true)
  }

  const openEdit = (t: EmailTemplate) => {
    setForm({
      template_name: t.template_name,
      subject_template: t.subject_template,
      body_template: t.body_template,
      language: t.language ?? '',
      category: t.category ?? '',
      placeholders: (t.placeholders ?? []).join(', '),
      notes: t.notes ?? '',
    })
    setEditingId(t.id)
    setModalOpen(true)
  }

  const handleSave = async () => {
    if (!form.template_name.trim() || !form.subject_template.trim() || !form.body_template.trim()) {
      toast.error('Name, subject and body are required')
      return
    }
    setSaving(true)
    try {
      const placeholders = form.placeholders
        .split(/[,\n]+/)
        .map((s) => s.trim())
        .filter(Boolean)
      const body: Record<string, unknown> = {
        template_name: form.template_name.trim(),
        subject_template: form.subject_template.trim(),
        body_template: form.body_template,
        language: form.language.trim() || null,
        category: form.category.trim() || null,
        placeholders: placeholders.length ? placeholders : null,
        notes: form.notes.trim() || null,
      }
      if (editingId) body.id = editingId

      const res = await fetch('/api/inbox/templates', {
        method: editingId ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      const data = await res.json()
      if (!res.ok) {
        toast.error(data.error || 'Failed to save')
        return
      }
      toast.success(editingId ? 'Template updated' : 'Template created')
      setModalOpen(false)
      fetchTemplates()
    } catch {
      toast.error('Error saving template')
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async (id: string, name: string) => {
    if (!confirm(`Delete template "${name}"?`)) return
    setDeletingId(id)
    try {
      const res = await fetch(`/api/inbox/templates?id=${id}`, { method: 'DELETE' })
      if (!res.ok) {
        const data = await res.json()
        toast.error(data.error || 'Failed to delete')
        return
      }
      toast.success('Template deleted')
      fetchTemplates()
    } catch {
      toast.error('Error deleting template')
    } finally {
      setDeletingId(null)
    }
  }

  const handleToggleActive = async (id: string, currentActive: boolean) => {
    try {
      const res = await fetch('/api/inbox/templates', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, active: !currentActive }),
      })
      if (!res.ok) {
        const data = await res.json()
        toast.error(data.error || 'Failed to toggle')
        return
      }
      toast.success(currentActive ? 'Template deactivated' : 'Template activated')
      fetchTemplates()
    } catch {
      toast.error('Error updating template')
    }
  }

  // Group by category for display
  const grouped: Record<string, EmailTemplate[]> = {}
  for (const t of templates) {
    const key = t.category || 'Other'
    if (!grouped[key]) grouped[key] = []
    grouped[key].push(t)
  }

  return (
    <div className="p-6 max-w-6xl mx-auto">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <Mail className="h-6 w-6 text-blue-600" />
            Email Templates
          </h1>
          <p className="text-sm text-zinc-500 mt-1">
            Templates for the CRM compose-email dialog. Placeholders use <code className="bg-zinc-100 px-1 rounded">{'{{variable}}'}</code> syntax. The server wraps sent emails with the TD-branded shell automatically.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <label className="flex items-center gap-1.5 text-xs text-zinc-600">
            <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
            Show inactive
          </label>
          <button
            onClick={openAdd}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700"
          >
            <Plus className="h-4 w-4" />
            New template
          </button>
        </div>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-16 text-zinc-400">
          <Loader2 className="h-6 w-6 animate-spin" />
        </div>
      ) : templates.length === 0 ? (
        <div className="rounded-lg border border-dashed p-12 text-center text-zinc-500">
          No templates yet. Click New template to create one.
        </div>
      ) : (
        <div className="space-y-6">
          {Object.entries(grouped).map(([category, list]) => (
            <div key={category}>
              <h2 className="text-sm font-semibold text-zinc-700 mb-2">{category}</h2>
              <div className="rounded-lg border overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-zinc-50 text-xs text-zinc-500 uppercase">
                    <tr>
                      <th className="text-left px-4 py-2 font-medium">Name</th>
                      <th className="text-left px-4 py-2 font-medium">Language</th>
                      <th className="text-left px-4 py-2 font-medium">Subject</th>
                      <th className="text-left px-4 py-2 font-medium">Status</th>
                      <th className="text-right px-4 py-2 font-medium">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {list.map((t) => (
                      <tr key={t.id} className={t.active ? '' : 'bg-zinc-50 text-zinc-400'}>
                        <td className="px-4 py-2 font-medium">{t.template_name}</td>
                        <td className="px-4 py-2">{t.language || '-'}</td>
                        <td className="px-4 py-2 text-zinc-600">{t.subject_template}</td>
                        <td className="px-4 py-2">
                          <span className={`text-xs px-2 py-0.5 rounded ${t.active ? 'bg-emerald-100 text-emerald-700' : 'bg-zinc-200 text-zinc-600'}`}>
                            {t.active ? 'Active' : 'Inactive'}
                          </span>
                        </td>
                        <td className="px-4 py-2 text-right">
                          <div className="inline-flex items-center gap-1">
                            <button
                              onClick={() => openEdit(t)}
                              title="Edit"
                              className="p-1.5 rounded hover:bg-zinc-100 text-zinc-600"
                            >
                              <Pencil className="h-3.5 w-3.5" />
                            </button>
                            <button
                              onClick={() => handleToggleActive(t.id, t.active)}
                              title={t.active ? 'Deactivate' : 'Activate'}
                              className="p-1.5 rounded hover:bg-zinc-100 text-zinc-600"
                            >
                              <RotateCcw className="h-3.5 w-3.5" />
                            </button>
                            <button
                              onClick={() => handleDelete(t.id, t.template_name)}
                              title="Delete"
                              disabled={deletingId === t.id}
                              className="p-1.5 rounded hover:bg-red-50 text-red-500 disabled:opacity-40"
                            >
                              {deletingId === t.id ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              ) : (
                                <Trash2 className="h-3.5 w-3.5" />
                              )}
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Modal */}
      {modalOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-2xl flex flex-col max-h-[90vh]">
            <div className="flex items-center justify-between px-5 py-3 border-b">
              <h2 className="text-sm font-semibold">
                {editingId ? 'Edit template' : 'New template'}
              </h2>
              <button onClick={() => setModalOpen(false)} className="p-1 rounded hover:bg-zinc-100 text-zinc-500">
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto p-5 space-y-4">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-zinc-600 mb-1">Name *</label>
                  <input
                    type="text"
                    value={form.template_name}
                    onChange={(e) => setForm({ ...form, template_name: e.target.value })}
                    placeholder="Payment Reminder"
                    className="w-full rounded border border-zinc-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-400"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-zinc-600 mb-1">Category</label>
                  <input
                    type="text"
                    list="category-suggestions"
                    value={form.category}
                    onChange={(e) => setForm({ ...form, category: e.target.value })}
                    placeholder="Payment, Documents, Follow-up..."
                    className="w-full rounded border border-zinc-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-400"
                  />
                  <datalist id="category-suggestions">
                    {CATEGORY_SUGGESTIONS.map((c) => <option key={c} value={c} />)}
                  </datalist>
                </div>
                <div>
                  <label className="block text-xs font-medium text-zinc-600 mb-1">Language</label>
                  <select
                    value={form.language}
                    onChange={(e) => setForm({ ...form, language: e.target.value })}
                    className="w-full rounded border border-zinc-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-400"
                  >
                    {LANGUAGE_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-medium text-zinc-600 mb-1">Placeholders (comma-separated)</label>
                  <input
                    type="text"
                    value={form.placeholders}
                    onChange={(e) => setForm({ ...form, placeholders: e.target.value })}
                    placeholder="first_name, invoice_number, amount"
                    className="w-full rounded border border-zinc-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-400"
                  />
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-zinc-600 mb-1">Subject *</label>
                <input
                  type="text"
                  value={form.subject_template}
                  onChange={(e) => setForm({ ...form, subject_template: e.target.value })}
                  placeholder="Payment reminder -- {{invoice_number}}"
                  className="w-full rounded border border-zinc-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-400"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-zinc-600 mb-1">
                  Body * <span className="text-zinc-400 font-normal">(plain text, use blank lines for paragraphs, {'{{var}}'} for placeholders)</span>
                </label>
                <textarea
                  value={form.body_template}
                  onChange={(e) => setForm({ ...form, body_template: e.target.value })}
                  rows={12}
                  placeholder={"Dear {{first_name}},\n\nThis is a reminder that invoice {{invoice_number}} is outstanding.\n\nLet me know if you have any questions."}
                  className="w-full rounded border border-zinc-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-400 font-mono"
                />
                <p className="text-xs text-zinc-400 mt-1">
                  The email will be wrapped automatically with the TD logo and footer on send. Do not include a greeting image or signature here.
                </p>
              </div>
              <div>
                <label className="block text-xs font-medium text-zinc-600 mb-1">Notes (internal)</label>
                <input
                  type="text"
                  value={form.notes}
                  onChange={(e) => setForm({ ...form, notes: e.target.value })}
                  placeholder="When to use this template"
                  className="w-full rounded border border-zinc-200 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-blue-400"
                />
              </div>
            </div>
            <div className="flex items-center justify-end gap-2 px-5 py-3 border-t">
              <button
                onClick={() => setModalOpen(false)}
                className="px-4 py-2 rounded-lg text-sm text-zinc-600 hover:bg-zinc-100"
              >
                Cancel
              </button>
              <button
                onClick={handleSave}
                disabled={saving}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-blue-600 text-white text-sm font-medium hover:bg-blue-700 disabled:opacity-40"
              >
                {saving && <Loader2 className="h-4 w-4 animate-spin" />}
                {editingId ? 'Save changes' : 'Create template'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
