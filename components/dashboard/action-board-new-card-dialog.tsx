'use client'

/**
 * "+ New card" — staff places a to-do on the board by hand (not from a client
 * event). Pick a client (search), write what to do, choose a column. Creates a
 * staff-only message_actions card (message_id NULL). See sysdoc notification-center-plan.
 */

import { useCallback, useEffect, useState } from 'react'
import { X, Search, Building2, Plus } from 'lucide-react'
import { createManualCard } from './action-board-actions'

interface Col {
  slug: string
  display_name: string
  terminal: boolean
}
interface AccountResult {
  id: string
  company_name: string
  contact_name: string | null
}

export function NewCardDialog({
  open,
  onClose,
  onCreated,
  columns,
}: {
  open: boolean
  onClose: () => void
  onCreated: () => void
  columns: Col[]
}) {
  const [q, setQ] = useState('')
  const [results, setResults] = useState<AccountResult[]>([])
  const [selected, setSelected] = useState<AccountResult | null>(null)
  const [label, setLabel] = useState('')
  const [col, setCol] = useState('')
  const [remind, setRemind] = useState('') // yyyy-mm-dd, optional
  const [priority, setPriority] = useState<'normal' | 'high' | 'urgent'>('normal')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (open) {
      setQ(''); setResults([]); setSelected(null); setLabel(''); setError(null)
      setRemind(''); setPriority('normal')
      setCol(columns.find((c) => !c.terminal)?.slug ?? '')
    }
  }, [open, columns])

  // debounced client search (reuses the portal-chat account search)
  useEffect(() => {
    if (!open || selected || q.trim().length < 2) { setResults([]); return }
    const t = setTimeout(async () => {
      try {
        const r = await fetch(`/api/portal/chat/search-accounts?q=${encodeURIComponent(q)}`).then((x) => x.json())
        setResults(Array.isArray(r.accounts) ? r.accounts : [])
      } catch {
        setResults([])
      }
    }, 300)
    return () => clearTimeout(t)
  }, [q, open, selected])

  const create = useCallback(async () => {
    if (!selected || !label.trim() || busy) return
    setBusy(true); setError(null)
    // Reminder is a date-only picker; store as end-of-day ISO so it isn't
    // "overdue" the morning you set it for today.
    const remind_at = remind ? new Date(`${remind}T17:00:00`).toISOString() : null
    const res = await createManualCard({ label, account_id: selected.id, action_type: col, remind_at, priority })
    setBusy(false)
    if (!res.success) { setError(res.error || 'Could not create the card'); return }
    onCreated()
    onClose()
  }, [selected, label, col, remind, priority, busy, onCreated, onClose])

  if (!open) return null
  const openCols = columns.filter((c) => !c.terminal)

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between p-4 border-b">
          <h2 className="text-sm font-semibold">New card</h2>
          <button onClick={onClose} className="text-zinc-400 hover:text-zinc-700" aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="p-4 space-y-3">
          {error && (
            <div className="text-xs text-red-600 bg-red-50 border border-red-100 rounded px-2 py-1.5">{error}</div>
          )}

          {/* 1. Client */}
          <div>
            <label className="block text-[11px] font-medium text-zinc-500 mb-1">Client</label>
            {selected ? (
              <div className="flex items-center justify-between border rounded px-2 py-1.5">
                <span className="flex items-center gap-1.5 text-sm text-zinc-800">
                  <Building2 className="h-3.5 w-3.5 text-zinc-400" />
                  {selected.company_name}
                  {selected.contact_name ? <span className="text-zinc-400">· {selected.contact_name}</span> : null}
                </span>
                <button onClick={() => setSelected(null)} className="text-[11px] text-zinc-500 hover:text-zinc-800">change</button>
              </div>
            ) : (
              <>
                <div className="flex items-center gap-1.5 border rounded px-2 py-1.5">
                  <Search className="h-3.5 w-3.5 text-zinc-400" />
                  <input
                    autoFocus
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                    placeholder="Search a company…"
                    className="flex-1 text-sm outline-none"
                  />
                </div>
                {results.length > 0 && (
                  <div className="mt-1 border rounded max-h-40 overflow-y-auto">
                    {results.map((a) => (
                      <button
                        key={a.id}
                        onClick={() => { setSelected(a); setQ('') }}
                        className="w-full text-left px-2 py-1.5 hover:bg-zinc-50 border-b last:border-b-0"
                      >
                        <span className="text-sm text-zinc-800">{a.company_name}</span>
                        {a.contact_name ? <span className="text-xs text-zinc-400"> · {a.contact_name}</span> : null}
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>

          {/* 2. What to do */}
          <div>
            <label className="block text-[11px] font-medium text-zinc-500 mb-1">What needs to be done</label>
            <textarea
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              rows={2}
              placeholder="e.g. Call the client about the missing passport"
              className="w-full text-sm border rounded px-2 py-1.5 resize-none"
            />
          </div>

          {/* 3. Column */}
          <div>
            <label className="block text-[11px] font-medium text-zinc-500 mb-1">Column</label>
            <select value={col} onChange={(e) => setCol(e.target.value)} className="w-full text-sm border rounded px-2 py-1.5 bg-white">
              {openCols.map((c) => (
                <option key={c.slug} value={c.slug}>{c.display_name}</option>
              ))}
            </select>
          </div>

          {/* 4. Reminder + priority */}
          <div className="flex gap-2">
            <div className="flex-1">
              <label className="block text-[11px] font-medium text-zinc-500 mb-1">Remind me by (optional)</label>
              <input
                type="date"
                value={remind}
                onChange={(e) => setRemind(e.target.value)}
                className="w-full text-sm border rounded px-2 py-1.5 bg-white"
              />
            </div>
            <div className="w-32">
              <label className="block text-[11px] font-medium text-zinc-500 mb-1">Priority</label>
              <select
                value={priority}
                onChange={(e) => setPriority(e.target.value as 'normal' | 'high' | 'urgent')}
                className="w-full text-sm border rounded px-2 py-1.5 bg-white"
              >
                <option value="normal">Normal</option>
                <option value="high">High</option>
                <option value="urgent">Urgent</option>
              </select>
            </div>
          </div>

          <button
            disabled={!selected || !label.trim() || busy}
            onClick={create}
            className="w-full flex items-center justify-center gap-1 text-sm font-medium bg-zinc-900 text-white rounded px-3 py-2 disabled:opacity-40"
          >
            <Plus className="h-4 w-4" /> {busy ? 'Adding…' : 'Add card'}
          </button>
        </div>
      </div>
    </div>
  )
}
