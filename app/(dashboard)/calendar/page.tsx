import { createClient } from '@/lib/supabase/server'
import { AnnualCalendar } from '@/components/calendar/annual-calendar'

interface DeadlineItem {
  type: string
  company_name: string
  deadline_date: string
  status?: string
}

export default async function CalendarPage({
  searchParams,
}: {
  searchParams: { year?: string }
}) {
  const supabase = createClient()
  const year = parseInt(searchParams.year ?? new Date().getFullYear().toString())
  const today = new Date().toISOString().split('T')[0]

  // Fetch all deadlines for the year
  const yearStart = `${year}-01-01`
  const yearEnd = `${year}-12-31`

  const [raResult, taxResult, paymentResult, serviceResult] = await Promise.all([
    // RA renewals
    supabase
      .from('accounts')
      .select('company_name, ra_renewal_date')
      .eq('status', 'Active')
      .gte('ra_renewal_date', yearStart)
      .lte('ra_renewal_date', yearEnd),
    // Tax return deadlines
    supabase
      .from('tax_returns')
      .select('company_name, deadline, status, extension_deadline')
      .eq('tax_year', year)
      .order('deadline'),
    // Payment due dates
    supabase
      .from('payments')
      .select('account_id, description, due_date, status, amount, period, year, installment')
      .in('status', ['Pending', 'Overdue'])
      .gte('due_date', yearStart)
      .lte('due_date', yearEnd),
    // Service SLA dates
    supabase
      .from('services')
      .select('service_name, sla_due_date, status, account_id')
      .in('status', ['Not Started', 'In Progress', 'Blocked'])
      .gte('sla_due_date', yearStart)
      .lte('sla_due_date', yearEnd),
  ])

  // Get account names for payments and services
  const payAccountIds = Array.from(new Set([
    ...(paymentResult.data ?? []).filter(p => p.account_id).map(p => p.account_id),
    ...(serviceResult.data ?? []).filter(s => s.account_id).map(s => s.account_id),
  ]))
  let accountMap: Record<string, string> = {}
  if (payAccountIds.length > 0) {
    const { data: accounts } = await supabase
      .from('accounts')
      .select('id, company_name')
      .in('id', payAccountIds)
    if (accounts) {
      accountMap = Object.fromEntries(accounts.map(a => [a.id, a.company_name]))
    }
  }

  const deadlines: DeadlineItem[] = [
    ...(raResult.data ?? []).map(a => ({
      type: 'RA Renewal',
      company_name: a.company_name,
      deadline_date: a.ra_renewal_date,
    })),
    ...(taxResult.data ?? []).map(t => ({
      type: 'Tax Return',
      company_name: t.company_name,
      deadline_date: t.deadline,
      status: t.status,
    })),
    ...(paymentResult.data ?? []).map(p => ({
      type: 'Payment',
      company_name: p.account_id ? accountMap[p.account_id] ?? 'N/A' : 'N/A',
      deadline_date: p.due_date!,
      status: p.status,
    })),
    ...(serviceResult.data ?? []).map(s => ({
      type: 'Service SLA',
      company_name: s.account_id ? accountMap[s.account_id] ?? s.service_name : s.service_name,
      deadline_date: s.sla_due_date!,
      status: s.status,
    })),
  ]

  return (
    <div className="p-6 lg:p-8">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Annual Calendar {year}</h1>
        <p className="text-muted-foreground text-sm mt-1">
          {deadlines.length} deadlines in {year}
        </p>
      </div>
      <AnnualCalendar deadlines={deadlines} year={year} today={today} />
    </div>
  )
}
