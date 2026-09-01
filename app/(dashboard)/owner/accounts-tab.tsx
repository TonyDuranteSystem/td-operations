'use client'

import type { OwnerAccount } from '@/lib/owner-finance'

const money = (n: number, currency = 'USD') =>
  new Intl.NumberFormat('en-US', { style: 'currency', currency, minimumFractionDigits: 2 }).format(n)

const asDate = (d: string | null) =>
  d ? new Date(d + 'T00:00:00').toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' }) : null

/** Types whose balance is money the company HAS. Everything else is money it owes. */
const CASH_TYPES = ['checking', 'savings', 'processor']

interface AccountsTabProps {
  accounts: OwnerAccount[]
}

/**
 * The account registry — every account the books are built from, and where each closing
 * balance came from.
 *
 * This is the page that makes the cash figure checkable. Before it, the Overview stated a
 * total with nothing behind it: no list of accounts, no statement dates, no way to see that
 * a balance came from a December statement rather than being derived by adding transactions
 * up and hoping. Five of nine accounts publish no running balance at all, which is why the
 * registry exists in the first place.
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

  const cash = accounts.filter(a => CASH_TYPES.includes(a.account_type))
  const owed = accounts.filter(a => !CASH_TYPES.includes(a.account_type))

  const totals = (list: OwnerAccount[]) => {
    const out: Record<string, number> = {}
    for (const a of list) {
      if (a.closing_balance === null || a.closing_balance === undefined) continue
      out[a.currency] = (out[a.currency] ?? 0) + Number(a.closing_balance)
    }
    return out
  }
  const cashTotals = totals(cash)
  const owedTotals = totals(owed)
  const missing = accounts.filter(a => a.closing_balance === null || a.closing_balance === undefined)

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Kpi label="Accounts" value={String(accounts.length)} sub={`${cash.length} holding cash, ${owed.length} owing`} />
        <Kpi
          label="Cash held"
          value={money(cashTotals.USD ?? 0)}
          sub={Object.entries(cashTotals).filter(([c]) => c !== 'USD').map(([c, v]) => money(v, c)).join(', ') || 'across every account'}
        />
        <Kpi
          label="Owed"
          value={money(owedTotals.USD ?? 0)}
          sub="cards and loans"
          negative
        />
      </div>

      {missing.length > 0 && (
        <div className="rounded-lg border border-orange-200 bg-orange-50 px-4 py-3 text-sm text-orange-800">
          {missing.length} account{missing.length === 1 ? ' has' : 's have'} no closing balance on file
          — {missing.map(a => a.bank_name).join(', ')}. Those are missing from the totals above.
        </div>
      )}

      <Section title="Cash accounts" subtitle="Money the company holds" accounts={cash} />
      <Section title="Cards and loans" subtitle="Money the company owes" accounts={owed} negative />

      <p className="text-xs text-zinc-500">
        Each closing balance is the figure printed on that account&apos;s own December statement or
        provider report — not a total derived by adding transactions together. That is what makes it
        an independent check on the books rather than a restatement of them.
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
  const closed = asDate(a.closing_date)
  const opened = asDate(a.opening_date)
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
          {a.closing_balance === null || a.closing_balance === undefined ? (
            <span className="text-sm text-orange-600">no balance on file</span>
          ) : (
            <p className={`text-sm font-semibold tabular-nums ${negative ? 'text-red-600' : 'text-zinc-900'}`}>
              {money(Number(a.closing_balance), a.currency)}
            </p>
          )}
          {closed && <p className="text-xs text-zinc-400">at {closed}</p>}
        </div>
      </div>

      {(a.closing_source || opened || a.notes) && (
        <div className="mt-1.5 space-y-0.5 border-l-2 border-zinc-100 pl-2.5 text-xs text-zinc-500">
          {a.closing_source && <p>Balance from {a.closing_source}.</p>}
          {opened && a.opening_balance !== null && a.opening_balance !== undefined && (
            <p>Opened at {money(Number(a.opening_balance), a.currency)} on {opened}.</p>
          )}
          {a.notes && <p className="break-words">{a.notes}</p>}
        </div>
      )}
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
