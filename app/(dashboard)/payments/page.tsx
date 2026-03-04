import { createClient } from '@/lib/supabase/server'
import { PaymentBoard } from '@/components/payments/payment-board'

export default async function PaymentsPage({
  searchParams,
}: {
  searchParams: { tab?: string }
}) {
  const supabase = createClient()
  const today = new Date().toISOString().split('T')[0]
  const activeTab = searchParams.tab ?? 'scaduti'

  // Fetch all non-paid payments with account names
  const { data: rawPayments } = await supabase
    .from('payments')
    .select('id, account_id, description, amount, amount_currency, period, year, due_date, paid_date, status, payment_method, invoice_number, installment, amount_paid, amount_due, followup_stage, delay_approved_until, notes, updated_at')
    .order('due_date', { ascending: true, nullsFirst: false })

  // Get account names
  const accountIds = Array.from(new Set((rawPayments ?? []).filter(p => p.account_id).map(p => p.account_id)))
  let accountMap: Record<string, string> = {}
  if (accountIds.length > 0) {
    const { data: accounts } = await supabase
      .from('accounts')
      .select('id, company_name')
      .in('id', accountIds)
    if (accounts) {
      accountMap = Object.fromEntries(accounts.map(a => [a.id, a.company_name]))
    }
  }

  const payments = (rawPayments ?? []).map(p => ({
    ...p,
    company_name: p.account_id ? accountMap[p.account_id] ?? null : null,
  }))

  // Categorize
  const overdue = payments.filter(p =>
    (p.status === 'Overdue') ||
    ((p.status === 'Pending') && p.due_date && p.due_date < today)
  )
  const upcoming = payments.filter(p =>
    (p.status === 'Pending') && (!p.due_date || p.due_date >= today)
  )
  const paid = payments.filter(p => p.status === 'Paid')

  const totalOverdue = overdue.reduce((sum, p) => sum + Number(p.amount_due ?? p.amount ?? 0), 0)
  const totalUpcoming = upcoming.reduce((sum, p) => sum + Number(p.amount_due ?? p.amount ?? 0), 0)

  const stats = {
    overdueCount: overdue.length,
    overdueTotal: totalOverdue,
    upcomingCount: upcoming.length,
    upcomingTotal: totalUpcoming,
    paidCount: paid.length,
    paidTotal: paid.reduce((sum, p) => sum + Number(p.amount_paid ?? p.amount ?? 0), 0),
  }

  return (
    <div className="p-6 lg:p-8">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Payment Tracker</h1>
        <p className="text-muted-foreground text-sm mt-1">
          {stats.overdueCount} scaduti (${stats.overdueTotal.toLocaleString()}) · {stats.upcomingCount} in arrivo
        </p>
      </div>
      <PaymentBoard
        overdue={overdue}
        upcoming={upcoming}
        paid={paid}
        stats={stats}
        activeTab={activeTab}
        today={today}
      />
    </div>
  )
}
