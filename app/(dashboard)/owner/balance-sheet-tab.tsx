'use client'

import type { BalanceSheet, BalanceSheetLine } from '@/lib/owner-finance'

const money = (n: number, currency = 'USD') =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency, minimumFractionDigits: 2 }).format(n)

interface BalanceSheetTabProps {
  bs: BalanceSheet
}

/**
 * What the company OWNS and OWES at the year end.
 *
 * The engine has produced this since the closing was recorded, but nothing displayed it —
 * so the office purchase, which is correctly kept OUT of profit, appeared nowhere in the
 * CRM at all, and the cash figure on the Overview had no visible support.
 *
 * Every balance here is a closing figure from an account's own statement, carried through
 * from the registry with the source shown. Nothing on this screen is derived by summing
 * transactions, which is the whole point: it is the independent check on the P&L.
 */
export function BalanceSheetTab({ bs }: BalanceSheetTabProps) {
  const cashTotal = bs.cash.reduce((s, l) => s + l.amount, 0)
  const empty = bs.cash.length === 0 && bs.other_assets.length === 0 && bs.liabilities.length === 0

  if (empty) {
    return (
      <div className="rounded-lg border border-zinc-200 bg-white p-6 text-sm text-zinc-600">
        <p className="font-medium text-zinc-800">Nothing to show yet</p>
        <p className="mt-1">
          A balance sheet is built from the account records — their closing balances and where each one
          came from. None are on file for {bs.year}, so there is nothing to state.
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="rounded-lg border border-zinc-300 bg-white">
        <div className="border-b border-zinc-200 px-4 py-3">
          <h3 className="text-sm font-medium text-zinc-800">Balance Sheet</h3>
          <p className="mt-0.5 text-xs text-zinc-500">
            As at {new Date(bs.as_of + 'T00:00:00').toLocaleDateString('en-US', { day: 'numeric', month: 'long', year: 'numeric' })}
            {' · '}cash basis{' · '}{bs.currency}
          </p>
        </div>

        <div className="px-4 py-3">
          <Group title="Assets" />
          {bs.cash.length > 0 && (
            <>
              <SubHead>Cash and cash equivalents</SubHead>
              {bs.cash.map(l => <Line key={l.label} line={l} />)}
              <Total label="Total cash and cash equivalents" amount={cashTotal} />
            </>
          )}
          {bs.other_assets.length > 0 && (
            <>
              <SubHead className="mt-4">Other assets</SubHead>
              {bs.other_assets.map(l => <Line key={l.label} line={l} />)}
            </>
          )}
          <Total label="Total assets" amount={bs.total_assets} strong />

          <Group title="Liabilities" className="mt-6" />
          {bs.liabilities.length === 0
            ? <p className="py-1.5 text-sm text-zinc-400">None recorded.</p>
            : bs.liabilities.map(l => <Line key={l.label} line={l} negative />)}
          <Total label="Total liabilities" amount={bs.total_liabilities} strong />

          <div className="mt-5 flex items-baseline justify-between gap-3 border-t-2 border-zinc-900 pt-3">
            <span className="text-sm font-semibold text-zinc-900">
              Members&apos; equity{bs.equity < 0 && <span className="text-zinc-500"> (deficit)</span>}
            </span>
            <span className={`text-lg font-semibold tabular-nums ${bs.equity < 0 ? 'text-red-600' : 'text-zinc-900'}`}>
              {money(bs.equity)}
            </span>
          </div>
        </div>
      </div>

      {bs.foreign.length > 0 && (
        <div className="rounded-lg border border-zinc-200 bg-white p-4">
          <h3 className="text-sm font-medium text-zinc-700">Held in other currencies</h3>
          <p className="mb-2 mt-0.5 text-xs text-zinc-500">
            Listed, never converted into the totals above.
          </p>
          {bs.foreign.map(f => (
            <div key={`${f.label}-${f.currency}`} className="flex items-baseline justify-between gap-3 py-1 text-sm">
              <span className="text-zinc-600">{f.label}</span>
              <span className="tabular-nums text-zinc-800">{money(f.amount, f.currency)}</span>
            </div>
          ))}
        </div>
      )}

      {bs.notes.length > 0 && (
        <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-4">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-zinc-500">Notes</h3>
          <ol className="ml-4 list-decimal space-y-2 text-sm text-zinc-600">
            {bs.notes.map((n, i) => <li key={i}>{n}</li>)}
          </ol>
        </div>
      )}
    </div>
  )
}

function Group({ title, className = '' }: { title: string; className?: string }) {
  return (
    <h4 className={`text-xs font-semibold uppercase tracking-wide text-zinc-500 ${className}`}>{title}</h4>
  )
}

function SubHead({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <p className={`mt-2 text-sm font-medium text-zinc-700 ${className}`}>{children}</p>
}

function Line({ line, negative = false }: { line: BalanceSheetLine; negative?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-1 pl-3 text-sm">
      <span className="min-w-0 text-zinc-600">
        <span className="break-words">{line.label}</span>
        {line.source && <span className="block text-xs text-zinc-400">{line.source}</span>}
      </span>
      <span className={`shrink-0 tabular-nums ${negative ? 'text-red-600' : 'text-zinc-800'}`}>
        {money(line.amount)}
      </span>
    </div>
  )
}

function Total({ label, amount, strong = false }: { label: string; amount: number; strong?: boolean }) {
  return (
    <div className={`mt-1 flex items-baseline justify-between gap-3 border-t pt-1.5 text-sm ${strong ? 'border-zinc-400 font-semibold text-zinc-900' : 'border-zinc-200 font-medium text-zinc-700'}`}>
      <span>{label}</span>
      <span className="shrink-0 tabular-nums">{money(amount)}</span>
    </div>
  )
}
