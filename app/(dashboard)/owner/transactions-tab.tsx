'use client'

import { useState, useCallback } from 'react'
import { toast } from 'sonner'
import type { OwnerTransaction, OwnerCategory } from '@/lib/owner-finance'

const CATEGORIES: OwnerCategory[] = ['income', 'cogs', 'expense', 'distribution', 'fee', 'conversion', 'refund', 'uncategorized']

const SUBCATEGORIES: Record<string, string[]> = {
  income: ['consulting', 'tax_services', 'formation', 'renewal', 'other_income'],
  cogs: ['contractor', 'payroll', 'subcontractor'],
  expense: ['software', 'saas', 'payroll', 'marketing', 'legal', 'accounting', 'office', 'travel', 'meals', 'real_estate', 'vehicle', 'insurance', 'utilities', 'bank_fees', 'other_expense'],
  distribution: ['owner_draw', 'partner_distribution'],
  fee: ['bank_fee', 'processing_fee', 'wire_fee'],
  conversion: ['fx_conversion', 'internal_transfer'],
  refund: ['client_refund', 'vendor_refund'],
  uncategorized: [],
}

const fmt = (n: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(Math.abs(n))

interface TransactionsTabProps {
  year: number
  initialRows: OwnerTransaction[]
  initialTotal: number
}

export function TransactionsTab({ year, initialRows, initialTotal }: TransactionsTabProps) {
  const [rows, setRows] = useState<OwnerTransaction[]>(initialRows)
  const [total, setTotal] = useState(initialTotal)
  const [loading, setLoading] = useState(false)
  const [search, setSearch] = useState('')
  const [filterCategory, setFilterCategory] = useState<OwnerCategory | ''>('uncategorized')
  const [offset, setOffset] = useState(0)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editValues, setEditValues] = useState<{ category: OwnerCategory; subcategory: string; notes: string }>({
    category: 'uncategorized', subcategory: '', notes: '',
  })
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [bulkCategory, setBulkCategory] = useState<OwnerCategory>('expense')
  const [bulkSubcategory, setBulkSubcategory] = useState('')
  const LIMIT = 50

  const load = useCallback(async (newOffset = 0, cat = filterCategory, q = search) => {
    setLoading(true)
    try {
      const params = new URLSearchParams({ year: String(year), limit: String(LIMIT), offset: String(newOffset) })
      if (cat) params.set('category', cat)
      if (q) params.set('search', q)
      const res = await fetch(`/api/owner/transactions?${params}`)
      if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || 'Load failed') }
      const data = await res.json()
      setRows(data.rows)
      setTotal(data.total)
      setOffset(newOffset)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Load failed')
    } finally {
      setLoading(false)
    }
  }, [year, filterCategory, search])

  function startEdit(tx: OwnerTransaction) {
    setEditingId(tx.id)
    setEditValues({ category: tx.category, subcategory: tx.subcategory ?? '', notes: tx.notes ?? '' })
  }

  async function saveEdit(id: string) {
    try {
      const res = await fetch('/api/owner/transactions', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, ...editValues }),
      })
      if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || 'Save failed') }
      setRows(r => r.map(tx => tx.id === id ? { ...tx, ...editValues } : tx))
      setEditingId(null)
      toast.success('Saved')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Save failed')
    }
  }

  async function bulkCategorize() {
    if (selected.size === 0) return
    try {
      const res = await fetch('/api/owner/transactions/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: Array.from(selected), category: bulkCategory, subcategory: bulkSubcategory || null }),
      })
      if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || 'Bulk save failed') }
      toast.success(`Categorized ${selected.size} transactions`)
      setSelected(new Set())
      load(offset)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Bulk save failed')
    }
  }

  const reviewed = rows.filter(r => r.category !== 'uncategorized').length
  const progressPct = total > 0 ? Math.round((reviewed / total) * 100) : 0

  return (
    <div className="space-y-4">
      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3">
        <input
          type="text"
          placeholder="Search description or counterparty..."
          value={search}
          onChange={e => { setSearch(e.target.value); load(0, filterCategory, e.target.value) }}
          className="rounded-md border border-zinc-200 px-3 py-1.5 text-sm w-64"
        />
        <select
          value={filterCategory}
          onChange={e => { setFilterCategory(e.target.value as OwnerCategory | ''); load(0, e.target.value as OwnerCategory | '', search) }}
          className="rounded-md border border-zinc-200 px-2 py-1.5 text-sm"
        >
          <option value="">All categories</option>
          {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
        <span className="text-xs text-zinc-500">{total} transactions</span>
      </div>

      {/* Bulk action bar */}
      {selected.size > 0 && (
        <div className="flex items-center gap-3 rounded-lg border border-blue-200 bg-blue-50 px-4 py-2">
          <span className="text-sm font-medium text-blue-800">{selected.size} selected</span>
          <select
            value={bulkCategory}
            onChange={e => setBulkCategory(e.target.value as OwnerCategory)}
            className="rounded border border-blue-200 bg-white px-2 py-1 text-sm"
          >
            {CATEGORIES.filter(c => c !== 'uncategorized').map(c => <option key={c} value={c}>{c}</option>)}
          </select>
          <select
            value={bulkSubcategory}
            onChange={e => setBulkSubcategory(e.target.value)}
            className="rounded border border-blue-200 bg-white px-2 py-1 text-sm"
          >
            <option value="">— subcategory —</option>
            {(SUBCATEGORIES[bulkCategory] ?? []).map(s => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}
          </select>
          <button onClick={bulkCategorize} className="rounded bg-blue-600 px-3 py-1 text-sm text-white hover:bg-blue-700">Apply</button>
          <button onClick={() => setSelected(new Set())} className="text-xs text-blue-600 hover:underline">Clear</button>
        </div>
      )}

      {/* Progress bar for uncategorized filter */}
      {filterCategory === 'uncategorized' && total > 0 && (
        <div className="rounded-lg border border-zinc-200 bg-white p-3">
          <div className="mb-1 flex justify-between text-xs text-zinc-500">
            <span>Categorization progress</span>
            <span>{reviewed} / {total} reviewed ({progressPct}%)</span>
          </div>
          <div className="h-2 w-full rounded-full bg-zinc-100">
            <div className="h-2 rounded-full bg-green-500 transition-all" style={{ width: `${progressPct}%` }} />
          </div>
        </div>
      )}

      {/* Table */}
      <div className="overflow-x-auto rounded-lg border border-zinc-200 bg-white">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-zinc-100 bg-zinc-50">
              <th className="w-8 px-3 py-2">
                <input
                  type="checkbox"
                  checked={selected.size === rows.length && rows.length > 0}
                  onChange={e => setSelected(e.target.checked ? new Set(rows.map(r => r.id)) : new Set())}
                />
              </th>
              <th className="px-3 py-2 text-left text-xs font-medium text-zinc-500">Date</th>
              <th className="px-3 py-2 text-left text-xs font-medium text-zinc-500">Bank</th>
              <th className="px-3 py-2 text-left text-xs font-medium text-zinc-500">Counterparty / Description</th>
              <th className="px-3 py-2 text-right text-xs font-medium text-zinc-500">Amount</th>
              <th className="px-3 py-2 text-left text-xs font-medium text-zinc-500">Category</th>
              <th className="px-3 py-2 text-left text-xs font-medium text-zinc-500">Subcategory</th>
              <th className="px-3 py-2 text-left text-xs font-medium text-zinc-500">Notes</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {rows.map(tx => (
              <tr key={tx.id} className="border-b border-zinc-50 hover:bg-zinc-50">
                <td className="px-3 py-2">
                  <input
                    type="checkbox"
                    checked={selected.has(tx.id)}
                    onChange={e => {
                      const s = new Set(selected)
                      e.target.checked ? s.add(tx.id) : s.delete(tx.id)
                      setSelected(s)
                    }}
                  />
                </td>
                <td className="px-3 py-2 text-xs text-zinc-500 whitespace-nowrap">{tx.transaction_date}</td>
                <td className="px-3 py-2 text-xs text-zinc-400">{tx.bank_name}</td>
                <td className="px-3 py-2 max-w-[200px]">
                  <div className="truncate font-medium text-zinc-800">{tx.counterparty ?? '—'}</div>
                  <div className="truncate text-xs text-zinc-400">{tx.description}</div>
                </td>
                <td className={`px-3 py-2 text-right font-mono text-xs font-medium tabular-nums ${tx.amount < 0 ? 'text-red-600' : 'text-green-600'}`}>
                  {tx.amount < 0 ? '-' : '+'}{fmt(tx.amount)}
                </td>
                {editingId === tx.id ? (
                  <>
                    <td className="px-2 py-1.5">
                      <select
                        value={editValues.category}
                        onChange={e => setEditValues(v => ({ ...v, category: e.target.value as OwnerCategory, subcategory: '' }))}
                        className="w-full rounded border border-zinc-200 px-1.5 py-1 text-xs"
                        autoFocus
                      >
                        {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
                      </select>
                    </td>
                    <td className="px-2 py-1.5">
                      <select
                        value={editValues.subcategory}
                        onChange={e => setEditValues(v => ({ ...v, subcategory: e.target.value }))}
                        className="w-full rounded border border-zinc-200 px-1.5 py-1 text-xs"
                      >
                        <option value="">—</option>
                        {(SUBCATEGORIES[editValues.category] ?? []).map(s => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}
                      </select>
                    </td>
                    <td className="px-2 py-1.5">
                      <input
                        value={editValues.notes}
                        onChange={e => setEditValues(v => ({ ...v, notes: e.target.value }))}
                        onKeyDown={e => { if (e.key === 'Enter') saveEdit(tx.id); if (e.key === 'Escape') setEditingId(null) }}
                        className="w-full rounded border border-zinc-200 px-1.5 py-1 text-xs"
                        placeholder="Notes..."
                      />
                    </td>
                    <td className="px-3 py-2">
                      <div className="flex gap-1">
                        <button onClick={() => saveEdit(tx.id)} className="rounded bg-zinc-900 px-2 py-1 text-xs text-white hover:bg-zinc-700">✓</button>
                        <button onClick={() => setEditingId(null)} className="rounded border border-zinc-200 px-2 py-1 text-xs hover:bg-zinc-100">✕</button>
                      </div>
                    </td>
                  </>
                ) : (
                  <>
                    <td className="px-3 py-2">
                      <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${tx.category === 'uncategorized' ? 'bg-orange-100 text-orange-700' : 'bg-zinc-100 text-zinc-600'}`}>
                        {tx.category}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-xs text-zinc-500">{tx.subcategory?.replace(/_/g, ' ') ?? '—'}</td>
                    <td className="px-3 py-2 text-xs text-zinc-400 max-w-[120px] truncate">{tx.notes ?? ''}</td>
                    <td className="px-3 py-2">
                      <button onClick={() => startEdit(tx)} className="rounded border border-zinc-200 px-2 py-1 text-xs hover:bg-zinc-100">Edit</button>
                    </td>
                  </>
                )}
              </tr>
            ))}
            {loading && (
              <tr><td colSpan={9} className="px-3 py-4 text-center text-sm text-zinc-400">Loading...</td></tr>
            )}
            {!loading && rows.length === 0 && (
              <tr><td colSpan={9} className="px-3 py-4 text-center text-sm text-zinc-400">No transactions found.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      {total > LIMIT && (
        <div className="flex items-center justify-between text-sm text-zinc-500">
          <span>Showing {offset + 1}–{Math.min(offset + LIMIT, total)} of {total}</span>
          <div className="flex gap-2">
            <button disabled={offset === 0} onClick={() => load(offset - LIMIT)} className="rounded border px-3 py-1 disabled:opacity-40">← Prev</button>
            <button disabled={offset + LIMIT >= total} onClick={() => load(offset + LIMIT)} className="rounded border px-3 py-1 disabled:opacity-40">Next →</button>
          </div>
        </div>
      )}
    </div>
  )
}
