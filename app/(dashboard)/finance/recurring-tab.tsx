'use client'

import { useState, useTransition } from 'react'
import { Repeat, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { toggleRecurringInvoice, type RecurringTemplateListRow } from '@/app/(dashboard)/payments/recurring-invoice-actions'

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
            <div className={`flex flex-wrap items-center gap-x-3 gap-y-1 mt-2 text-xs ${row.active ? 'text-zinc-500' : 'text-zinc-400'}`}>
              <span className="inline-flex items-center gap-1">
                <Repeat className="h-3 w-3" /> {FREQUENCY_LABELS[row.frequency] ?? row.frequency}
              </span>
              <span>{symbol}{row.amount.toFixed(2)}</span>
              <span>{row.active ? `Next bill ${row.next_run_date}` : 'Paused'}</span>
            </div>
          </div>
        )
      })}
    </div>
  )
}
