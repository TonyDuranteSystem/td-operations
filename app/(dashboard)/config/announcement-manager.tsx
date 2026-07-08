'use client'

import { useState } from 'react'
import { Plus, Pencil, Trash2, Eye, EyeOff, Megaphone } from 'lucide-react'

export interface AnnouncementRow {
  id: string
  title: string
  message: string
  title_en: string | null
  message_en: string | null
  type: 'info' | 'warning' | 'success'
  active: boolean
  dismissible: boolean
  active_from: string | null
  active_until: string | null
  created_at: string
  updated_at: string
}

const TYPE_LABELS: Record<string, string> = { info: 'Info', warning: 'Warning', success: 'Success' }
const TYPE_BADGE: Record<string, string> = {
  info: 'bg-blue-100 text-blue-700',
  warning: 'bg-amber-100 text-amber-700',
  success: 'bg-green-100 text-green-700',
}

function AnnouncementDialog({
  row,
  onClose,
  onSave,
}: {
  row?: AnnouncementRow
  onClose: () => void
  onSave: (data: Partial<AnnouncementRow>) => Promise<void>
}) {
  // Prefill from the English fields (what clients actually see) falling back to primary
  const [title, setTitle] = useState(row?.title_en ?? row?.title ?? '')
  const [message, setMessage] = useState(row?.message_en ?? row?.message ?? '')
  const [type, setType] = useState<'info' | 'warning' | 'success'>(row?.type ?? 'info')
  const [dismissible, setDismissible] = useState(row?.dismissible !== false)
  const [active, setActive] = useState(row?.active !== false)
  const [activeFrom, setActiveFrom] = useState(row?.active_from ?? '')
  const [activeUntil, setActiveUntil] = useState(row?.active_until ?? '')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    if (!title.trim() || !message.trim()) { setError('Title and message are required.'); return }
    setSaving(true)
    setError('')
    try {
      // Write to both fields: title/message satisfies NOT NULL, title_en/message_en is what the banner displays
      await onSave({
        title: title.trim(),
        message: message.trim(),
        title_en: title.trim(),
        message_en: message.trim(),
        type,
        dismissible,
        active,
        active_from: activeFrom || null,
        active_until: activeUntil || null,
      })
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save')
    } finally {
      setSaving(false)
    }
  }

  const fieldCls = 'w-full border border-zinc-300 rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500'

  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4 overflow-y-auto">
      <form
        onSubmit={handleSubmit}
        className="bg-white rounded-xl shadow-xl w-full max-w-xl p-6 space-y-4 my-8"
      >
        <h2 className="text-lg font-semibold">{row ? 'Edit Announcement' : 'New Announcement'}</h2>

        <div className="space-y-3">
          <div>
            <label className="block text-sm font-medium text-zinc-700 mb-1">Title</label>
            <input value={title} onChange={e => setTitle(e.target.value)} className={fieldCls}
              placeholder="e.g. Relay: International Wire Transfers" />
          </div>
          <div>
            <label className="block text-sm font-medium text-zinc-700 mb-1">Message</label>
            <textarea value={message} onChange={e => setMessage(e.target.value)} rows={4}
              className={`${fieldCls} resize-none`}
              placeholder="Message text shown to all portal clients..." />
          </div>
        </div>

        {/* Date range */}
        <div className="grid grid-cols-2 gap-3 pt-1 border-t border-zinc-100">
          <div>
            <label className="block text-sm font-medium text-zinc-700 mb-1">Show from (optional)</label>
            <input type="date" value={activeFrom} onChange={e => setActiveFrom(e.target.value)}
              className={fieldCls} />
          </div>
          <div>
            <label className="block text-sm font-medium text-zinc-700 mb-1">Hide after (optional)</label>
            <input type="date" value={activeUntil} onChange={e => setActiveUntil(e.target.value)}
              className={fieldCls} />
          </div>
          <p className="col-span-2 text-xs text-zinc-400">Leave blank for no date limit. Both dates are inclusive.</p>
        </div>

        {/* Settings */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3 pt-1 border-t border-zinc-100">
          <div>
            <label className="block text-sm font-medium text-zinc-700 mb-1">Type</label>
            <select value={type} onChange={e => setType(e.target.value as 'info' | 'warning' | 'success')}
              className={fieldCls}>
              <option value="info">Info (blue)</option>
              <option value="warning">Warning (amber)</option>
              <option value="success">Success (green)</option>
            </select>
          </div>
          <div className="flex flex-col gap-1 pt-5">
            <label className="flex items-center gap-2 text-sm text-zinc-700 cursor-pointer">
              <input type="checkbox" checked={dismissible} onChange={e => setDismissible(e.target.checked)} className="rounded" />
              Dismissible
            </label>
          </div>
          <div className="flex flex-col gap-1 pt-5">
            <label className="flex items-center gap-2 text-sm text-zinc-700 cursor-pointer">
              <input type="checkbox" checked={active} onChange={e => setActive(e.target.checked)} className="rounded" />
              Active
            </label>
          </div>
        </div>

        {error && <p className="text-sm text-red-600">{error}</p>}

        <div className="flex justify-end gap-2 pt-1">
          <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-zinc-600 hover:text-zinc-900">Cancel</button>
          <button type="submit" disabled={saving}
            className="px-4 py-2 text-sm font-medium bg-zinc-900 text-white rounded-lg hover:bg-zinc-700 disabled:opacity-50">
            {saving ? 'Saving…' : row ? 'Save Changes' : 'Create'}
          </button>
        </div>
      </form>
    </div>
  )
}

export function AnnouncementsTab({ initialRows }: { initialRows: AnnouncementRow[] }) {
  const [rows, setRows] = useState<AnnouncementRow[]>(initialRows)
  const [dialog, setDialog] = useState<'new' | AnnouncementRow | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)

  const handleSave = async (data: Partial<AnnouncementRow>) => {
    if (dialog === 'new') {
      const res = await fetch('/api/crm/portal-announcements', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || 'Failed to create')
      setRows(prev => [json.announcement, ...prev])
    } else if (dialog && typeof dialog === 'object') {
      const res = await fetch(`/api/crm/portal-announcements/${dialog.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      })
      const json = await res.json()
      if (!res.ok) throw new Error(json.error || 'Failed to update')
      setRows(prev => prev.map(r => r.id === dialog.id ? json.announcement : r))
    }
  }

  const handleToggleActive = async (row: AnnouncementRow) => {
    const res = await fetch(`/api/crm/portal-announcements/${row.id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ active: !row.active }),
    })
    if (res.ok) {
      const json = await res.json()
      setRows(prev => prev.map(r => r.id === row.id ? json.announcement : r))
    }
  }

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this announcement? This cannot be undone.')) return
    setDeleting(id)
    try {
      const res = await fetch(`/api/crm/portal-announcements/${id}`, { method: 'DELETE' })
      if (res.ok) setRows(prev => prev.filter(r => r.id !== id))
    } finally {
      setDeleting(null)
    }
  }

  return (
    <div>
      <div className="flex items-center justify-between mb-4">
        <p className="text-sm text-zinc-500">
          Banners shown to all portal clients on their dashboard.
        </p>
        <button onClick={() => setDialog('new')}
          className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium bg-zinc-900 text-white rounded-lg hover:bg-zinc-700">
          <Plus className="h-4 w-4" />
          New
        </button>
      </div>

      {rows.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-12 border rounded-lg bg-zinc-50 text-zinc-400 gap-2">
          <Megaphone className="h-8 w-8" />
          <p className="text-sm">No announcements yet. Click New to create one.</p>
        </div>
      ) : (
        <div className="border rounded-lg overflow-x-auto bg-white">
          <table className="w-full min-w-[640px] text-sm">
            <thead className="bg-zinc-50 text-left text-xs uppercase text-zinc-500">
              <tr>
                <th className="px-4 py-2 font-medium">Title</th>
                <th className="px-4 py-2 font-medium">Type</th>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2 font-medium">Date Range</th>
                <th className="px-4 py-2 font-medium w-28"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {rows.map(row => (
                <tr key={row.id} className={row.active ? '' : 'opacity-50'}>
                  <td className="px-4 py-3">
                    <p className="font-medium text-zinc-900">{row.title_en ?? row.title}</p>
                    <p className="text-xs text-zinc-500 mt-0.5 max-w-xs truncate">{row.message_en ?? row.message}</p>
                  </td>
                  <td className="px-4 py-3">
                    <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${TYPE_BADGE[row.type] ?? TYPE_BADGE.info}`}>
                      {TYPE_LABELS[row.type] ?? row.type}
                    </span>
                  </td>
                  <td className="px-4 py-3">
                    <span className={`inline-flex px-2 py-0.5 rounded-full text-xs font-medium ${row.active ? 'bg-green-100 text-green-700' : 'bg-zinc-100 text-zinc-500'}`}>
                      {row.active ? 'Active' : 'Inactive'}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-zinc-500 text-xs">
                    {row.active_from || row.active_until
                      ? <span>{row.active_from ?? '∞'} → {row.active_until ?? '∞'}</span>
                      : <span className="text-zinc-400">Always</span>}
                  </td>
                  <td className="px-4 py-3">
                    <div className="flex items-center justify-end gap-1">
                      <button onClick={() => handleToggleActive(row)}
                        title={row.active ? 'Deactivate' : 'Activate'}
                        className="p-1.5 text-zinc-400 hover:text-zinc-700 rounded">
                        {row.active ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                      </button>
                      <button onClick={() => setDialog(row)} className="p-1.5 text-zinc-400 hover:text-zinc-700 rounded">
                        <Pencil className="h-4 w-4" />
                      </button>
                      <button onClick={() => handleDelete(row.id)} disabled={deleting === row.id}
                        className="p-1.5 text-zinc-400 hover:text-red-600 rounded disabled:opacity-50">
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {dialog !== null && (
        <AnnouncementDialog
          row={dialog === 'new' ? undefined : dialog}
          onClose={() => setDialog(null)}
          onSave={handleSave}
        />
      )}
    </div>
  )
}
