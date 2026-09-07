'use client'

import { BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, ReferenceLine } from 'recharts'
import { formatOwnerCurrency, type MonthlyBreakdown, type CashPosition } from '@/lib/owner-finance'

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
const fmt = (n: number) => formatOwnerCurrency(n, 'USD', { maximumFractionDigits: 0 })
const fmtIn = (currency: string) => (n: number) => formatOwnerCurrency(n, currency, { maximumFractionDigits: 0 })

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

  /* The registry holds ONE closing balance per account with no year dimension, so this
   * figure belongs to whenever it was last struck — not to the year in the page header.
   * Undated under a year heading it reads as that year's closing cash, which is the same
   * year-blindness that made the balance sheet state a position it could not support.
   * Fixed on the Overview and the Accounts list; this tab was missed, and at 2023 it
   * showed $41,139 of 2025 money with nothing on screen saying so. */
  const cashDates = [...cash.accounts, ...cash.liabilities].map(a => a.as_of).filter(Boolean).sort()
  const struckOn = cashDates.length > 0 ? cashDates[cashDates.length - 1] : null
  const struckYear = struckOn ? Number(struckOn.slice(0, 4)) : null
  const struckLabel = struckOn
    ? new Date(struckOn + 'T00:00:00').toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' })
    : null
  const cashIsAnotherYear = struckYear !== null && struckYear !== year

  return (
    <div className="space-y-6">
      {/* Metric cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
        <div className={`rounded-lg border bg-white p-4 ${cashIsAnotherYear ? 'border-orange-300' : 'border-zinc-200'}`}>
          <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">Cash Position</p>
          <p className="mt-1 text-2xl font-semibold tabular-nums text-zinc-900">{fmt(usdCash)}</p>
          <p className="mt-0.5 break-words text-xs text-zinc-400">
            {[
              nonUsdCash.length > 0
                ? `USD only — plus ${nonUsdCash.map(([cur, v]) => fmtIn(cur)(v)).join(', ')}`
                : `across ${cash.accounts.length} account${cash.accounts.length !== 1 ? 's' : ''}`,
              struckLabel ? `as at ${struckLabel}` : null,
            ].filter(Boolean).join(' · ')}
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

      {cashIsAnotherYear && (
        <p className="text-sm text-orange-700">
          The cash figure above was last struck in {struckYear}, not {year} — it is the current
          position of the accounts, not this year&apos;s closing balance. The runway divides it by
          {' '}{year}&apos;s spending, so it answers a question about today, not about {year}.
        </p>
      )}

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
    </div>
  )
}
