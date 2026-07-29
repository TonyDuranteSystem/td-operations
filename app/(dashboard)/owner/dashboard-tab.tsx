'use client'

import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend } from 'recharts'
import type { OwnerPnL, PnLBlock, CashPosition } from '@/lib/owner-finance'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

const fmtIn = (currency: string) => (n: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: 0 }).format(n)
const fmt = fmtIn('USD')

const EMPTY_BLOCK: PnLBlock = {
  currency: 'USD', invoice_income: 0, other_income: 0, cogs: 0, gross_profit: 0,
  expenses: 0, net_profit: 0, distributions: 0, contributions: 0,
  uncategorized_income: 0, uncategorized_expense: 0, by_subcategory: {},
  monthly: Array.from({ length: 12 }, (_, i) => ({ month: i + 1, income: 0, cogs: 0, expenses: 0, net: 0 })),
}

interface DashboardTabProps {
  pnl: OwnerPnL
  cash: CashPosition
  uncategorizedCount: number
  year: number
  onTabSwitch: (tab: string) => void
}

export function DashboardTab({ pnl, cash, uncategorizedCount, year, onTabSwitch }: DashboardTabProps) {
  const usd = pnl.blocks.find(b => b.currency === 'USD') ?? EMPTY_BLOCK
  const others = pnl.blocks.filter(b => b.currency !== 'USD')

  const chartData = usd.monthly.map(m => ({
    month: MONTHS[m.month - 1],
    Income: m.income,
    Expenses: m.cogs + m.expenses,
    Net: m.net,
  }))

  const topSubcategories = Object.entries(usd.by_subcategory)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)

  const cashEntries = Object.entries(cash.totals)
  const usdCash = cash.totals.USD ?? 0
  const nonUsdCash = cashEntries.filter(([cur]) => cur !== 'USD')

  return (
    <div className="space-y-6">
      {/* KPI Cards (USD) */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <KpiCard
          label="Net Profit"
          value={fmt(usd.net_profit)}
          sub={uncategorizedCount > 0 ? `${year} YTD (USD) — provisional, categorize transactions` : `${year} YTD (USD)`}
          positive={usd.net_profit > 0}
        />
        <KpiCard
          label="Cash Position"
          value={fmt(usdCash)}
          sub={nonUsdCash.length > 0
            ? `USD only — plus ${nonUsdCash.map(([cur, v]) => fmtIn(cur)(v)).join(', ')}`
            : `${cash.accounts.length} account${cash.accounts.length !== 1 ? 's' : ''}`}
        />
        <KpiCard
          label="Uncategorized"
          value={String(uncategorizedCount)}
          sub="transactions"
          warn={uncategorizedCount > 0}
          onClick={() => onTabSwitch('transactions')}
        />
        <KpiCard label="Distributions" value={fmt(usd.distributions)} sub={`${year} YTD`} />
      </div>

      {/* Non-USD activity — never mixed into the USD numbers above */}
      {others.length > 0 && (
        <div className="rounded-lg border border-zinc-200 bg-white p-4">
          <h3 className="mb-2 text-sm font-medium text-zinc-700">Other currencies (unconverted)</h3>
          <div className="space-y-1.5">
            {others.map(b => (
              <div key={b.currency} className="flex items-center justify-between text-sm">
                <span className="text-zinc-600">{b.currency} — invoice income {fmtIn(b.currency)(b.invoice_income)}</span>
                <span className="tabular-nums text-zinc-800">net {fmtIn(b.currency)(b.net_profit)}</span>
              </div>
            ))}
          </div>
          <p className="mt-2 text-xs text-zinc-400">Full detail in the P&amp;L tab. Amounts are never converted or summed across currencies.</p>
        </div>
      )}

      {/* Cash accounts breakdown — each balance in its own currency */}
      {cash.accounts.length > 0 && (
        <div className="rounded-lg border border-zinc-200 bg-white p-4">
          <h3 className="mb-3 text-sm font-medium text-zinc-700">Cash by Account</h3>
          <div className="space-y-2">
            {cash.accounts.map(a => (
              <div key={`${a.bank_name}|${a.currency}`} className="flex items-center justify-between text-sm">
                <span className="text-zinc-600">{a.bank_name}{a.currency !== 'USD' ? ` (${a.currency})` : ''}</span>
                <span className="font-medium tabular-nums">{fmtIn(a.currency)(a.balance)}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Monthly chart */}
      <div className="rounded-lg border border-zinc-200 bg-white p-4">
        <h3 className="mb-4 text-sm font-medium text-zinc-700">Monthly Income vs Expenses ({year}, USD)</h3>
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
          <h3 className="mb-3 text-sm font-medium text-zinc-700">P&amp;L Summary (USD)</h3>
          <PnLRow label="Client invoice income" value={usd.invoice_income} />
          {usd.other_income !== 0 && <PnLRow label="Other income" value={usd.other_income} indent />}
          <PnLRow label="COGS" value={-usd.cogs} indent />
          <PnLRow label="Gross Profit" value={usd.gross_profit} bold />
          <PnLRow label="Operating Expenses" value={-usd.expenses} indent />
          <div className="my-1 border-t border-zinc-100" />
          <PnLRow label="Net Profit" value={usd.net_profit} bold positive />
          {usd.uncategorized_expense > 0 && (
            <div className="mt-2 rounded bg-orange-50 px-2 py-1 text-xs text-orange-700">
              ⚠ includes {fmt(usd.uncategorized_expense)} uncategorized expenses
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
        {fmt(value)}
      </span>
    </div>
  )
}
