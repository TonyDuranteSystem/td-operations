'use client'

import { useState, useTransition } from 'react'
import { Repeat, Loader2, Pencil, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { toggleRecurringInvoice, deleteRecurringInvoiceTemplate, type RecurringTemplateListRow } from '@/app/(dashboard)/payments/recurring-invoice-actions'
import { RecurringEditDialog } from '@/components/payments/recurring-edit-dialog'

const FREQUENCY_LABELS: Record<string, string> = {
  weekly: 'Weekly',
  biweekly: 'Every 2 weeks',
  monthly: 'Monthly',
  quarterly: 'Quarterly',
  yearly: 'Yearly',
}

export function RecurringTab({ templates }: { templates: RecurringTemplateListRow[] }) {
  const [rows, setRows] = useState(templates)
  const [pendingId, setPendingId] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [, startTransition] = useTransition()

  function handleToggle(id: string, nextActive: boolean) {
    setPendingId(id)
    startTransition(async () => {
      const result = await toggleRecurringInvoice(id, nextActive)
      if (result.success) {
        setRows(prev => prev.map(r => (r.id === id ? { ...r, active: nextActive } : r)))
        toast.success(nextActive ? 'Recurring invoice turned on' : 'Recurring invoice turned off')
      } else {
        toast.error(result.error ?? 'Failed to update')
      }
      setPendingId(null)
    })
  }

  function handleDelete(id: string) {
    setPendingId(id)
    startTransition(async () => {
      const result = await deleteRecurringInvoiceTemplate(id)
      if (result.success) {
        if (result.data?.deactivated) {
          setRows(prev => prev.map(r => (r.id === id ? { ...r, active: false } : r)))
          toast.success('This schedule already sent at least one real invoice, so it was turned off instead of deleted — the invoice record stays intact.')
        } else {
          setRows(prev => prev.filter(r => r.id !== id))
          toast.success('Recurring schedule deleted')
        }
      } else {
        toast.error(result.error ?? 'Failed to delete')
      }
      setPendingId(null)
      setConfirmDeleteId(null)
    })
  }

  if (rows.length === 0) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-center px-6 py-12 text-zinc-400">
        <Repeat className="h-10 w-10 mb-3 text-zinc-300" />
        <p className="text-sm font-medium text-zinc-500">No recurring invoices yet</p>
        <p className="text-xs mt-1 max-w-sm">
          Create one from the New Invoice screen — toggle &quot;Recurring invoice&quot; and pick how often it repeats.
        </p>
      </div>
    )
  }

  return (
    <div className="h-full overflow-y-auto px-4 sm:px-6 py-4 space-y-3">
      {rows.map(row => {
        const symbol = row.currency === 'EUR' ? '€' : '$'
        return (
          <div
            key={row.id}
            className={`border rounded-lg px-4 py-3 ${row.active ? 'bg-white' : 'bg-zinc-50'}`}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <p className={`font-medium truncate ${row.active ? '' : 'text-zinc-400'}`}>
                  {row.account_name ?? row.contact_name ?? '—'}
                </p>
                <p className={`text-sm truncate ${row.active ? 'text-zinc-500' : 'text-zinc-400'}`}>
                  {row.description ?? row.label}
                </p>
              </div>
              <button
                type="button"
                disabled={pendingId === row.id}
                onClick={() => handleToggle(row.id, !row.active)}
                title={row.active ? 'Turn off' : 'Turn on'}
                className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors disabled:opacity-50 ${
                  row.active ? 'bg-green-600' : 'bg-zinc-300'
                }`}
              >
                {pendingId === row.id ? (
                  <Loader2 className="h-3.5 w-3.5 animate-spin text-white absolute left-1/2 -translate-x-1/2" />
                ) : (
                  <span
                    className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                      row.active ? 'translate-x-6' : 'translate-x-1'
                    }`}
                  />
                )}
              </button>
            </div>
            <div className={`flex flex-wrap items-center justify-between gap-x-3 gap-y-1 mt-2 text-xs ${row.active ? 'text-zinc-500' : 'text-zinc-400'}`}>
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className="inline-flex items-center gap-1">
                  <Repeat className="h-3 w-3" /> {FREQUENCY_LABELS[row.frequency] ?? row.frequency}
                </span>
                <span>{symbol}{row.amount.toFixed(2)}</span>
                <span>{row.active ? `Next bill ${row.next_run_date}` : 'Paused'}</span>
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <button
                  type="button"
                  onClick={() => setEditingId(row.id)}
                  title="Edit"
                  className="p-1.5 rounded hover:bg-zinc-100 text-zinc-400 hover:text-zinc-600"
                >
                  <Pencil className="h-3.5 w-3.5" />
                </button>
                <button
                  type="button"
                  onClick={() => setConfirmDeleteId(row.id)}
                  disabled={pendingId === row.id}
                  title="Delete"
                  className="p-1.5 rounded hover:bg-red-50 text-zinc-400 hover:text-red-500 disabled:opacity-50"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            </div>
          </div>
        )
      })}

      {editingId && (
        <RecurringEditDialog
          templateId={editingId}
          onClose={() => setEditingId(null)}
          onSaved={() => {
            setEditingId(null)
            // Server-side fields (amount, frequency, next bill date) can all
            // change on save — simplest correct refresh is a full reload of
            // this tab's data rather than hand-patching every field client-side.
            window.location.reload()
          }}
        />
      )}

      {confirmDeleteId && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-lg shadow-xl w-full max-w-sm p-4 space-y-4">
            <p className="text-sm">
              Delete this recurring schedule? If it has already sent a real invoice, it will be turned off instead — the invoice stays on record either way.
            </p>
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmDeleteId(null)}
                className="px-4 py-2 text-sm rounded-md border hover:bg-zinc-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => handleDelete(confirmDeleteId)}
                disabled={pendingId === confirmDeleteId}
                className="px-4 py-2 text-sm rounded-md bg-red-600 text-white hover:bg-red-700 disabled:opacity-50 flex items-center gap-2"
              >
                {pendingId === confirmDeleteId && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
