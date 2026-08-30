'use client'

import { useState, useEffect } from 'react'
import type { OwnerPnL, PnLBlock } from '@/lib/owner-finance'

const fmtIn = (currency: string) => (n: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: 0 }).format(n)

interface PnLTabProps {
  year: number
  pnl: OwnerPnL
}

export function PnLTab({ year, pnl }: PnLTabProps) {
  const [compare, setCompare] = useState(false)
  const [priorPnl, setPriorPnl] = useState<OwnerPnL | null>(null)
  const [loading, setLoading] = useState(false)

  /**
   * Drop the comparison when the YEAR changes.
   *
   * priorPnl is fetched against the year at click time, and this tab is not
   * remounted when the year <select> navigates. Leaving it in place shows the
   * PREVIOUS request's figures beside the new year — and the toggle relabels
   * itself from the new `year`, so a 2025 comparison would sit under a button
   * reading "Hide 2024 comparison". Wrong year, wrong label, on money.
   * Turning it off is the honest reset: one click re-fetches for the new year.
   */
  useEffect(() => {
    setCompare(false)
    setPriorPnl(null)
  }, [year])

  async function toggleCompare() {
    if (compare) { setCompare(false); return }
    setLoading(true)
    try {
      const res = await fetch(`/api/owner/pnl?year=${year}&compare=true`)
      if (!res.ok) {
        const d = await res.json().catch(() => ({}))
        throw new Error(d.error || 'Failed to load comparison')
      }
      const data = await res.json()
      setPriorPnl(data.prior)
      setCompare(true)
    } catch { /* comparison is optional; the current-year table stays */ } finally {
      setLoading(false)
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium text-zinc-700">Profit &amp; Loss — {year}</h2>
        <button
          onClick={toggleCompare}
          disabled={loading}
          className="rounded-md border border-zinc-200 px-3 py-1.5 text-sm hover:bg-zinc-50 disabled:opacity-50"
        >
          {loading ? 'Loading...' : compare ? `Hide ${year - 1} comparison` : `Compare with ${year - 1}`}
        </button>
      </div>

      {pnl.income_anomalies.length > 0 && (
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-2.5 text-sm text-red-800">
          ⚠ {pnl.income_anomalies.length} invoice{pnl.income_anomalies.length !== 1 ? 's' : ''} with recorded
          cash but a Cancelled/Refunded status — excluded from income, needs review:
          {' '}{pnl.income_anomalies.map(a => a.invoice_number ?? '(no number)').join(', ')}
        </div>
      )}
      {(pnl.approximated_date_count > 0 || pnl.partial_attribution_count > 0) && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-2.5 text-sm text-amber-800">
          {pnl.approximated_date_count > 0 && (
            <p>{pnl.approximated_date_count} paid invoice{pnl.approximated_date_count !== 1 ? 's' : ''} had no
            payment date recorded — counted using the invoice date instead. Fix the paid date in the CRM for exact monthly numbers.</p>
          )}
          {pnl.partial_attribution_count > 0 && (
            <p>{pnl.partial_attribution_count} part-paid invoice{pnl.partial_attribution_count !== 1 ? 's' : ''}:
            all cash received so far is counted on one date, so installments received in different months show under a single month.</p>
          )}
        </div>
      )}

      {pnl.blocks.length === 0 && (
        <div className="rounded-lg border border-zinc-200 bg-white px-4 py-8 text-center text-sm text-zinc-500">
          No activity recorded for {year}.
        </div>
      )}

      {pnl.blocks.map(block => (
        <PnLCurrencyTable
          key={block.currency}
          year={year}
          block={block}
          prior={compare ? priorPnl?.blocks.find(b => b.currency === block.currency) ?? null : null}
          primary={block === pnl.blocks[0]}
        />
      ))}

      {/* A currency active LAST year but silent this year must still show in comparison —
          losing all revenue in a currency is the most interesting year-over-year fact. */}
      {compare && priorPnl?.blocks
        .filter(pb => !pnl.blocks.some(b => b.currency === pb.currency))
        .map(pb => (
          <PnLCurrencyTable
            key={`prior-only-${pb.currency}`}
            year={year}
            block={emptyBlockFor(pb.currency)}
            prior={pb}
            primary={false}
          />
        ))}

      <p className="text-xs text-zinc-400">
        Each currency is reported separately — amounts are never converted or mixed.
        Income comes from paid client invoices; bank transactions cover expenses and other income.
        Stripe&apos;s own processing fees are not booked yet (planned for a later phase).
        Transfers between your own accounts — including payouts from a payment processor — are excluded, because that money is already counted when the invoice was paid.
      </p>
    </div>
  )
}

function emptyBlockFor(currency: string): PnLBlock {
  return {
    currency, invoice_income: 0, other_income: 0, cogs: 0, gross_profit: 0,
    expenses: 0, net_profit: 0, distributions: 0, contributions: 0,
    uncategorized_income: 0, uncategorized_expense: 0, by_subcategory: {},
    monthly: Array.from({ length: 12 }, (_, i) => ({ month: i + 1, income: 0, cogs: 0, expenses: 0, net: 0 })),
  }
}

function PnLCurrencyTable({ year, block, prior, primary }: {
  year: number
  block: PnLBlock
  prior: PnLBlock | null
  primary: boolean
}) {
  const fmt = fmtIn(block.currency)
  const hasUncategorized = block.uncategorized_income > 0 || block.uncategorized_expense > 0
  const showPrior = prior !== null
  const pct = (cur: number, pri: number | undefined) =>
    pri === undefined || pri === 0 ? null : (cur - pri) / Math.abs(pri)

  return (
    <div className="space-y-3">
      {!primary && (
        <h3 className="text-sm font-medium text-zinc-700">{block.currency} activity (unconverted)</h3>
      )}

      {hasUncategorized && (
        <div className="rounded-lg border border-orange-200 bg-orange-50 px-4 py-2.5 text-sm text-orange-800">
          ⚠ {fmt(block.uncategorized_expense)} in uncategorized expenses and {fmt(block.uncategorized_income)} in
          uncategorized income are included in Net below as-is. Categorize transactions for an accurate split.
        </div>
      )}

      <div className="overflow-x-auto rounded-lg border border-zinc-200 bg-white">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-zinc-100 bg-zinc-50">
              <th className="px-4 py-2.5 text-left text-xs font-medium text-zinc-500">
                Line Item {!primary && <span className="ml-1 rounded bg-zinc-200 px-1.5 py-0.5 text-[10px] font-semibold">{block.currency}</span>}
              </th>
              <th className="px-4 py-2.5 text-right text-xs font-medium text-zinc-500">{year}</th>
              {showPrior && (
                <>
                  <th className="px-4 py-2.5 text-right text-xs font-medium text-zinc-500">{year - 1}</th>
                  <th className="px-4 py-2.5 text-right text-xs font-medium text-zinc-500">Δ %</th>
                </>
              )}
            </tr>
          </thead>
          <tbody>
            <PnLSection label="Income" cols={showPrior ? 4 : 2} />
            <PnLRow fmt={fmt} label="Client invoices (payments ledger)" value={block.invoice_income} prior={prior?.invoice_income} variancePct={showPrior ? pct(block.invoice_income, prior?.invoice_income) : undefined} indent />
            {(block.other_income !== 0 || (prior?.other_income ?? 0) !== 0) && (
              <PnLRow fmt={fmt} label="Other income (rewards, bonuses)" value={block.other_income} prior={prior?.other_income} indent />
            )}
            <PnLSection label="Cost of Goods Sold" cols={showPrior ? 4 : 2} />
            <PnLRow fmt={fmt} label="Contractors / COGS" value={-block.cogs} prior={prior ? -prior.cogs : undefined} indent />
            <PnLRow fmt={fmt} label="Gross Profit" value={block.gross_profit} prior={prior?.gross_profit} variancePct={showPrior ? pct(block.gross_profit, prior?.gross_profit) : undefined} bold />
            <PnLSection label="Operating Expenses" cols={showPrior ? 4 : 2} />
            <PnLRow fmt={fmt} label="Total Operating Expenses" value={-block.expenses} prior={prior ? -prior.expenses : undefined} indent />
            {hasUncategorized && (
              <>
                {block.uncategorized_income > 0 && <PnLRow fmt={fmt} label="Uncategorized Income" value={block.uncategorized_income} warn indent />}
                {block.uncategorized_expense > 0 && <PnLRow fmt={fmt} label="Uncategorized Expenses" value={-block.uncategorized_expense} warn indent />}
              </>
            )}
            <tr><td colSpan={showPrior ? 4 : 2} className="border-t border-zinc-200" /></tr>
            <PnLRow fmt={fmt} label="Net Profit" value={block.net_profit} prior={prior?.net_profit} variancePct={showPrior ? pct(block.net_profit, prior?.net_profit) : undefined} bold highlight />

            {(block.distributions > 0 || block.contributions > 0) && (
              <>
                <tr><td colSpan={showPrior ? 4 : 2} className="py-1" /></tr>
                <PnLSection label="Equity (not in profit)" cols={showPrior ? 4 : 2} />
                {block.distributions > 0 && <PnLRow fmt={fmt} label="Owner Distributions" value={-block.distributions} prior={prior ? -prior.distributions : undefined} indent />}
                {block.contributions > 0 && <PnLRow fmt={fmt} label="Owner Contributions" value={block.contributions} prior={prior?.contributions} indent />}
              </>
            )}
          </tbody>
        </table>
      </div>

      {primary && Object.keys(block.by_subcategory).length > 0 && (
        <div className="rounded-lg border border-zinc-200 bg-white p-4">
          <h3 className="mb-3 text-sm font-medium text-zinc-700">Expenses by Subcategory</h3>
          <div className="grid grid-cols-2 gap-x-8 gap-y-1.5 lg:grid-cols-3">
            {Object.entries(block.by_subcategory)
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

function PnLSection({ label, cols, warn }: { label: string; cols: number; warn?: boolean }) {
  return (
    <tr>
      <td colSpan={cols} className={`px-4 pt-3 pb-1 text-xs font-semibold uppercase tracking-wide ${warn ? 'text-orange-600' : 'text-zinc-400'}`}>
        {label}
      </td>
    </tr>
  )
}

function PnLRow({
  fmt, label, value, prior, variancePct, indent, bold, highlight, warn,
}: {
  fmt: (n: number) => string
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
  const fmtPct = (n: number | null) =>
    n === null ? '—' : `${n >= 0 ? '+' : ''}${(n * 100).toFixed(1)}%`

  return (
    <tr className={highlight ? 'bg-zinc-50' : ''}>
      <td className={`px-4 py-1.5 ${indent ? 'pl-8' : ''} ${bold ? 'font-medium text-zinc-800' : 'text-zinc-600'}`}>{label}</td>
      <td className={`px-4 py-1.5 text-right tabular-nums ${bold ? 'font-semibold' : ''} ${color}`}>{fmt(value)}</td>
      {prior !== undefined ? (
        <>
          <td className="px-4 py-1.5 text-right tabular-nums text-zinc-400">{fmt(prior)}</td>
          <td className={`px-4 py-1.5 text-right text-xs tabular-nums ${variancePct !== undefined && variancePct !== null ? (variancePct >= 0 ? 'text-green-600' : 'text-red-600') : 'text-zinc-400'}`}>
            {fmtPct(variancePct ?? null)}
          </td>
        </>
      ) : null}
    </tr>
  )
}
