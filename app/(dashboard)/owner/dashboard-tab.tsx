'use client'

import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from 'recharts'
import type { OwnerPnL, CashPosition } from '@/lib/owner-finance'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

const fmt = (n: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n)

interface DashboardTabProps {
  pnl: OwnerPnL
  cash: CashPosition
  uncategorizedCount: number
  taxEstimate: { annual: number; quarterly: number }
  year: number
  onTabSwitch: (tab: string) => void
}

export function DashboardTab({ pnl, cash, uncategorizedCount, taxEstimate, year, onTabSwitch }: DashboardTabProps) {
  const chartData = pnl.monthly.map(m => ({
    month: MONTHS[m.month - 1],
    Income: m.income,
    Expenses: m.cogs + m.expenses,
    Net: m.net,
  }))

  const topSubcategories = Object.entries(pnl.by_subcategory)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)

  return (
    <div className="space-y-6">
      {/* KPI Cards */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <KpiCard label="Net Profit" value={fmt(pnl.net_profit)} sub={`${year} YTD`} positive={pnl.net_profit > 0} />
        <KpiCard label="Cash Position" value={fmt(cash.total)} sub={`${cash.accounts.length} account${cash.accounts.length !== 1 ? 's' : ''}`} />
        <KpiCard
          label="Uncategorized"
          value={String(uncategorizedCount)}
          sub="transactions"
          warn={uncategorizedCount > 0}
          onClick={() => onTabSwitch('transactions')}
        />
        <KpiCard label="Est. Tax Due" value={fmt(taxEstimate.quarterly)} sub="per quarter" />
      </div>

      {/* Cash accounts breakdown */}
      {cash.accounts.length > 0 && (
        <div className="rounded-lg border border-zinc-200 bg-white p-4">
          <h3 className="mb-3 text-sm font-medium text-zinc-700">Cash by Account</h3>
          <div className="space-y-2">
            {cash.accounts.map(a => (
              <div key={a.bank_name} className="flex items-center justify-between text-sm">
                <span className="text-zinc-600">{a.bank_name}</span>
                <span className="font-medium tabular-nums">{fmt(a.balance)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Monthly chart */}
      <div className="rounded-lg border border-zinc-200 bg-white p-4">
        <h3 className="mb-4 text-sm font-medium text-zinc-700">Monthly Income vs Expenses ({year})</h3>
        <ResponsiveContainer width="100%" height={240}>
          <BarChart data={chartData} margin={{ top: 4, right: 8, left: 8, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#f4f4f5" />
            <XAxis dataKey="month" tick={{ fontSize: 11 }} />
            <YAxis tick={{ fontSize: 11 }} tickFormatter={v => `$${(v / 1000).toFixed(0)}k`} />
            <Tooltip formatter={(v: number) => fmt(v)} />
            <Legend />
            <Bar dataKey="Income" fill="#22c55e" radius={[2, 2, 0, 0]} />
            <Bar dataKey="Expenses" fill="#f87171" radius={[2, 2, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* P&L summary + top subcategories */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="rounded-lg border border-zinc-200 bg-white p-4">
          <h3 className="mb-3 text-sm font-medium text-zinc-700">P&L Summary</h3>
          <PnLRow label="Revenue" value={pnl.income} />
          <PnLRow label="COGS" value={-pnl.cogs} indent />
          <PnLRow label="Gross Profit" value={pnl.gross_profit} bold />
          <PnLRow label="Operating Expenses" value={-pnl.expenses} indent />
          <div className="my-1 border-t border-zinc-100" />
          <PnLRow label="Net Profit" value={pnl.net_profit} bold positive />
          {pnl.uncategorized_expense > 0 && (
            <div className="mt-2 rounded bg-orange-50 px-2 py-1 text-xs text-orange-700">
              ⚠ {fmt(pnl.uncategorized_expense)} uncategorized expenses excluded
            </div>
          )}
        </div>

        {topSubcategories.length > 0 && (
          <div className="rounded-lg border border-zinc-200 bg-white p-4">
            <h3 className="mb-3 text-sm font-medium text-zinc-700">Top Expense Categories</h3>
            <div className="space-y-2">
              {topSubcategories.map(([name, amount]) => (
                <div key={name} className="flex items-center justify-between text-sm">
                  <span className="capitalize text-zinc-600">{name.replace(/_/g, ' ')}</span>
                  <span className="font-medium tabular-nums text-zinc-800">{fmt(amount)}</span>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function KpiCard({
  label, value, sub, positive, warn, onClick,
}: {
  label: string
  value: string
  sub?: string
  positive?: boolean
  warn?: boolean
  onClick?: () => void
}) {
  return (
    <div
      className={`rounded-lg border p-4 ${warn ? 'border-orange-200 bg-orange-50 cursor-pointer hover:bg-orange-100' : 'border-zinc-200 bg-white'}`}
      onClick={onClick}
    >
      <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">{label}</p>
      <p className={`mt-1 text-2xl font-semibold tabular-nums ${positive !== undefined ? (positive ? 'text-green-600' : 'text-red-600') : warn ? 'text-orange-700' : 'text-zinc-900'}`}>
        {value}
      </p>
      {sub && <p className="mt-0.5 text-xs text-zinc-400">{sub}</p>}
    </div>
  )
}

function PnLRow({ label, value, indent, bold, positive }: { label: string; value: number; indent?: boolean; bold?: boolean; positive?: boolean }) {
  const color = positive ? (value >= 0 ? 'text-green-600' : 'text-red-600') : value < 0 ? 'text-red-600' : 'text-zinc-800'
  return (
    <div className={`flex items-center justify-between py-0.5 text-sm ${indent ? 'pl-3' : ''}`}>
      <span className={bold ? 'font-medium text-zinc-800' : 'text-zinc-600'}>{label}</span>
      <span className={`tabular-nums ${bold ? 'font-semibold' : ''} ${color}`}>
        {new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(value)}
      </span>
    </div>
  )
}
