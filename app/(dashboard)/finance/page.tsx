import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isAdmin } from '@/lib/auth'
import { redirect } from 'next/navigation'
import { FinanceDashboard } from './finance-dashboard'

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
        stats={{ totalOutstanding, totalOverdue, overdueCount, clientCount: clientList.filter(c => c.invoice_count > 0).length }}
      />
    </div>
  )
}
