'use client'

import { useState } from 'react'
import { CASH_ACCOUNT_TYPES, type OwnerAccount } from '@/lib/owner-finance'

/** A currency code from the database is not guaranteed to be valid ISO — the column has no
 *  CHECK and the registry is written by hand. A bad code makes Intl throw, which would
 *  blank the entire tab rather than one figure. */
const money = (n: number, currency?: string | null) => {
  const code = (currency || 'USD').trim().toUpperCase()
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: code, minimumFractionDigits: 2 }).format(n)
  } catch {
    return `${new Intl.NumberFormat('en-US', { minimumFractionDigits: 2 }).format(n)} ${code}`
  }
}

const SOURCE_WORDS: Record<string, string> = {
  statement: "the account's own statement",
  derived: 'the transactions, worked out',
  provider_report: "the provider's own report",
  unknown: 'an unrecorded source',
}
const sourceWords = (s?: string | null) => (s ? SOURCE_WORDS[s] ?? s.replace(/_/g, ' ') : null)

const asDate = (d: string | null) =>
  d ? new Date(d + 'T00:00:00').toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' }) : null

const isCash = (a: OwnerAccount) => CASH_ACCOUNT_TYPES.includes(a.account_type)

interface AccountsTabProps {
  accounts: OwnerAccount[]
}

/**
 * The account registry — every account the books are built from, and where each closing
 * balance came from. This is the page that makes the cash figure checkable.
 *
 * The totals here are the balances as last struck, NOT a figure for the year on the page
 * header: the registry holds one closing figure per account. That distinction is stated on
 * the screen rather than left for the reader to discover, because the same year-blindness
 * silently produced a wrong balance sheet until QA caught it.
 */
export function AccountsTab({ accounts }: AccountsTabProps) {
  if (accounts.length === 0) {
    return (
      <div className="rounded-lg border border-orange-200 bg-orange-50 p-6 text-sm text-orange-900">
        <p className="font-medium">No account records found</p>
        <p className="mt-1">
          The registry describes each account and holds its verified closing balance. Without it the
          cash position has to be guessed from transactions, and accounts that publish no running
          balance simply vanish. It exists in sandbox and has not been created in production yet.
        </p>
      </div>
    )
  }

  const cash = accounts.filter(isCash)
  const owed = accounts.filter(a => !isCash(a))

  const totals = (list: OwnerAccount[]) => {
    const out: Record<string, number> = {}
    for (const a of list) {
      if (a.closing_balance === null || a.closing_balance === undefined) continue
      out[a.currency || 'USD'] = (out[a.currency || 'USD'] ?? 0) + Number(a.closing_balance)
    }
    return out
  }
  const cashTotals = totals(cash)
  const owedTotals = totals(owed)
  const other = (t: Record<string, number>) =>
    Object.entries(t).filter(([c]) => c !== 'USD').map(([c, v]) => money(v, c)).join(', ')

  const missing = accounts.filter(a => a.closing_balance === null || a.closing_balance === undefined)

  /** The balances are as-last-struck, so the screen must say WHEN — a total under a year
   *  header with no date reads as that year's position, which it is not. */
  const dates = accounts.map(a => a.closing_date).filter(Boolean).sort() as string[]
  const struckRange = dates.length === 0
    ? null
    : dates[0].slice(0, 7) === dates[dates.length - 1].slice(0, 7)
      ? `as at ${asDate(dates[dates.length - 1])}`
      : `struck between ${asDate(dates[0])} and ${asDate(dates[dates.length - 1])}`

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Kpi label="Accounts" value={String(accounts.length)} sub={`${cash.length} holding cash, ${owed.length} owing`} />
        <Kpi label="Cash held" value={money(cashTotals.USD ?? 0)} sub={[other(cashTotals), struckRange].filter(Boolean).join(' · ')} />
        <Kpi label="Owed" value={money(owedTotals.USD ?? 0)} sub={[other(owedTotals), 'cards and loans'].filter(Boolean).join(' · ')} negative />
      </div>

      {struckRange && (
        <p className="text-xs text-zinc-500">
          These are the balances as last struck, not a position for the year in the header above.
        </p>
      )}

      {missing.length > 0 && (
        <div className="rounded-lg border border-orange-200 bg-orange-50 px-4 py-3 text-sm text-orange-800">
          {missing.length} account{missing.length === 1 ? ' has' : 's have'} no closing balance on file
          — {missing.map(a => a.bank_name).join(', ')}. Those are missing from the totals above.
        </div>
      )}

      <Section title="Cash accounts" subtitle="Money the company holds" accounts={cash} />
      <Section title="Cards and loans" subtitle="Money the company owes" accounts={owed} negative />

      <p className="text-xs text-zinc-500">
        Each closing balance is the figure printed on that account&apos;s own statement or provider
        report — not a total derived by adding transactions together, except where a line says so.
        That is what makes it an independent check on the books rather than a restatement of them.
      </p>
    </div>
  )
}

function Section({
  title, subtitle, accounts, negative = false,
}: { title: string; subtitle: string; accounts: OwnerAccount[]; negative?: boolean }) {
  if (accounts.length === 0) return null
  return (
    <div className="rounded-lg border border-zinc-200 bg-white">
      <div className="border-b border-zinc-200 px-4 py-2.5">
        <h3 className="text-sm font-medium text-zinc-800">{title}</h3>
        <p className="text-xs text-zinc-500">{subtitle}</p>
      </div>
      <ul className="divide-y divide-zinc-100">
        {accounts.map(a => <Row key={`${a.bank_name}-${a.currency}`} a={a} negative={negative} />)}
      </ul>
    </div>
  )
}

function Row({ a, negative }: { a: OwnerAccount; negative: boolean }) {
  /** The notes hold long reconciliation reasoning — genuinely useful, unreadable as a wall
   *  of text on a phone. Collapsed by default so the account list stays a list. */
  const [openNote, setOpenNote] = useState(false)
  const closed = asDate(a.closing_date)
  const opened = asDate(a.opening_date)
  const words = sourceWords(a.closing_source)
  const hasBalance = a.closing_balance !== null && a.closing_balance !== undefined
  const hasOpening = a.opening_balance !== null && a.opening_balance !== undefined

  return (
    <li className="px-4 py-3">
      <div className="flex items-baseline justify-between gap-3">
        <div className="min-w-0">
          <p className="break-words text-sm font-medium text-zinc-800">
            {a.bank_name}
            {a.is_clearing && (
              <span className="ml-2 rounded bg-zinc-100 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-zinc-500">
                clearing
              </span>
            )}
          </p>
          <p className="mt-0.5 text-xs text-zinc-500">
            {[a.institution, a.account_number, a.account_type, a.currency].filter(Boolean).join(' · ')}
          </p>
        </div>
        <div className="shrink-0 text-right">
          {hasBalance ? (
            <p className={`text-sm font-semibold tabular-nums ${negative ? 'text-red-600' : 'text-zinc-900'}`}>
              {money(Number(a.closing_balance), a.currency)}
            </p>
          ) : (
            <span className="text-sm text-orange-600">no balance on file</span>
          )}
          {closed && <p className="text-xs text-zinc-400">at {closed}</p>}
        </div>
      </div>

      <div className="mt-1.5 space-y-0.5 border-l-2 border-zinc-100 pl-2.5 text-xs text-zinc-500">
        {words && <p>Balance taken from {words}.</p>}
        {/* Either half of the opening pair is worth showing — hiding a known balance
            because its date is missing loses real information silently. */}
        {(hasOpening || opened) && (
          <p>
            Opened at {hasOpening ? money(Number(a.opening_balance), a.currency) : 'an unrecorded balance'}
            {opened ? ` on ${opened}` : ' (date not recorded)'}.
          </p>
        )}
        {a.notes && (
          <div>
            <button
              onClick={() => setOpenNote(v => !v)}
              className="text-xs font-medium text-zinc-600 underline underline-offset-2 hover:text-zinc-900"
              aria-expanded={openNote}
            >
              {openNote ? 'Hide note' : 'Show note'}
            </button>
            {openNote && <p className="mt-1 break-words whitespace-pre-line">{a.notes}</p>}
          </div>
        )}
      </div>
    </li>
  )
}

function Kpi({ label, value, sub, negative = false }: { label: string; value: string; sub?: string; negative?: boolean }) {
  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-zinc-500">{label}</p>
      <p className={`mt-1 text-2xl font-semibold tabular-nums ${negative ? 'text-red-600' : 'text-zinc-900'}`}>{value}</p>
      {sub && <p className="mt-0.5 break-words text-xs text-zinc-400">{sub}</p>}
    </div>
  )
}
