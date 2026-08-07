import { createClient } from '@/lib/supabase/server'
import { AnnualCalendar } from '@/components/calendar/annual-calendar'
import { ProblemsRail } from '@/components/calendar/problems-rail'
import { resolveDriveFolderUrl } from '@/lib/drive-folder-url'
import { loadRenewalStatuses } from '@/lib/operations/renewal-status-loader'
import { proposeRenewalFixes, type RenewalFixProposal } from '@/lib/operations/renewal-problem-proposals'
import type { ObligationStatus, ObligationVerdict } from '@/lib/operations/renewal-status'

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
  /** The status engine's verdict for this obligation (single source of truth). */
  engine_status?: ObligationStatus
  engine_cause?: string
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

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size))
  return out
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

  // ─── 1. FULL roster + status engine (plan 89c951a7) ────────────────
  // Every active company is loaded and judged — the year window below only
  // decides where a dated row lands on the grid. Problems are computed from
  // the engine verdicts and shown in the rail REGARDLESS of the viewed year,
  // so a company with a stale 2025 date can never vanish from sight again.
  const loaded = await loadRenewalStatuses(supabase, { today })
  const onCalendar = loaded.filter(l => l.status.onCalendar)

  const proposals: RenewalFixProposal[] = onCalendar.flatMap(l =>
    proposeRenewalFixes(l, { today }),
  )

  // ─── 2. RA address registry rows (chunked — full roster of ids) ────
  const raAddressIds = Array.from(new Set(
    onCalendar.map(l => l.account.registered_agent_id).filter((id): id is string => id !== null),
  ))
  const raAddressMap = new Map<string, RawAddress>()
  for (const ids of chunk(raAddressIds, 100)) {
    const { data: addrs } = await supabase
      .from('addresses')
      .select('id, provider, agent_name, address_line1, address_line2, city, state, zip, county')
      .in('id', ids)
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

  // ─── 3. Completed SDs in this year — 🟢 filed history ──────────────
  // Paged (silent 1000-row cap), and filtered to the same roster rules as
  // the rest of the calendar: One-Time / test / internal never render here
  // either (ruling b — a QA Mark-Filed run must not paint a green row).
  const filedSDs: { account_id: string; service_type: string; due_date: string }[] = []
  for (let from = 0; ; from += 1000) {
    const { data: completed } = await supabase
      .from('service_deliveries')
      .select('id, account_id, service_type, status, due_date')
      .in('service_type', ['State RA Renewal', 'State Annual Report'])
      .eq('status', 'completed')
      .gte('due_date', yearStart)
      .lte('due_date', yearEnd)
      .order('id')
      .range(from, from + 999)
    for (const sd of completed ?? []) {
      if (sd.account_id) {
        filedSDs.push({ account_id: sd.account_id, service_type: sd.service_type, due_date: sd.due_date! })
      }
    }
    if ((completed ?? []).length < 1000) break
  }
  const loadedById = new Map(loaded.map(l => [l.account.id, l]))
  const filedAccountIds = Array.from(new Set(filedSDs.map(s => s.account_id).filter(id => !loadedById.has(id))))
  const filedAccountMap: Record<string, { company_name: string; state_of_formation: string | null; drive_folder_url: string | null }> = {}
  for (const ids of chunk(filedAccountIds, 100)) {
    const { data: extra } = await supabase
      .from('accounts')
      .select('id, company_name, state_of_formation, gdrive_folder_url, drive_folder_id, account_type, is_test, is_internal')
      .in('id', ids)
    for (const a of extra ?? []) {
      if (a.is_test || a.is_internal || a.account_type === 'One-Time') continue
      filedAccountMap[a.id] = {
        company_name: a.company_name,
        state_of_formation: a.state_of_formation,
        drive_folder_url: resolveDriveFolderUrl(a.gdrive_folder_url, a.drive_folder_id),
      }
    }
  }
  // Roster rule for filed rows: on-calendar loader accounts, or (for
  // no-longer-active accounts) the non-test non-One-Time survivors above.
  const visibleFiledSDs = filedSDs.filter(f => {
    const l = loadedById.get(f.account_id)
    if (l) return l.status.onCalendar
    return !!filedAccountMap[f.account_id]
  })

  // ─── 4. Grid rows from engine verdicts ─────────────────────────────
  const renewalRows: RenewalRow[] = []
  for (const l of onCalendar) {
    const a = l.account
    const addr = a.registered_agent_id ? raAddressMap.get(a.registered_agent_id) ?? null : null
    const provider = addr?.provider ?? a.registered_agent_provider ?? null
    const agent_name = addr?.agent_name ?? null  // legacy text columns don't separate agent from address
    const ra_address_line = formatAddressLine(addr) ?? a.registered_agent_address ?? null
    const ra_county = addr?.county ?? null
    const has_offboarding = l.status.closing

    const obligations: Array<{ kind: RenewalKind; verdict: ObligationVerdict; sdType: string }> = [
      { kind: 'ra', verdict: l.status.ra, sdType: 'State RA Renewal' },
      { kind: 'ar', verdict: l.status.annualReport, sdType: 'State Annual Report' },
    ]
    for (const { kind, verdict, sdType } of obligations) {
      if (verdict.status === 'not_applicable') continue
      if (!verdict.date) continue // missing dates live in the problems rail
      if (verdict.date < yearStart || verdict.date > yearEnd) continue
      const sd = l.renewalSDs.find(s => s.service_type === sdType && (s.status === 'active' || s.status === 'blocked'))
      // Status comes from the LIVE engine verdict only. The stored SD
      // 'blocked' stamp is deliberately ignored — it goes stale when the
      // client pays (nothing flips it back) and would lock Mark Filed
      // forever (bug-hunter major #2). A blocked SD with clean payments
      // renders as a normal working row.
      const status: RenewalStatus = has_offboarding
        ? 'offboarding'
        : verdict.status === 'on_hold_unpaid'
          ? 'blocked'
          : sd
            ? 'active'
            : 'upcoming'
      renewalRows.push({
        kind,
        account_id: a.id,
        company_name: a.company_name,
        state_of_formation: a.state_of_formation,
        due_date: verdict.date,
        status,
        delivery_id: sd?.id ?? null,
        provider,
        agent_name,
        ra_address_line,
        ra_county,
        drive_folder_url: resolveDriveFolderUrl(a.gdrive_folder_url, a.drive_folder_id),
        has_offboarding,
        engine_status: verdict.status,
        engine_cause: verdict.cause,
      })
    }
  }

  // ─── 5. Filed-history rows ─────────────────────────────────────────
  for (const f of visibleFiledSDs) {
    const fromLoader = loadedById.get(f.account_id)
    const fromExtra = filedAccountMap[f.account_id]
    const company_name = fromLoader?.account.company_name ?? fromExtra?.company_name ?? '—'
    const state_of_formation = fromLoader?.account.state_of_formation ?? fromExtra?.state_of_formation ?? null
    const drive_folder_url = fromLoader
      ? resolveDriveFolderUrl(fromLoader.account.gdrive_folder_url, fromLoader.account.drive_folder_id)
      : fromExtra?.drive_folder_url ?? null
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

  // ─── 6. Tax + payment rows (unchanged) ─────────────────────────────
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
  for (const ids of chunk(payAccountIds, 100)) {
    const { data: accts } = await supabase
      .from('accounts')
      .select('id, company_name')
      .in('id', ids)
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
          {onCalendar.length} companies tracked · {allRows.length} items in {year} ·{' '}
          {renewalRows.length} renewals · {infoRows.length} other
        </p>
      </div>
      <div className="mb-6">
        <ProblemsRail proposals={proposals} />
      </div>
      <AnnualCalendar rows={allRows} year={year} today={today} />
    </div>
  )
}
