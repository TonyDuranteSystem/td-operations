'use client'

import { formatOwnerCurrency, type OwnerPnL, type PnLBlock, type FilingSummary } from '@/lib/owner-finance'

const fmtIn = (currency: string) => (n: number) => formatOwnerCurrency(n, currency, { maximumFractionDigits: 0 })
const fmt = fmtIn('USD')

interface TaxTabProps {
  year: number
  pnl: OwnerPnL
  filing: FilingSummary
}

/**
 * S-corp tax view. The old flat 25% + self-employment estimate was DELETED (Phase 1b):
 * it was sole-proprietor math, and Tony Durante LLC files an 1120-S — flow-through
 * profit carries NO self-employment tax, the owner is paid a W-2 salary, and personal
 * estimates depend on the whole personal return. No fake numbers here: the tab shows
 * the real book figures the CPA needs and says plainly where the tax answer comes from.
 */
export function TaxTab({ year, pnl, filing }: TaxTabProps) {
  const usd: PnLBlock | undefined = pnl.blocks.find(b => b.currency === 'USD')
  const others = pnl.blocks.filter(b => b.currency !== 'USD')

  const money = (n: number) => formatOwnerCurrency(n, 'USD')

  return (
    <div className="space-y-6">
      {/* THE NUMBER FOR THE RETURN.
          The books say what happened; this says what the tax code makes of it. Kept as a
          separate panel — and every adjustment named and priced — so whoever files can see
          exactly which figures are facts about the year and which are decisions about the
          rules, and disagree with the second without touching the first. */}
      <div className="rounded-lg border border-zinc-300 bg-white p-4">
        <div className="mb-1 flex items-start justify-between gap-3">
          <h3 className="text-sm font-medium text-zinc-800">For the {filing.year} return</h3>
          <a
            href={`/api/owner/export?year=${filing.year}`}
            className="shrink-0 rounded border border-zinc-300 px-2.5 py-1 text-xs font-medium text-zinc-700 hover:bg-zinc-50"
          >
            Export for accountant
          </a>
        </div>
        <p className="mb-3 text-xs text-zinc-500">
          The books, with tax treatment applied. Nothing here changes a transaction —
          the ledger keeps recording what actually happened.
        </p>
        <div className="space-y-1.5 text-sm">
          <div className="flex justify-between">
            <span className="text-zinc-600">Profit as the books report it</span>
            <span className="tabular-nums">{money(filing.books_net_usd)}</span>
          </div>
          {filing.foreign.map(f => (
            <div key={f.currency} className="flex justify-between">
              <span className="text-zinc-600">
                {f.currency} profit {new Intl.NumberFormat('en-US', { minimumFractionDigits: 2 }).format(f.net)}
                {f.rate !== null && <span className="text-zinc-400"> — converted at {f.rate.toFixed(6)}, the rate you actually achieved</span>}
              </span>
              <span className="tabular-nums">
                {f.net_usd === null ? <span className="text-orange-600">needs manual conversion</span> : money(f.net_usd)}
              </span>
            </div>
          ))}
          {filing.adjustments.map(a => (
            <div key={a.label} className="flex justify-between">
              <span className="text-zinc-600">{a.label}<span className="block text-xs text-zinc-400">{a.why}</span></span>
              <span className="tabular-nums">{money(a.amount)}</span>
            </div>
          ))}
          <div className="mt-1 flex justify-between border-t border-zinc-200 pt-2 font-semibold">
            <span>Taxable income</span>
            <span className="tabular-nums">{money(filing.taxable_income)}</span>
          </div>
        </div>

        {filing.capitalized.length > 0 && (
          <div className="mt-4 rounded border border-zinc-200 bg-zinc-50 p-3">
            <p className="text-xs font-medium text-zinc-700">Property bought this year — deliberately NOT deducted</p>
            {filing.capitalized.map(c => (
              <div key={c.label} className="mt-1 flex justify-between text-sm">
                <span className="text-zinc-600">{c.label}</span>
                <span className="tabular-nums">{money(c.amount)}</span>
              </div>
            ))}
            <p className="mt-2 text-xs text-zinc-500">
              A building is written off over years, not in the year it is bought. It is out of the profit above
              on purpose — but it is owed depreciation, and nobody will claim that unless it is set up.
            </p>
          </div>
        )}

        {filing.warnings.length > 0 && (
          <div className="mt-4 rounded border border-orange-200 bg-orange-50 p-3 text-sm text-orange-800">
            {filing.warnings.map((w, i) => <p key={i}>{w}</p>)}
          </div>
        )}
      </div>

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
