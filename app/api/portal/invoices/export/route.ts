import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/supabase-admin'
import { isAdmin } from '@/lib/auth'
import { NextRequest, NextResponse } from 'next/server'

/**
 * GET /api/portal/invoices/export?format=csv&status=overdue
 * Exports invoices as CSV. Admin-only.
 */
export async function GET(request: NextRequest) {
  const supabase = createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user || !isAdmin(user)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const statusFilter = request.nextUrl.searchParams.get('status')

  // Build query
  let query = supabaseAdmin
    .from('client_invoices')
    .select('id, invoice_number, account_id, customer_id, status, total, amount_paid, amount_due, tax_total, currency, issue_date, due_date, paid_date')
    .not('status', 'eq', 'Split')
    .order('issue_date', { ascending: false })

  if (statusFilter === 'overdue') {
    query = query.eq('status', 'Overdue')
  } else if (statusFilter === 'outstanding') {
    query = query.in('status', ['Sent', 'Overdue', 'Partial'])
  } else if (statusFilter === 'paid') {
    query = query.eq('status', 'Paid')
  }

  const { data: invoices } = await query

  if (!invoices?.length) {
    return new NextResponse('No data', { status: 204 })
  }

  // Resolve account + customer names
  const accountIds = Array.from(new Set(invoices.filter(i => i.account_id).map(i => i.account_id)))
  const customerIds = Array.from(new Set(invoices.filter(i => i.customer_id).map(i => i.customer_id)))

  let accountMap: Record<string, string> = {}
  let customerMap: Record<string, string> = {}

  if (accountIds.length > 0) {
    const { data } = await supabaseAdmin.from('accounts').select('id, company_name').in('id', accountIds)
    if (data) accountMap = Object.fromEntries(data.map(a => [a.id, a.company_name]))
  }
  if (customerIds.length > 0) {
    const { data } = await supabaseAdmin.from('client_customers').select('id, name').in('id', customerIds)
    if (data) customerMap = Object.fromEntries(data.map(c => [c.id, c.name]))
  }

  // Build CSV (no external library needed)
  const headers = ['Invoice Number', 'Client', 'Customer', 'Issue Date', 'Due Date', 'Amount', 'Tax', 'Total', 'Amount Paid', 'Balance Due', 'Currency', 'Status', 'Paid Date']

  const escCsv = (val: string) => {
    if (val.includes(',') || val.includes('"') || val.includes('\n')) {
      return `"${val.replace(/"/g, '""')}"`
    }
    return val
  }

  const csvRows = [headers.join(',')]
  for (const inv of invoices) {
    csvRows.push([
      escCsv(inv.invoice_number),
      escCsv(inv.account_id ? accountMap[inv.account_id] ?? '' : ''),
      escCsv(inv.customer_id ? customerMap[inv.customer_id] ?? '' : ''),
      inv.issue_date ?? '',
      inv.due_date ?? '',
      String(inv.total ?? 0),
      String(inv.tax_total ?? 0),
      String(inv.total ?? 0),
      String(inv.amount_paid ?? 0),
      String(inv.amount_due ?? inv.total ?? 0),
      inv.currency ?? 'USD',
      inv.status,
      inv.paid_date ?? '',
    ].join(','))
  }

  const csv = csvRows.join('\n')
  const today = new Date().toISOString().split('T')[0]

  return new NextResponse(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="invoices-${statusFilter || 'all'}-${today}.csv"`,
    },
  })
}
