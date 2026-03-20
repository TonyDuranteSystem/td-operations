import { createClient } from '@/lib/supabase/server'
import { CreditCard, Banknote } from 'lucide-react'
import { format, parseISO } from 'date-fns'
import Link from 'next/link'

export async function RecentPaymentsCard() {
  const supabase = createClient()

  const { data: payments } = await supabase
    .from('payments')
    .select('id, amount, currency, status, payment_date, payment_type, account_id, accounts(company_name)')
    .eq('status', 'paid')
    .order('payment_date', { ascending: false })
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
          const formatted = p.currency === 'EUR'
            ? `\u20AC${amount.toLocaleString('en-US', { minimumFractionDigits: 2 })}`
            : `$${amount.toLocaleString('en-US', { minimumFractionDigits: 2 })}`

          return (
            <Link key={p.id} href="/payments" className="flex items-center gap-2 py-1.5 px-3 rounded-lg bg-emerald-50 text-sm hover:bg-zinc-50 cursor-pointer transition-colors">
              <CreditCard className="h-4 w-4 text-emerald-600 shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="font-medium truncate text-xs">{companyName}</p>
                <p className="text-xs text-muted-foreground">
                  {p.payment_date ? format(parseISO(p.payment_date), 'MMM d') : 'No date'}
                  {p.payment_type && ` \u2022 ${p.payment_type}`}
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
