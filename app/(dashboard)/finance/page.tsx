import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isAdmin } from '@/lib/auth'
import { redirect } from 'next/navigation'
import { FinanceDashboard } from './finance-dashboard'
import type { InvoiceRecord } from './all-invoices-tab'

export const dynamic = 'force-dynamic'

export default async function FinancePage({
  searchParams,
}: {
  searchParams: { tab?: string; client?: string }
}) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isAdmin(user)) redirect('/login')

  const activeTab = searchParams.tab ?? 'clients'
  const selectedClientId = searchParams.client ?? null

  // ── Fetch all clients with invoice summaries ──
  const { data: invoiceSummary } = await supabaseAdmin
    .from('client_invoices')
    .select('account_id, status, total, amount_paid, amount_due')
    .not('status', 'in', '("Cancelled","Split")')

  // Aggregate per account
  const clientMap: Record<string, {
    total_invoiced: number
    total_paid: number
    outstanding: number
    overdue: number
    invoice_count: number
    overdue_count: number
    has_partial: boolean
  }> = {}

  for (const inv of (invoiceSummary ?? [])) {
    if (!inv.account_id) continue
    if (!clientMap[inv.account_id]) {
      clientMap[inv.account_id] = {
        total_invoiced: 0, total_paid: 0, outstanding: 0, overdue: 0,
        invoice_count: 0, overdue_count: 0, has_partial: false,
      }
    }
    const c = clientMap[inv.account_id]
    c.invoice_count++
    c.total_invoiced += Number(inv.total ?? 0)
    c.total_paid += Number(inv.amount_paid ?? 0)
    if (['Sent', 'Overdue', 'Partial'].includes(inv.status)) {
      c.outstanding += Number(inv.amount_due ?? inv.total ?? 0)
    }
    if (inv.status === 'Overdue') {
      c.overdue += Number(inv.amount_due ?? inv.total ?? 0)
      c.overdue_count++
    }
    if (inv.status === 'Partial') c.has_partial = true
  }

  // Get all accounts (including those with no invoices, so they can create new ones)
  const { data: allAccounts } = await supabaseAdmin
    .from('accounts')
    .select('id, company_name')
    .order('company_name')

  const clientList = (allAccounts ?? []).map(a => ({
    id: a.id,
    company_name: a.company_name,
    ...(clientMap[a.id] ?? {
      total_invoiced: 0, total_paid: 0, outstanding: 0, overdue: 0,
      invoice_count: 0, overdue_count: 0, has_partial: false,
    }),
  }))

  // ── Fetch ALL invoices for flat list view ──
  const { data: allInvoicesFlat } = await supabaseAdmin
    .from('client_invoices')
    .select('id, invoice_number, status, total, amount_paid, amount_due, currency, issue_date, due_date, paid_date, notes, account_id, contact_id, accounts:account_id(company_name), contacts:contact_id(full_name)')
    .not('status', 'in', '("Cancelled","Split")')
    .order('issue_date', { ascending: false })
    .limit(500)

  // ── Fetch selected client's invoices ──
  let clientInvoices: Array<Record<string, unknown>> = []
  let clientCreditNotes: Array<Record<string, unknown>> = []
  let clientAuditLog: Array<Record<string, unknown>> = []
  let clientPaymentHistory: Array<Record<string, unknown>> = []

  if (selectedClientId) {
    const [invRes, cnRes, auditRes, payRes] = await Promise.all([
      supabaseAdmin
        .from('client_invoices')
        .select('*, client_invoice_items(*), client_customers!customer_id(name, email)')
        .eq('account_id', selectedClientId)
        .order('issue_date', { ascending: false }),
      supabaseAdmin
        .from('client_credit_notes')
        .select('*')
        .eq('account_id', selectedClientId)
        .order('created_at', { ascending: false }),
      supabaseAdmin
        .from('invoice_audit_log')
        .select('*')
        .in('invoice_id', (await supabaseAdmin
          .from('client_invoices')
          .select('id')
          .eq('account_id', selectedClientId)
        ).data?.map(i => i.id) ?? [])
        .order('performed_at', { ascending: false })
        .limit(50),
      supabaseAdmin
        .from('payments')
        .select('id, invoice_number, amount, amount_paid, paid_date, payment_method, status, invoice_status, portal_invoice_id')
        .eq('account_id', selectedClientId)
        .not('invoice_status', 'is', null)
        .order('paid_date', { ascending: false, nullsFirst: false }),
    ])

    clientInvoices = invRes.data ?? []
    clientCreditNotes = cnRes.data ?? []
    clientAuditLog = auditRes.data ?? []
    clientPaymentHistory = payRes.data ?? []
  }

  // ── Fetch bank feeds + open invoices for Bank Feed tab ──
  const [bankFeedsRes, bankFeedCountRes, bankOpenInvoicesRes] = await Promise.all([
    supabaseAdmin
      .from('td_bank_feeds')
      .select('*, payments:matched_payment_id(invoice_number, description, account_id, accounts:account_id(company_name))')
      .order('transaction_date', { ascending: false })
      .limit(200),
    supabaseAdmin
      .from('td_bank_feeds')
      .select('id', { count: 'exact', head: true }),
    supabaseAdmin
      .from('payments')
      .select('id, invoice_number, description, total, amount, amount_due, amount_currency, invoice_status, account_id, accounts:account_id(company_name)')
      .in('invoice_status', ['Sent', 'Overdue', 'Partial', 'Paid'])
      .order('created_at', { ascending: false }),
  ])

  const bankFeeds = bankFeedsRes.data ?? []
  const bankFeedTotalCount = bankFeedCountRes.count ?? bankFeeds.length
  const bankOpenInvoices = bankOpenInvoicesRes.data ?? []

  // ── Overview: aging, cash received, avg days, audit log ──
  const now = new Date()
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString()

  const [agingRes, cashRes, paidInvoicesRes, recentAuditRes] = await Promise.all([
    // Open invoices with due_date for aging buckets
    supabaseAdmin
      .from('client_invoices')
      .select('id, status, total, amount_due, due_date, account_id')
      .in('status', ['Sent', 'Overdue', 'Partial'])
      .not('status', 'in', '("Cancelled","Split")'),
    // Cash received this month
    supabaseAdmin
      .from('client_invoices')
      .select('amount_paid')
      .eq('status', 'Paid')
      .gte('paid_date', monthStart),
    // Paid invoices for avg days to pay
    supabaseAdmin
      .from('client_invoices')
      .select('issue_date, paid_date')
      .eq('status', 'Paid')
      .not('paid_date', 'is', null)
      .not('issue_date', 'is', null)
      .order('paid_date', { ascending: false })
      .limit(100),
    // Recent audit log for activity feed
    supabaseAdmin
      .from('invoice_audit_log')
      .select('*, client_invoices!invoice_id(invoice_number, accounts:account_id(company_name))')
      .order('performed_at', { ascending: false })
      .limit(20),
  ])

  // Aging buckets
  const today = new Date()
  const agingBuckets = { current: { amount: 0, count: 0 }, d1_30: { amount: 0, count: 0 }, d31_60: { amount: 0, count: 0 }, d60plus: { amount: 0, count: 0 } }
  for (const inv of (agingRes.data ?? [])) {
    const amt = Number(inv.amount_due ?? inv.total ?? 0)
    if (!inv.due_date) { agingBuckets.current.amount += amt; agingBuckets.current.count++; continue }
    const dueDate = new Date(inv.due_date)
    const daysOverdue = Math.floor((today.getTime() - dueDate.getTime()) / (1000 * 60 * 60 * 24))
    if (daysOverdue <= 0) { agingBuckets.current.amount += amt; agingBuckets.current.count++ }
    else if (daysOverdue <= 30) { agingBuckets.d1_30.amount += amt; agingBuckets.d1_30.count++ }
    else if (daysOverdue <= 60) { agingBuckets.d31_60.amount += amt; agingBuckets.d31_60.count++ }
    else { agingBuckets.d60plus.amount += amt; agingBuckets.d60plus.count++ }
  }

  // Cash received this month
  const cashThisMonth = (cashRes.data ?? []).reduce((s, i) => s + Number(i.amount_paid ?? 0), 0)

  // Avg days to pay (from last 100 paid invoices)
  const daysList = (paidInvoicesRes.data ?? [])
    .map(i => {
      const issue = new Date(i.issue_date as string)
      const paid = new Date(i.paid_date as string)
      return Math.floor((paid.getTime() - issue.getTime()) / (1000 * 60 * 60 * 24))
    })
    .filter(d => d >= 0 && d < 365)
  const avgDaysToPay = daysList.length > 0 ? Math.round(daysList.reduce((a, b) => a + b, 0) / daysList.length) : 0

  const recentAuditLog = recentAuditRes.data ?? []

  // ── Overview stats ──
  const allInvoices = invoiceSummary ?? []
  const totalOutstanding = allInvoices
    .filter(i => ['Sent', 'Overdue', 'Partial'].includes(i.status))
    .reduce((s, i) => s + Number(i.amount_due ?? i.total ?? 0), 0)
  const totalOverdue = allInvoices
    .filter(i => i.status === 'Overdue')
    .reduce((s, i) => s + Number(i.amount_due ?? i.total ?? 0), 0)
  const overdueCount = allInvoices.filter(i => i.status === 'Overdue').length

  return (
    <div className="h-full">
      <FinanceDashboard
        activeTab={activeTab}
        clientList={clientList}
        selectedClientId={selectedClientId}
        clientInvoices={clientInvoices}
        clientCreditNotes={clientCreditNotes}
        clientAuditLog={clientAuditLog}
        clientPaymentHistory={clientPaymentHistory}
        stats={{ totalOutstanding, totalOverdue, overdueCount, clientCount: clientList.filter(c => c.invoice_count > 0).length, cashThisMonth, avgDaysToPay }}
        agingBuckets={agingBuckets}
        recentAuditLog={recentAuditLog}
        bankFeeds={bankFeeds}
        bankOpenInvoices={bankOpenInvoices}
        bankFeedTotalCount={bankFeedTotalCount}
        allInvoicesFlat={(allInvoicesFlat ?? []) as unknown as InvoiceRecord[]}
      />
    </div>
  )
}
