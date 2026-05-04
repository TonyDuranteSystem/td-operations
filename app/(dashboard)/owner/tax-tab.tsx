'use client'

import { useState } from 'react'

const fmt = (n: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n)

const QUARTERLY_DEADLINES: Record<number, { label: string; due: string }> = {
  1: { label: 'Q1 (Jan–Mar)', due: 'Apr 15' },
  2: { label: 'Q2 (Apr–Jun)', due: 'Jun 16' },
  3: { label: 'Q3 (Jul–Sep)', due: 'Sep 15' },
  4: { label: 'Q4 (Oct–Dec)', due: 'Jan 15 (next year)' },
}

interface TaxTabProps {
  year: number
  netProfit: number
}

export function TaxTab({ year, netProfit }: TaxTabProps) {
  const [effectiveRate, setEffectiveRate] = useState(25)

  const adjustedAnnual = Math.max(0, netProfit * (effectiveRate / 100))
  const adjustedQuarterly = adjustedAnnual / 4

  const currentMonth = new Date().getMonth() + 1
  const currentYear = new Date().getFullYear()
  const isCurrentYear = year === currentYear
  const currentQuarter = Math.ceil(currentMonth / 3)

  const seRate = 0.1413
  const incomeTaxRate = effectiveRate / 100 - seRate
  const seTax = Math.max(0, netProfit * seRate)
  const incomeTax = Math.max(0, netProfit * Math.max(0, incomeTaxRate))

  return (
    <div className="space-y-6">
      {/* Header inputs */}
      <div className="rounded-lg border border-zinc-200 bg-white p-4">
        <h3 className="mb-4 text-sm font-medium text-zinc-700">Tax Settings</h3>
        <div className="flex items-center gap-6">
          <div>
            <label className="text-xs text-zinc-500">Effective Tax Rate (%)</label>
            <div className="mt-1 flex items-center gap-2">
              <input
                type="number"
                value={effectiveRate}
                onChange={e => setEffectiveRate(Number(e.target.value))}
                min={0}
                max={60}
                step={1}
                className="w-20 rounded-md border border-zinc-200 px-3 py-1.5 text-sm tabular-nums"
              />
              <span className="text-sm text-zinc-400">%</span>
            </div>
          </div>
          <div>
            <label className="text-xs text-zinc-500">Net Profit</label>
            <div className="mt-1 text-sm font-semibold text-zinc-800 tabular-nums">{fmt(netProfit)}</div>
          </div>
        </div>
      </div>

      {/* Tax summary cards */}
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <div className="rounded-lg border border-zinc-200 bg-white p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">Annual Est.</p>
          <p className="mt-1 text-2xl font-semibold tabular-nums text-zinc-900">{fmt(adjustedAnnual)}</p>
        </div>
        <div className="rounded-lg border border-zinc-200 bg-white p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">Per Quarter</p>
          <p className="mt-1 text-2xl font-semibold tabular-nums text-zinc-900">{fmt(adjustedQuarterly)}</p>
        </div>
        <div className="rounded-lg border border-zinc-200 bg-white p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">Self-Employment Tax</p>
          <p className="mt-1 text-2xl font-semibold tabular-nums text-zinc-900">{fmt(seTax)}</p>
          <p className="mt-0.5 text-xs text-zinc-400">14.13% of net profit</p>
        </div>
        <div className="rounded-lg border border-zinc-200 bg-white p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">Income Tax Est.</p>
          <p className="mt-1 text-2xl font-semibold tabular-nums text-zinc-900">{fmt(incomeTax)}</p>
          <p className="mt-0.5 text-xs text-zinc-400">{Math.max(0, incomeTaxRate * 100).toFixed(1)}% effective rate</p>
        </div>
      </div>

      {/* Quarterly payment schedule */}
      <div className="overflow-x-auto rounded-lg border border-zinc-200 bg-white">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-zinc-100 bg-zinc-50">
              <th className="px-4 py-2.5 text-left text-xs font-medium text-zinc-500">Quarter</th>
              <th className="px-4 py-2.5 text-left text-xs font-medium text-zinc-500">Due Date</th>
              <th className="px-4 py-2.5 text-right text-xs font-medium text-zinc-500">Required</th>
              <th className="px-4 py-2.5 text-right text-xs font-medium text-zinc-500">Status</th>
            </tr>
          </thead>
          <tbody>
            {[1, 2, 3, 4].map(q => {
              const deadline = QUARTERLY_DEADLINES[q]
              const isPast = isCurrentYear ? q < currentQuarter : year < currentYear
              const isCurrent = isCurrentYear && q === currentQuarter
              return (
                <tr key={q} className={`border-b border-zinc-50 ${isCurrent ? 'bg-blue-50' : ''}`}>
                  <td className="px-4 py-2.5 text-zinc-700">
                    {deadline.label}
                    {isCurrent && <span className="ml-2 rounded-full bg-blue-100 px-2 py-0.5 text-xs text-blue-700">Current</span>}
                  </td>
                  <td className="px-4 py-2.5 text-zinc-500">{deadline.due}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums font-medium text-zinc-800">{fmt(adjustedQuarterly)}</td>
                  <td className="px-4 py-2.5 text-right">
                    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${isPast ? 'bg-zinc-100 text-zinc-500' : isCurrent ? 'bg-orange-100 text-orange-700' : 'bg-zinc-50 text-zinc-400'}`}>
                      {isPast ? 'Past' : isCurrent ? 'Due soon' : 'Upcoming'}
                    </span>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      <div className="rounded-lg border border-zinc-200 bg-zinc-50 px-4 py-3 text-xs text-zinc-500">
        Estimates are for planning only and do not constitute tax advice. Consult your accountant for final numbers.
        Safe harbor: paying 100% of prior year&apos;s tax avoids underpayment penalties.
      </div>
    </div>
  )
}
