'use client'

import { useState, useEffect, useCallback } from 'react'
import { toast } from 'sonner'
import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine } from 'recharts'
import type { MonthlyBreakdown, CashPosition } from '@/lib/owner-finance'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const fmt = (n: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n)
const fmtIn = (currency: string) => (n: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: 0 }).format(n)

interface CashFlowTabProps {
  year: number
  monthly: MonthlyBreakdown[]
  cash: CashPosition
}

export function CashFlowTab({ year, monthly, cash }: CashFlowTabProps) {
  const chartData = monthly.map(m => ({
    month: MONTHS[m.month - 1],
    Income: m.income,
    Expenses: m.cogs + m.expenses,
    Net: m.net,
  }))

  // Burn rate: avg monthly expenses over last 3 non-zero months
  const expenseMonths = monthly.filter(m => m.cogs + m.expenses > 0)
  const last3 = expenseMonths.slice(-3)
  const burnRate = last3.length > 0
    ? last3.reduce((s, m) => s + m.cogs + m.expenses, 0) / last3.length
    : 0

  // Burn is computed from the USD monthly series, so runway divides USD cash only —
  // never a mixed-currency total.
  const usdCash = cash.totals.USD ?? 0
  const nonUsdCash = Object.entries(cash.totals).filter(([cur]) => cur !== 'USD')
  const runway = burnRate > 0 ? usdCash / burnRate : null

  return (
    <div className="space-y-6">
      {/* Metric cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className="rounded-lg border border-zinc-200 bg-white p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">Cash Position</p>
          <p className="mt-1 text-2xl font-semibold tabular-nums text-zinc-900">{fmt(usdCash)}</p>
          <p className="mt-0.5 text-xs text-zinc-400">
            {nonUsdCash.length > 0
              ? `USD only — plus ${nonUsdCash.map(([cur, v]) => fmtIn(cur)(v)).join(', ')}`
              : `across ${cash.accounts.length} account${cash.accounts.length !== 1 ? 's' : ''}`}
          </p>
        </div>
        <div className="rounded-lg border border-zinc-200 bg-white p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">Monthly Burn Rate</p>
          <p className="mt-1 text-2xl font-semibold tabular-nums text-zinc-900">{fmt(burnRate)}</p>
          <p className="mt-0.5 text-xs text-zinc-400">avg last 3 months</p>
        </div>
        <div className="rounded-lg border border-zinc-200 bg-white p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">Cash Runway</p>
          <p className={`mt-1 text-2xl font-semibold tabular-nums ${runway !== null && runway < 3 ? 'text-red-600' : 'text-zinc-900'}`}>
            {runway !== null ? `${runway.toFixed(1)} mo` : '—'}
          </p>
          <p className="mt-0.5 text-xs text-zinc-400">at current burn</p>
        </div>
      </div>

      {/* Monthly bar chart */}
      <div className="rounded-lg border border-zinc-200 bg-white p-4">
        <h3 className="mb-4 text-sm font-medium text-zinc-700">Monthly Cash Flow — {year}</h3>
        <ResponsiveContainer width="100%" height={280}>
          <BarChart data={chartData} margin={{ top: 4, right: 8, left: 8, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#f4f4f5" />
            <XAxis dataKey="month" tick={{ fontSize: 11 }} />
            <YAxis tick={{ fontSize: 11 }} tickFormatter={v => `$${(v / 1000).toFixed(0)}k`} />
            <Tooltip formatter={(v: number) => fmt(v)} />
            <ReferenceLine y={0} stroke="#a1a1aa" />
            <Bar dataKey="Income" fill="#22c55e" radius={[2, 2, 0, 0]} />
            <Bar dataKey="Expenses" fill="#f87171" radius={[2, 2, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* Account breakdown */}
      {cash.accounts.length > 0 && (
        <div className="rounded-lg border border-zinc-200 bg-white p-4">
          <h3 className="mb-3 text-sm font-medium text-zinc-700">Account Balances</h3>
          <div className="space-y-3">
            {cash.accounts.map(a => (
              <div key={`${a.bank_name}|${a.currency}`} className="flex items-center justify-between">
                <div>
                  <div className="text-sm font-medium text-zinc-800">{a.bank_name}{a.currency !== 'USD' ? ` (${a.currency})` : ''}</div>
                  <div className="text-xs text-zinc-400">As of {a.as_of}</div>
                </div>
                <div className="text-sm font-semibold tabular-nums text-zinc-900">{fmtIn(a.currency)(a.balance)}</div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Monthly breakdown table */}
      <div className="overflow-x-auto rounded-lg border border-zinc-200 bg-white">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-zinc-100 bg-zinc-50">
              <th className="px-4 py-2.5 text-left text-xs font-medium text-zinc-500">Month</th>
              <th className="px-4 py-2.5 text-right text-xs font-medium text-zinc-500">Income</th>
              <th className="px-4 py-2.5 text-right text-xs font-medium text-zinc-500">Expenses</th>
              <th className="px-4 py-2.5 text-right text-xs font-medium text-zinc-500">Net</th>
            </tr>
          </thead>
          <tbody>
            {monthly.map(m => (
              <tr key={m.month} className="border-b border-zinc-50">
                <td className="px-4 py-2 text-zinc-600">{MONTHS[m.month - 1]}</td>
                <td className="px-4 py-2 text-right tabular-nums text-green-600">{m.income > 0 ? fmt(m.income) : '—'}</td>
                <td className="px-4 py-2 text-right tabular-nums text-red-600">{m.cogs + m.expenses > 0 ? fmt(m.cogs + m.expenses) : '—'}</td>
                <td className={`px-4 py-2 text-right tabular-nums font-medium ${m.net >= 0 ? 'text-zinc-800' : 'text-red-600'}`}>
                  {m.net !== 0 ? fmt(m.net) : '—'}
                </td>
              </tr>
            ))}
            <tr className="border-t border-zinc-200 bg-zinc-50 font-semibold">
              <td className="px-4 py-2 text-zinc-700">Total</td>
              <td className="px-4 py-2 text-right tabular-nums text-green-700">{fmt(monthly.reduce((s, m) => s + m.income, 0))}</td>
              <td className="px-4 py-2 text-right tabular-nums text-red-700">{fmt(monthly.reduce((s, m) => s + m.cogs + m.expenses, 0))}</td>
              <td className="px-4 py-2 text-right tabular-nums">{fmt(monthly.reduce((s, m) => s + m.net, 0))}</td>
            </tr>
          </tbody>
        </table>
      </div>

      <TieOutPanel year={year} />
    </div>
  )
}

interface TieOutRowData {
  bank_key: string
  currency: string
  opening_balance: number | null
  closing_balance: number | null
  books_movement: number
  feed_movement: number
  books_rows: number
  feed_rows: number
  expected_closing: number | null
  difference: number | null
}

/**
 * Statement tie-out: enter each bank's opening/closing balance from its statements;
 * the system shows the movement it captured (your books + client payments from the
 * feed) and whether the numbers meet. A difference = movement never captured →
 * import that bank's statements to close the gap.
 */
function TieOutPanel({ year }: { year: number }) {
  const [rows, setRows] = useState<TieOutRowData[]>([])
  const [loading, setLoading] = useState(true)
  const [edits, setEdits] = useState<Record<string, { opening: string; closing: string }>>({})
  const [savingKey, setSavingKey] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(`/api/owner/balances?year=${year}`)
      if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || 'Failed to load tie-out') }
      const data = await res.json()
      setRows(data.rows)
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to load tie-out')
    } finally {
      setLoading(false)
    }
  }, [year])
  useEffect(() => { load() }, [load])

  async function save(row: TieOutRowData) {
    // Edit keys carry the YEAR: saving one row must not wipe balances typed into the
    // others, and a year switch must not leak edits across years.
    const key = `${year}|${row.bank_key}|${row.currency}`
    const edit = edits[key]
    if (!edit) return
    setSavingKey(key)
    try {
      const res = await fetch('/api/owner/balances', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          tax_year: year,
          bank_key: row.bank_key,
          currency: row.currency,
          opening_balance: edit.opening === '' ? null : Number(edit.opening),
          closing_balance: edit.closing === '' ? null : Number(edit.closing),
        }),
      })
      if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(d.error || 'Save failed') }
      toast.success(`${row.bank_key} balances saved`)
      setEdits(m => { const n = { ...m }; delete n[key]; return n })
      load()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Save failed')
    } finally {
      setSavingKey(null)
    }
  }

  const fmtC = (currency: string) => (n: number) =>
    new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: 2 }).format(n)

  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-4">
      <h3 className="mb-1 text-sm font-medium text-zinc-700">Statement tie-out ({year})</h3>
      <p className="mb-3 text-xs text-zinc-500">
        Enter each bank&apos;s opening and closing balance from its statements. Movement counts your
        books AND client payments (real bank activity either way). A difference means transactions
        the system never saw — import that bank&apos;s statements to close the gap.
      </p>
      {loading ? (
        <p className="text-sm text-zinc-400">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-zinc-400">No activity or balances recorded for {year}.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-zinc-100 bg-zinc-50">
                <th className="px-3 py-2 text-left text-xs font-medium text-zinc-500">Bank</th>
                <th className="px-3 py-2 text-right text-xs font-medium text-zinc-500">Opening (statement)</th>
                <th className="px-3 py-2 text-right text-xs font-medium text-zinc-500">Captured movement</th>
                <th className="px-3 py-2 text-right text-xs font-medium text-zinc-500">Expected closing</th>
                <th className="px-3 py-2 text-right text-xs font-medium text-zinc-500">Closing (statement)</th>
                <th className="px-3 py-2 text-right text-xs font-medium text-zinc-500">Difference</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {rows.map(row => {
                const key = `${year}|${row.bank_key}|${row.currency}`
                const edit = edits[key] ?? {
                  opening: row.opening_balance !== null ? String(row.opening_balance) : '',
                  closing: row.closing_balance !== null ? String(row.closing_balance) : '',
                }
                const fmtRow = fmtC(row.currency)
                const movement = row.books_movement + row.feed_movement
                return (
                  <tr key={key} className="border-b border-zinc-50">
                    <td className="px-3 py-2 text-zinc-700">{row.bank_key}{row.currency !== 'USD' ? ` (${row.currency})` : ''}</td>
                    <td className="px-3 py-2 text-right">
                      <input
                        type="number" step="0.01" value={edit.opening} placeholder="—"
                        onChange={e => setEdits(m => ({ ...m, [key]: { ...edit, opening: e.target.value } }))}
                        className="w-28 rounded border border-zinc-200 px-2 py-1 text-right text-sm tabular-nums"
                      />
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-zinc-700" title={`${row.books_rows} books rows + ${row.feed_rows} client-payment rows`}>
                      {fmtRow(movement)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-zinc-500">
                      {row.expected_closing !== null ? fmtRow(row.expected_closing) : '—'}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <input
                        type="number" step="0.01" value={edit.closing} placeholder="—"
                        onChange={e => setEdits(m => ({ ...m, [key]: { ...edit, closing: e.target.value } }))}
                        className="w-28 rounded border border-zinc-200 px-2 py-1 text-right text-sm tabular-nums"
                      />
                    </td>
                    <td className={`px-3 py-2 text-right tabular-nums font-medium ${row.difference === null ? 'text-zinc-400' : Math.abs(row.difference) < 0.01 ? 'text-green-600' : 'text-red-600'}`}>
                      {row.difference === null ? '—' : Math.abs(row.difference) < 0.01 ? '✓ ties' : fmtRow(row.difference)}
                    </td>
                    <td className="px-3 py-2 text-right">
                      <button
                        onClick={() => save(row)}
                        disabled={savingKey === key || !edits[key]}
                        className="rounded border border-zinc-200 px-2 py-1 text-xs text-zinc-600 hover:bg-zinc-50 disabled:opacity-40"
                      >
                        {savingKey === key ? 'Saving…' : 'Save'}
                      </button>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
