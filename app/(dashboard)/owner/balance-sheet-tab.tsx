'use client'

import type { BalanceSheet, BalanceSheetLine } from '@/lib/owner-finance'

/** A currency code from the database is not guaranteed to be a valid ISO code — the column
 *  has no CHECK and the registry is populated by hand. An empty or bad code makes
 *  Intl.NumberFormat THROW, which would blank the whole page rather than one figure. */
const money = (n: number, currency?: string | null) => {
  const code = (currency || 'USD').trim().toUpperCase()
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: code, minimumFractionDigits: 2 }).format(n)
  } catch {
    return `${new Intl.NumberFormat('en-US', { minimumFractionDigits: 2 }).format(n)} ${code}`
  }
}

/** The database stores provenance as a short code. Printing it raw produced the line
 *  "Balance from derived." — the reader is owed a sentence, not a column value. */
const SOURCE_WORDS: Record<string, string> = {
  statement: "from the account's own statement",
  derived: 'worked out from the transactions',
  provider_report: "from the provider's own report",
  unknown: 'source not recorded',
}
const sourceWords = (s?: string | null) => (s ? SOURCE_WORDS[s] ?? s.replace(/_/g, ' ') : null)

const asDate = (d?: string | null) =>
  d ? new Date(d + 'T00:00:00').toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' }) : null

interface BalanceSheetTabProps {
  bs: BalanceSheet
}

/**
 * What the company OWNS and OWES at the year end.
 *
 * THE RULE THIS SCREEN ENFORCES: a balance sheet may only be stated for a year the books
 * actually hold balances for. Two ways it used to break that, both caught in QA:
 *
 *  - The registry holds ONE closing figure per account with no year dimension, so the
 *    31-Dec-2025 balances rendered under whatever year was selected. The default year is
 *    the CURRENT one, so simply opening the page produced a confident, complete, wrong
 *    statement — and at 2026 the office property dropped out too, moving equity from
 *    -70,325.51 to -105,358.04 with nothing on screen contradicting the heading.
 *  - With no registry at all (production, where the table does not exist yet) the office
 *    property alone was enough to make the page think it had something to say: it printed
 *    total assets 35,032.53, "None recorded" liabilities and POSITIVE equity, for a
 *    company that owes 146,496.68 including a mortgage.
 *
 * So: no account balances for the year => no statement. Say why, show what IS known, and
 * never print a total that a reader could mistake for the company's position.
 */
export function BalanceSheetTab({ bs }: BalanceSheetTabProps) {
  const cashTotal = bs.cash.reduce((s, l) => s + l.amount, 0)

  if (!bs.can_state) {
    /* Deliberately listed WITHOUT any total. These are the parts of the year that are
     * known; a subtotal over them would be the partial statement this screen refuses. */
    const known = [...bs.cash, ...bs.liabilities, ...bs.other_assets]
    return (
      <div className="space-y-4">
        <div className="rounded-lg border border-orange-200 bg-orange-50 p-5">
          <h3 className="text-sm font-semibold text-orange-900">
            No balance sheet can be stated for {bs.year}
          </h3>
          <div className="mt-2 space-y-2 text-sm text-orange-900">
            {bs.notes.map((n, i) => <p key={i}>{n}</p>)}
          </div>
          <p className="mt-3 text-xs text-orange-800">
            A balance sheet is a position on one date, covering every account. Part of the
            company under a whole-company heading reads as the whole company — which is how a
            page shows healthy equity for a business that owes money on a mortgage.
          </p>
        </div>

        {known.length > 0 && (
          <div className="rounded-lg border border-zinc-200 bg-white p-4">
            <h3 className="text-sm font-medium text-zinc-700">Known for {bs.year}, on its own</h3>
            <p className="mb-2 mt-0.5 text-xs text-zinc-500">
              Listed with no totals on purpose — there is nothing to set them against yet.
            </p>
            {known.map(l => (
              <div key={l.label} className="flex items-baseline justify-between gap-3 py-1 text-sm">
                <span className="min-w-0 break-words text-zinc-600">
                  {l.label}
                  {l.as_of && <span className="block text-xs text-zinc-400">at {asDate(l.as_of)}</span>}
                </span>
                <span className="shrink-0 tabular-nums text-zinc-800">{money(l.amount)}</span>
              </div>
            ))}
          </div>
        )}
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
  const words = sourceWords(line.source)
  const on = asDate(line.as_of)
  return (
    <div className="flex items-baseline justify-between gap-3 py-1 pl-3 text-sm">
      <span className="min-w-0 text-zinc-600">
        <span className="break-words">{line.label}</span>
        {(words || on) && (
          <span className="block text-xs text-zinc-400">
            {[on && `at ${on}`, words].filter(Boolean).join(' · ')}
          </span>
        )}
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
