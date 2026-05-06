import { createClient } from '@/lib/supabase/server'
import { AnnualCalendar } from '@/components/calendar/annual-calendar'

export type RenewalKind = 'ra' | 'ar'
export type RenewalStatus = 'upcoming' | 'active' | 'blocked' | 'completed' | 'filed' | 'offboarding'

/** Actionable row — RA Renewal or Annual Report. Clickable. */
export interface RenewalRow {
  kind: RenewalKind
  account_id: string
  company_name: string
  state_of_formation: string | null
  due_date: string  // YYYY-MM-DD
  status: RenewalStatus
  delivery_id: string | null
  // RA address registry — three distinct fields per account-detail picker
  provider: string | null
  agent_name: string | null
  ra_address_line: string | null  // formatted "line1, line2, city, ST zip"
  ra_county: string | null
  drive_folder_url: string | null
  has_offboarding: boolean
}

/** Informational row — Tax Return / Payment. Not clickable. */
export interface InfoRow {
  kind: 'tax' | 'payment'
  company_name: string
  due_date: string
  type_label: string
  status?: string | null
}

export type CalendarRow = RenewalRow | InfoRow

interface RawAddress {
  provider: string | null
  agent_name: string | null
  address_line1: string | null
  address_line2: string | null
  city: string | null
  state: string | null
  zip: string | null
  county: string | null
}

function formatAddressLine(addr: RawAddress | null): string | null {
  if (!addr) return null
  const parts: string[] = []
  if (addr.address_line1) parts.push(addr.address_line1)
  if (addr.address_line2) parts.push(addr.address_line2)
  const cityStateZip = [addr.city, addr.state, addr.zip].filter(Boolean).join(' ')
  if (cityStateZip) parts.push(cityStateZip)
  return parts.length ? parts.join(', ') : null
}

export default async function CalendarPage({
  searchParams,
}: {
  searchParams: { year?: string }
}) {
  const supabase = createClient()
  const year = parseInt(searchParams.year ?? new Date().getFullYear().toString())
  const today = new Date().toISOString().split('T')[0]
  const yearStart = `${year}-01-01`
  const yearEnd = `${year}-12-31`

  // ─── 1. Active Client accounts with renewal dates in this year ─────
  // Source of truth = accounts.ra_renewal_date / annual_report_due_date.
  // After completion, lib/service-delivery.ts:270-341 rolls these +1y, so
  // completed renewals naturally fall out of this query for the next year.
  const { data: accountsForRenewals } = await supabase
    .from('accounts')
    .select(`
      id,
      company_name,
      state_of_formation,
      ra_renewal_date,
      annual_report_due_date,
      registered_agent_id,
      gdrive_folder_url,
      portal_tier
    `)
    .eq('status', 'Active')
    .eq('account_type', 'Client')
    .or(
      `and(ra_renewal_date.gte.${yearStart},ra_renewal_date.lte.${yearEnd}),and(annual_report_due_date.gte.${yearStart},annual_report_due_date.lte.${yearEnd})`
    )

  const accountIds = (accountsForRenewals ?? []).map(a => a.id)

  // ─── 2. RA address registry rows for those accounts ────────────────
  const raAddressIds = (accountsForRenewals ?? [])
    .map(a => a.registered_agent_id)
    .filter((id): id is string => id !== null)
  const raAddressMap = new Map<string, RawAddress>()
  if (raAddressIds.length > 0) {
    const { data: addrs } = await supabase
      .from('addresses')
      .select('id, provider, agent_name, address_line1, address_line2, city, state, zip, county')
      .in('id', raAddressIds)
    for (const a of addrs ?? []) {
      raAddressMap.set(a.id, {
        provider: a.provider,
        agent_name: a.agent_name,
        address_line1: a.address_line1,
        address_line2: a.address_line2,
        city: a.city,
        state: a.state,
        zip: a.zip,
        county: a.county,
      })
    }
  }

  // ─── 3. SDs for renewals (active/blocked) — gives us delivery_id + stage ─
  const sdMap = new Map<string, { id: string; service_type: string; status: string; stage: string | null }>()
  if (accountIds.length > 0) {
    const { data: sds } = await supabase
      .from('service_deliveries')
      .select('id, account_id, service_type, status, stage, due_date')
      .in('account_id', accountIds)
      .in('service_type', ['State RA Renewal', 'State Annual Report'])
      .in('status', ['active', 'blocked'])
      .gte('due_date', yearStart)
      .lte('due_date', yearEnd)
    for (const sd of sds ?? []) {
      const key = `${sd.account_id}:${sd.service_type}`
      sdMap.set(key, { id: sd.id, service_type: sd.service_type, status: sd.status, stage: sd.stage })
    }
  }

  // ─── 4. Completed SDs in this year — show as 🟢 filed history ──────
  const filedSDs: { account_id: string; service_type: string; due_date: string }[] = []
  {
    const { data: completed } = await supabase
      .from('service_deliveries')
      .select('id, account_id, service_type, status, due_date')
      .in('service_type', ['State RA Renewal', 'State Annual Report'])
      .eq('status', 'completed')
      .gte('due_date', yearStart)
      .lte('due_date', yearEnd)
    for (const sd of completed ?? []) {
      if (sd.account_id) {
        filedSDs.push({ account_id: sd.account_id, service_type: sd.service_type, due_date: sd.due_date! })
      }
    }
  }
  // Need company names for filed SDs whose accounts aren't already loaded
  const filedAccountIds = Array.from(new Set(filedSDs.map(s => s.account_id).filter(id => !accountIds.includes(id))))
  const filedAccountMap: Record<string, { company_name: string; state_of_formation: string | null; gdrive_folder_url: string | null }> = {}
  if (filedAccountIds.length > 0) {
    const { data: extra } = await supabase
      .from('accounts')
      .select('id, company_name, state_of_formation, gdrive_folder_url')
      .in('id', filedAccountIds)
    for (const a of extra ?? []) {
      filedAccountMap[a.id] = {
        company_name: a.company_name,
        state_of_formation: a.state_of_formation,
        gdrive_folder_url: a.gdrive_folder_url,
      }
    }
  }

  // ─── 5. Closure / Offboarding flag per account ─────────────────────
  const offboardingAccounts = new Set<string>()
  if (accountIds.length > 0) {
    const { data: closures } = await supabase
      .from('service_deliveries')
      .select('account_id')
      .in('account_id', accountIds)
      .in('service_type', ['Company Closure', 'Client Offboarding'])
      .eq('status', 'active')
    for (const sd of closures ?? []) {
      if (sd.account_id) offboardingAccounts.add(sd.account_id)
    }
  }

  // ─── 6. Build renewal rows from accounts ───────────────────────────
  const renewalRows: RenewalRow[] = []
  for (const a of accountsForRenewals ?? []) {
    const addr = a.registered_agent_id ? raAddressMap.get(a.registered_agent_id) ?? null : null
    const provider = addr?.provider ?? null
    const agent_name = addr?.agent_name ?? null
    const ra_address_line = formatAddressLine(addr)
    const ra_county = addr?.county ?? null
    const has_offboarding = offboardingAccounts.has(a.id)

    // RA row (if date in year)
    if (a.ra_renewal_date && a.ra_renewal_date >= yearStart && a.ra_renewal_date <= yearEnd) {
      const sd = sdMap.get(`${a.id}:State RA Renewal`)
      const status: RenewalStatus = has_offboarding
        ? 'offboarding'
        : sd?.status === 'blocked'
          ? 'blocked'
          : sd?.status === 'active'
            ? 'active'
            : 'upcoming'
      renewalRows.push({
        kind: 'ra',
        account_id: a.id,
        company_name: a.company_name,
        state_of_formation: a.state_of_formation,
        due_date: a.ra_renewal_date,
        status,
        delivery_id: sd?.id ?? null,
        provider,
        agent_name,
        ra_address_line,
        ra_county,
        drive_folder_url: a.gdrive_folder_url,
        has_offboarding,
      })
    }
    // AR row (if date in year and state is not NM)
    if (
      a.annual_report_due_date &&
      a.annual_report_due_date >= yearStart &&
      a.annual_report_due_date <= yearEnd &&
      a.state_of_formation !== 'New Mexico'
    ) {
      const sd = sdMap.get(`${a.id}:State Annual Report`)
      const status: RenewalStatus = has_offboarding
        ? 'offboarding'
        : sd?.status === 'blocked'
          ? 'blocked'
          : sd?.status === 'active'
            ? 'active'
            : 'upcoming'
      renewalRows.push({
        kind: 'ar',
        account_id: a.id,
        company_name: a.company_name,
        state_of_formation: a.state_of_formation,
        due_date: a.annual_report_due_date,
        status,
        delivery_id: sd?.id ?? null,
        provider,
        agent_name,
        ra_address_line,
        ra_county,
        drive_folder_url: a.gdrive_folder_url,
        has_offboarding,
      })
    }
  }

  // ─── 7. Add filed-history rows ─────────────────────────────────────
  for (const f of filedSDs) {
    const accountFromMain = (accountsForRenewals ?? []).find(a => a.id === f.account_id)
    const accountFromExtra = filedAccountMap[f.account_id]
    const company_name = accountFromMain?.company_name ?? accountFromExtra?.company_name ?? '—'
    const state_of_formation = accountFromMain?.state_of_formation ?? accountFromExtra?.state_of_formation ?? null
    const drive_folder_url = accountFromMain?.gdrive_folder_url ?? accountFromExtra?.gdrive_folder_url ?? null
    renewalRows.push({
      kind: f.service_type === 'State RA Renewal' ? 'ra' : 'ar',
      account_id: f.account_id,
      company_name,
      state_of_formation,
      due_date: f.due_date,
      status: 'filed',
      delivery_id: null,
      provider: null,
      agent_name: null,
      ra_address_line: null,
      ra_county: null,
      drive_folder_url,
      has_offboarding: false,
    })
  }

  // ─── 8. Tax + payment rows (existing functionality, unchanged) ─────
  const [taxResult, paymentResult] = await Promise.all([
    supabase
      .from('tax_returns')
      .select('company_name, deadline, status, extension_deadline')
      .eq('tax_year', year)
      .order('deadline'),
    supabase
      .from('payments')
      .select('account_id, description, due_date, status, amount, period, year, installment')
      .in('status', ['Pending', 'Overdue'])
      .gte('due_date', yearStart)
      .lte('due_date', yearEnd),
  ])

  const payAccountIds = Array.from(new Set(
    (paymentResult.data ?? []).filter(p => p.account_id).map(p => p.account_id as string),
  ))
  const accountNameMap: Record<string, string> = {}
  if (payAccountIds.length > 0) {
    const { data: accts } = await supabase
      .from('accounts')
      .select('id, company_name')
      .in('id', payAccountIds)
    for (const a of accts ?? []) accountNameMap[a.id] = a.company_name
  }

  const infoRows: InfoRow[] = [
    ...(taxResult.data ?? []).map((t): InfoRow => ({
      kind: 'tax',
      company_name: t.company_name,
      due_date: t.deadline,
      type_label: 'Tax Return',
      status: t.status,
    })),
    ...(paymentResult.data ?? []).map((p): InfoRow => ({
      kind: 'payment',
      company_name: p.account_id ? accountNameMap[p.account_id] ?? 'N/A' : 'N/A',
      due_date: p.due_date!,
      type_label: 'Payment',
      status: p.status,
    })),
  ]

  const allRows: CalendarRow[] = [...renewalRows, ...infoRows]

  return (
    <div className="p-6 lg:p-8">
      <div className="mb-6">
        <h1 className="text-2xl font-semibold tracking-tight">Annual Calendar {year}</h1>
        <p className="text-muted-foreground text-sm mt-1">
          {allRows.length} items · {renewalRows.length} renewals · {infoRows.length} other
        </p>
      </div>
      <AnnualCalendar rows={allRows} year={year} today={today} />
    </div>
  )
}
