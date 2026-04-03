import { createClient } from '@/lib/supabase/server'
import { isAdmin } from '@/lib/auth'
import { redirect } from 'next/navigation'
import { InvoiceAgingTable } from './invoice-aging-table'

export default async function InvoiceAgingPage() {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isAdmin(user)) redirect('/login')

  // Fetch all non-Draft, non-Cancelled invoices with customer + account info
  const { data: invoices } = await supabase
    .from('client_invoices')
    .select('id, invoice_number, account_id, customer_id, status, total, amount_paid, amount_due, tax_total, currency, issue_date, due_date, paid_date, parent_invoice_id')
    .not('status', 'in', '("Cancelled","Split")')
    .order('due_date', { ascending: true, nullsFirst: false })

  // Get account names
  const accountIds = Array.from(new Set((invoices ?? []).filter(i => i.account_id).map(i => i.account_id)))
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

  // Get customer names
  const customerIds = Array.from(new Set((invoices ?? []).filter(i => i.customer_id).map(i => i.customer_id)))
  let customerMap: Record<string, string> = {}
  if (customerIds.length > 0) {
    const { data: customers } = await supabase
      .from('client_customers')
      .select('id, name')
      .in('id', customerIds)
    if (customers) {
      customerMap = Object.fromEntries(customers.map(c => [c.id, c.name]))
    }
  }

  const today = new Date()
  const rows = (invoices ?? []).map(inv => {
    const dueDate = inv.due_date ? new Date(inv.due_date + 'T00:00:00') : null
    const daysOverdue = dueDate && inv.status !== 'Paid' && inv.status !== 'Draft'
      ? Math.floor((today.getTime() - dueDate.getTime()) / (1000 * 60 * 60 * 24))
      : 0
    return {
      ...inv,
      company_name: inv.account_id ? accountMap[inv.account_id] ?? '—' : '—',
      customer_name: inv.customer_id ? customerMap[inv.customer_id] ?? '—' : '—',
      days_overdue: Math.max(daysOverdue, 0),
    }
  })

  // Stats
  const outstanding = rows.filter(r => ['Sent', 'Overdue', 'Partial'].includes(r.status))
  const overdue = rows.filter(r => r.status === 'Overdue' || (r.days_overdue > 0 && r.status !== 'Paid' && r.status !== 'Draft'))
  const paid = rows.filter(r => r.status === 'Paid' && r.paid_date)

  // Average days to pay (for paid invoices with both dates)
  const daysToPayArr = paid
    .filter(r => r.issue_date && r.paid_date)
    .map(r => {
      const issued = new Date(r.issue_date)
      const paidAt = new Date(r.paid_date!)
      return Math.floor((paidAt.getTime() - issued.getTime()) / (1000 * 60 * 60 * 24))
    })
    .filter(d => d >= 0)
  const avgDaysToPay = daysToPayArr.length > 0
    ? Math.round(daysToPayArr.reduce((a, b) => a + b, 0) / daysToPayArr.length)
    : 0

  const stats = {
    totalOutstanding: outstanding.reduce((s, r) => s + Number(r.amount_due ?? r.total ?? 0), 0),
    totalOverdue: overdue.reduce((s, r) => s + Number(r.amount_due ?? r.total ?? 0), 0),
    avgDaysToPay,
    overdueCount: overdue.length,
    outstandingCount: outstanding.length,
  }

  return (
    <div className="p-6 lg:p-8">
      <div className="mb-6 flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Invoice Aging</h1>
          <p className="text-muted-foreground text-sm mt-1">
            {stats.outstandingCount} outstanding &middot; {stats.overdueCount} overdue &middot; Avg {stats.avgDaysToPay}d to pay
          </p>
        </div>
        <a
          href="/api/portal/invoices/export?format=csv"
          className="inline-flex items-center gap-2 rounded-md bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700"
        >
          Export CSV
        </a>
      </div>

      {/* Summary Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
        <div className="rounded-lg border bg-card p-4">
          <p className="text-sm text-muted-foreground">Total Outstanding</p>
          <p className="text-2xl font-bold">${stats.totalOutstanding.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>
        </div>
        <div className="rounded-lg border bg-card p-4">
          <p className="text-sm text-muted-foreground">Total Overdue</p>
          <p className="text-2xl font-bold text-red-600">${stats.totalOverdue.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</p>
        </div>
        <div className="rounded-lg border bg-card p-4">
          <p className="text-sm text-muted-foreground">Avg Days to Pay</p>
          <p className="text-2xl font-bold">{stats.avgDaysToPay}d</p>
        </div>
      </div>

      <InvoiceAgingTable rows={rows} />
    </div>
  )
}
