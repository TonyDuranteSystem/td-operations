'use client'

import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine } from 'recharts'
import type { MonthlyBreakdown, CashPosition } from '@/lib/owner-finance'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const fmt = (n: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n)

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

  const runway = burnRate > 0 ? cash.total / burnRate : null

  return (
    <div className="space-y-6">
      {/* Metric cards */}
      <div className="grid grid-cols-3 gap-4">
        <div className="rounded-lg border border-zinc-200 bg-white p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">Cash Position</p>
          <p className="mt-1 text-2xl font-semibold tabular-nums text-zinc-900">{fmt(cash.total)}</p>
          <p className="mt-0.5 text-xs text-zinc-400">across {cash.accounts.length} account{cash.accounts.length !== 1 ? 's' : ''}</p>
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
              <div key={a.bank_name} className="flex items-center justify-between">
                <div>
                  <div className="text-sm font-medium text-zinc-800">{a.bank_name}</div>
                  <div className="text-xs text-zinc-400">As of {a.as_of}</div>
                </div>
                <div className="text-sm font-semibold tabular-nums text-zinc-900">{fmt(a.balance)}</div>
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
    </div>
  )
}
