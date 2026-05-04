'use client'

import { useState } from 'react'
import type { OwnerPnL } from '@/lib/owner-finance'

const fmt = (n: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n)

const fmtPct = (n: number | null) =>
  n === null ? '—' : `${n >= 0 ? '+' : ''}${(n * 100).toFixed(1)}%`

interface PnLTabProps {
  year: number
  pnl: OwnerPnL
}

export function PnLTab({ year, pnl }: PnLTabProps) {
  const [compare, setCompare] = useState(false)
  const [priorPnl, setPriorPnl] = useState<OwnerPnL | null>(null)
  const [variance, setVariance] = useState<Record<string, number | null> | null>(null)
  const [loading, setLoading] = useState(false)

  async function toggleCompare() {
    if (compare) { setCompare(false); return }
    setLoading(true)
    try {
      const res = await fetch(`/api/owner/pnl?year=${year}&compare=true`)
      if (!res.ok) throw new Error('Failed to load comparison')
      const data = await res.json()
      setPriorPnl(data.prior)
      setVariance(data.variance)
      setCompare(true)
    } catch { /* ignore */ } finally {
      setLoading(false)
    }
  }

  const hasUncategorized = pnl.uncategorized_income > 0 || pnl.uncategorized_expense > 0

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-zinc-700">Profit & Loss — {year}</h2>
        <button
          onClick={toggleCompare}
          disabled={loading}
          className="rounded-md border border-zinc-200 px-3 py-1.5 text-sm hover:bg-zinc-50 disabled:opacity-50"
        >
          {loading ? 'Loading...' : compare ? `Hide ${year - 1} comparison` : `Compare with ${year - 1}`}
        </button>
      </div>

      {hasUncategorized && (
        <div className="rounded-lg border border-orange-200 bg-orange-50 px-4 py-2.5 text-sm text-orange-800">
          ⚠ {fmt(pnl.uncategorized_expense)} in uncategorized expenses and {fmt(pnl.uncategorized_income)} in uncategorized income are excluded from totals below.
          Categorize transactions first for accurate P&L.
        </div>
      )}

      <div className="overflow-x-auto rounded-lg border border-zinc-200 bg-white">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-zinc-100 bg-zinc-50">
              <th className="px-4 py-2.5 text-left text-xs font-medium text-zinc-500">Line Item</th>
              <th className="px-4 py-2.5 text-right text-xs font-medium text-zinc-500">{year}</th>
              {compare && priorPnl && (
                <>
                  <th className="px-4 py-2.5 text-right text-xs font-medium text-zinc-500">{year - 1}</th>
                  <th className="px-4 py-2.5 text-right text-xs font-medium text-zinc-500">Δ %</th>
                </>
              )}
            </tr>
          </thead>
          <tbody>
            <PnLSection label="Operating Income" />
            <PnLRow label="Revenue" value={pnl.income} prior={compare ? priorPnl?.income : undefined} variancePct={compare ? variance?.income_pct : undefined} />
            <PnLSection label="Cost of Goods Sold" />
            <PnLRow label="Contractors / COGS" value={-pnl.cogs} prior={compare ? (priorPnl ? -priorPnl.cogs : undefined) : undefined} indent />
            <PnLRow label="Gross Profit" value={pnl.gross_profit} prior={compare ? priorPnl?.gross_profit : undefined} variancePct={compare ? variance?.gross_profit_pct : undefined} bold />
            <PnLSection label="Operating Expenses" />
            <PnLRow label="Total Operating Expenses" value={-pnl.expenses} prior={compare ? (priorPnl ? -priorPnl.expenses : undefined) : undefined} indent />
            <tr><td colSpan={compare ? 4 : 2} className="border-t border-zinc-200" /></tr>
            <PnLRow label="Net Profit" value={pnl.net_profit} prior={compare ? priorPnl?.net_profit : undefined} variancePct={compare ? variance?.net_profit_pct : undefined} bold highlight />

            {pnl.distributions > 0 && (
              <>
                <tr><td colSpan={compare ? 4 : 2} className="py-1" /></tr>
                <PnLSection label="Other" />
                <PnLRow label="Owner Distributions" value={-pnl.distributions} prior={compare ? (priorPnl ? -priorPnl.distributions : undefined) : undefined} indent />
              </>
            )}

            {hasUncategorized && (
              <>
                <tr><td colSpan={compare ? 4 : 2} className="py-1" /></tr>
                <PnLSection label="Uncategorized (excluded above)" warn />
                {pnl.uncategorized_income > 0 && <PnLRow label="Uncategorized Income" value={pnl.uncategorized_income} warn indent />}
                {pnl.uncategorized_expense > 0 && <PnLRow label="Uncategorized Expenses" value={-pnl.uncategorized_expense} warn indent />}
              </>
            )}
          </tbody>
        </table>
      </div>

      {/* By subcategory */}
      {Object.keys(pnl.by_subcategory).length > 0 && (
        <div className="rounded-lg border border-zinc-200 bg-white p-4">
          <h3 className="mb-3 text-sm font-medium text-zinc-700">Expenses by Subcategory</h3>
          <div className="grid grid-cols-2 gap-x-8 gap-y-1.5 lg:grid-cols-3">
            {Object.entries(pnl.by_subcategory)
              .sort((a, b) => b[1] - a[1])
              .map(([name, amount]) => (
                <div key={name} className="flex justify-between text-sm">
                  <span className="capitalize text-zinc-600">{name.replace(/_/g, ' ')}</span>
                  <span className="tabular-nums text-zinc-800">{fmt(amount)}</span>
                </div>
              ))}
          </div>
        </div>
      )}
    </div>
  )
}

function PnLSection({ label, warn }: { label: string; warn?: boolean }) {
  return (
    <tr>
      <td colSpan={4} className={`px-4 pt-3 pb-1 text-xs font-semibold uppercase tracking-wide ${warn ? 'text-orange-600' : 'text-zinc-400'}`}>
        {label}
      </td>
    </tr>
  )
}

function PnLRow({
  label, value, prior, variancePct, indent, bold, highlight, warn,
}: {
  label: string
  value: number
  prior?: number
  variancePct?: number | null
  indent?: boolean
  bold?: boolean
  highlight?: boolean
  warn?: boolean
}) {
  const color = warn ? 'text-orange-600' : value < 0 ? 'text-red-600' : value > 0 ? 'text-zinc-800' : 'text-zinc-400'
  const fmt2 = (n: number | undefined) => n !== undefined ? fmt(n) : '—'

  return (
    <tr className={highlight ? 'bg-zinc-50' : ''}>
      <td className={`px-4 py-1.5 ${indent ? 'pl-8' : ''} ${bold ? 'font-medium text-zinc-800' : 'text-zinc-600'}`}>{label}</td>
      <td className={`px-4 py-1.5 text-right tabular-nums ${bold ? 'font-semibold' : ''} ${color}`}>{fmt(value)}</td>
      {prior !== undefined && (
        <>
          <td className="px-4 py-1.5 text-right tabular-nums text-zinc-400">{fmt2(prior)}</td>
          <td className={`px-4 py-1.5 text-right text-xs tabular-nums ${variancePct !== undefined && variancePct !== null ? (variancePct >= 0 ? 'text-green-600' : 'text-red-600') : 'text-zinc-400'}`}>
            {fmtPct(variancePct ?? null)}
          </td>
        </>
      )}
    </tr>
  )
}
