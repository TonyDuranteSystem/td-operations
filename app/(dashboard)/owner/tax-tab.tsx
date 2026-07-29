'use client'

import type { OwnerPnL, PnLBlock } from '@/lib/owner-finance'

const fmtIn = (currency: string) => (n: number) =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency, maximumFractionDigits: 0 }).format(n)
const fmt = fmtIn('USD')

interface TaxTabProps {
  year: number
  pnl: OwnerPnL
}

/**
 * S-corp tax view. The old flat 25% + self-employment estimate was DELETED (Phase 1b):
 * it was sole-proprietor math, and Tony Durante LLC files an 1120-S — flow-through
 * profit carries NO self-employment tax, the owner is paid a W-2 salary, and personal
 * estimates depend on the whole personal return. No fake numbers here: the tab shows
 * the real book figures the CPA needs and says plainly where the tax answer comes from.
 */
export function TaxTab({ year, pnl }: TaxTabProps) {
  const usd: PnLBlock | undefined = pnl.blocks.find(b => b.currency === 'USD')
  const others = pnl.blocks.filter(b => b.currency !== 'USD')

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <Card label="Net Profit (books)" value={fmt(usd?.net_profit ?? 0)} sub={`${year} YTD, USD`} />
        <Card label="Owner Distributions" value={fmt(usd?.distributions ?? 0)} sub={`${year} YTD`} />
        <Card label="Owner Contributions" value={fmt(usd?.contributions ?? 0)} sub={`${year} YTD`} />
        <Card label="Uncategorized" value={fmt((usd?.uncategorized_income ?? 0) - (usd?.uncategorized_expense ?? 0))} sub="net effect on profit" />
      </div>

      {others.map(b => (
        <div key={b.currency} className="rounded-lg border border-zinc-200 bg-white px-4 py-3 text-sm text-zinc-600">
          {b.currency} activity (unconverted): net profit {fmtIn(b.currency)(b.net_profit)}, distributions {fmtIn(b.currency)(b.distributions)}.
        </div>
      ))}

      <div className="rounded-lg border border-zinc-200 bg-white p-4 text-sm text-zinc-700 space-y-2">
        <h3 className="font-medium">How this company is taxed</h3>
        <p>
          Tony Durante LLC is an <strong>S-corporation</strong>: the company itself pays no federal income
          tax. Profit flows to the owner&apos;s personal return via the K-1, and the owner is paid a
          reasonable W-2 salary (with payroll withholding) on top of distributions.
        </p>
        <p>
          There is <strong>no self-employment tax</strong> on the flow-through profit, and no flat
          percentage that can estimate the personal bill — it depends on the whole personal return.
          Quarterly estimates and the safe-harbor amount come from the CPA.
        </p>
      </div>

      <div className="rounded-lg border border-zinc-200 bg-zinc-50 px-4 py-3 text-xs text-zinc-500">
        Book figures only — not tax advice. Final numbers come from the filed 1120-S prepared by the accountant.
      </div>
    </div>
  )
}

function Card({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums text-zinc-900">{value}</p>
      {sub && <p className="mt-0.5 text-xs text-zinc-400">{sub}</p>}
    </div>
  )
}
