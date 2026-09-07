import { createClient } from '@/lib/supabase/server'
import { CreditCard, Banknote } from 'lucide-react'
import { format, parseISO } from 'date-fns'
import Link from 'next/link'

export async function RecentPaymentsCard() {
  const supabase = createClient()

  // Fixed 2026-09-06 (dev job ef5da377, Step 5): this query used the wrong
  // status case ('paid' vs the real 'Paid') and selected 3 columns that
  // don't exist on this table (currency/payment_date/payment_type — the real
  // names are amount_currency/paid_date/payment_method) — so it always
  // returned nothing and this card always showed empty, since the old page
  // it linked to was retired. Two more gaps found verifying that fix live,
  // both fixed in the same pass: (1) the is_test filter — without it a QA
  // test invoice marked Paid would show on this real CRM homepage as if it
  // were live revenue, the same convention Finance's own page already
  // applies; (2) nullsFirst: false — Postgres's default DESC order puts
  // NULL paid_date rows FIRST, not last, so any Paid row with no paid_date
  // (15 real rows found, all old QA fixtures never flagged is_test) would
  // permanently pin itself at the top regardless of actual recency —
  // confirmed live: without this, "QA One LLC" and "QA Revenue B" from July
  // outranked real September payments. Finance's own page already applies
  // this same nullsFirst fix on this same column.
  const { data: payments } = await supabase
    .from('payments')
    .select('id, amount, amount_currency, status, paid_date, payment_method, account_id, accounts(company_name)')
    .eq('status', 'Paid')
    .eq('is_test', false)
    .order('paid_date', { ascending: false, nullsFirst: false })
    .limit(5)

  if (!payments || payments.length === 0) {
    return (
      <div className="bg-white rounded-lg border p-5">
        <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-3">
          Recent Payments
        </h3>
        <div className="flex flex-col items-center justify-center py-6 text-muted-foreground">
          <Banknote className="h-8 w-8 mb-2 text-zinc-300" />
          <p className="text-sm">No recent payments</p>
        </div>
      </div>
    )
  }

  return (
    <div className="bg-white rounded-lg border p-5">
      <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide mb-3">
        Recent Payments
      </h3>
      <div className="space-y-2">
        {payments.map(p => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const accounts = p.accounts as any
          const companyName = (Array.isArray(accounts) ? accounts[0]?.company_name : accounts?.company_name) ?? 'Unknown'
          const amount = Number(p.amount)
          const formatted = p.amount_currency === 'EUR'
            ? `€${amount.toLocaleString('en-US', { minimumFractionDigits: 2 })}`
            : `$${amount.toLocaleString('en-US', { minimumFractionDigits: 2 })}`

          return (
            <Link key={p.id} href="/finance" className="flex items-center gap-2 py-1.5 px-3 rounded-lg bg-emerald-50 text-sm hover:bg-zinc-50 cursor-pointer transition-colors">
              <CreditCard className="h-4 w-4 text-emerald-600 shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="font-medium truncate text-xs">{companyName}</p>
                <p className="text-xs text-muted-foreground">
                  {p.paid_date ? format(parseISO(p.paid_date), 'MMM d') : 'No date'}
                  {p.payment_method && ` • ${p.payment_method}`}
                </p>
              </div>
              <span className="text-xs font-semibold text-emerald-700 shrink-0">
                {formatted}
              </span>
            </Link>
          )
        })}
      </div>
    </div>
  )
}
