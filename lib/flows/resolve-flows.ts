/**
 * Flow Resolver — Service Flow Workspaces (S1).
 *
 * Given an account, return every active "flow" the staff/client should see:
 *   - live service_deliveries of the four recurring types, and
 *   - date-derived "scheduled" placeholders for RA Renewal / Annual Report when
 *     no SD exists yet (the SD is created later by the date-crons; see
 *     docs/specs/SERVICE-FLOW-WORKSPACES.md §3.2).
 *
 * Source of truth is service_deliveries (Q1 = extend, no parallel engine). This
 * module READS only — it never advances stages or creates SDs.
 *
 * Verified against live sandbox schema (2026-06-14): service_deliveries has no
 * `year` column and `stage_order` is frequently NULL while `stage` is set, so
 * we match by stage NAME and derive the cycle year best-effort.
 */

import { supabaseAdmin } from '@/lib/supabase-admin'

/** The four recurring, ACCOUNT-scoped flow types anchored on the annual renewal. */
export const FLOW_TYPES = [
  'Tax Return',
  'State Annual Report',
  'State RA Renewal',
  'CMRA Mailing Address',
  // A name change belongs to an existing company (account-scoped, a one-off — not a recurring
  // flow): the client gets a step card + page, staff a workspace link on the company page.
  'Company Change Name',
] as const

/** CONTACT-scoped flow types — their SDs carry a contact_id and frequently have
 *  account_id = NULL (e.g. ITIN, which can exist before/without an LLC; and an
 *  in-progress Company Formation, whose account doesn't exist until the Articles
 *  arrive). They are resolved by contact, never by account — so they surface on
 *  the CRM contact page (the account page can't show them: there's no account).
 *  Note: once a formation materializes, its SD becomes account-scoped, so the
 *  contact-scoped queries (which filter account_id IS NULL) only ever surface the
 *  in-progress one. */
export const CONTACT_FLOW_TYPES = ['ITIN', 'Company Formation'] as const

/** Flow types whose client page shows the rich per-step journey (driven by client_description)
 *  instead of the compact stepper: the contact-scoped ones, plus Company Change Name. */
export const JOURNEY_FLOW_TYPES = [...CONTACT_FLOW_TYPES, 'Company Change Name'] as const

/** Every flow type that has a Workspace (account-scoped + contact-scoped). */
export const ALL_FLOW_TYPES = [...FLOW_TYPES, ...CONTACT_FLOW_TYPES] as const

export type FlowType = (typeof ALL_FLOW_TYPES)[number]

/** Flow types shown ONLY on the staff CRM contact page, never to the client. A Company Closure of a company we do not
 *  track (or any closure the client is asked to describe in the portal wizard) lives on the PERSON — there is no
 *  company page to open it from, so without this the closure workspace (the client's answers and documents) was
 *  unreachable from the contact (Contrabona, 2026-11-11). It is deliberately NOT in CONTACT_FLOW_TYPES: that list
 *  also feeds the CLIENT portal (Service Status, the flow page gate, the journey layout), which a closure must not join. */
export const STAFF_CONTACT_FLOW_TYPES = ['Company Closure'] as const

export type StaffFlowType = FlowType | (typeof STAFF_CONTACT_FLOW_TYPES)[number]

/** Flow types whose SD is created lazily by a date-cron — eligible for a
 *  date-derived "scheduled" placeholder when no SD exists yet. */
export const SCHEDULED_FLOW_DATE_COLUMN: Partial<Record<FlowType, 'ra_renewal_date' | 'annual_report_due_date'>> = {
  'State RA Renewal': 'ra_renewal_date',
  'State Annual Report': 'annual_report_due_date',
}

export type FlowStatus = 'scheduled' | 'active' | 'completed'

export interface ResolvedFlow {
  flow_type: StaffFlowType
  service_delivery_id: string | null
  stage_name: string | null
  stage_order: number | null
  year: number | null
  status: FlowStatus
  due_date: string | null
  account_id: string
  company_name: string | null
  /** A job that is one of several from the same offer ("#2" — a contract that closes two companies has two
   *  Company Closure jobs, named "… #1" / "… #2"), so their cards can be told apart before the client's form
   *  names the company. Staff-only closure chips; null / absent for everything else. */
  unit_label?: string | null
}

/** Minimal shape of a service_delivery row this resolver consumes. */
export interface SdRow {
  id: string
  service_type: string | null
  stage: string | null
  stage_order: number | null
  status: string | null
  due_date: string | null
  stage_entered_at: string | null
  created_at: string | null
  account_id: string | null
  /** Only read for Company Closure (the "#n" in the job's name). */
  service_name?: string | null
}

export interface AccountDates {
  id: string
  company_name: string | null
  ra_renewal_date: string | null
  annual_report_due_date: string | null
}

// ── Pure helpers (unit-tested) ───────────────────────────────────────────────

/** Year of an ISO date/timestamp string, or null if unparseable. */
export function yearOf(value: string | null | undefined): number | null {
  if (!value) return null
  const y = Number(String(value).slice(0, 4))
  return Number.isFinite(y) && y > 1900 ? y : null
}

/**
 * The tax year a Tax Return SD is FOR. A return is filed the year after the year it covers (the
 * 2025 returns were opened, worked and filed in 2026), so the year the SD lives in is the filing
 * year and the tax year is one less. Antonio 2026-11-05: the client chat tab and the workspace
 * said "Tax Return 2026" on 2025 returns because the year was read off the date the SD moved.
 * The filing year comes from the deadline when one is stored, else from when the SD was created
 * (stable — unlike stage_entered_at, which moves every time staff advance the job), else from the
 * last stage move. Verified on production 2026-11-05: all 232 Tax Return SDs have no deadline and
 * were created in 2026, and 221 of their companies hold a 2025 tax record.
 */
export function taxReturnYear(sd: Pick<SdRow, 'due_date' | 'stage_entered_at' | 'created_at'> & { service_name?: string | null }): number | null {
  // A creator that KNOWS the tax year writes it into the name — read that first (bug-hunter 2026-11-05: the onboarding
  // job makes "Tax Return - <company> 2026" for the CURRENT-year return, which "opened year - 1" would call 2025).
  const named = taxYearFromServiceName(sd.service_name)
  if (named != null) return named
  const filingYear = yearOf(sd.due_date) ?? yearOf(sd.created_at) ?? yearOf(sd.stage_entered_at)
  return filingYear ? filingYear - 1 : null
}

/**
 * The tax year a Tax Return SD NAME states, for the two formats the creators write (the lib/installment-handler.ts and
 * lib/operations/tax-return-sd-bridge.ts shape "Tax Return 2025 - <company>", the lib/jobs/handlers/onboarding-setup.ts
 * shape "Tax Return - <company> 2026"). Anchored on purpose — a company name that itself contains a year ("Studio 2024 LLC")
 * must never be read as the tax year — and anything else (the usual plain "Tax Return") returns null. Pure.
 */
export function taxYearFromServiceName(name: string | null | undefined): number | null {
  const n = (name ?? '').trim()
  const m = /^Tax Return (20\d{2}) - /.exec(n) ?? /^Tax Return - .+ (20\d{2})$/.exec(n)
  return m ? Number(m[1]) : null
}

/**
 * Best-effort cycle year for a live SD. There is no `year` column, so we prefer
 * the most semantically meaningful date available: the deadline, then when the
 * SD entered its current stage, then creation. Returns null if none parse.
 * A Tax Return SD is the exception: its year is the TAX year (see `taxReturnYear`), so pass the
 * row with its `service_type`.
 */
export function deriveFlowYear(sd: Pick<SdRow, 'due_date' | 'stage_entered_at' | 'created_at'> & { service_type?: string | null; service_name?: string | null }): number | null {
  if (sd.service_type === 'Tax Return') return taxReturnYear(sd)
  return yearOf(sd.due_date) ?? yearOf(sd.stage_entered_at) ?? yearOf(sd.created_at)
}

/** Map a service_delivery status to the coarse flow status. */
export function flowStatusFromSd(sdStatus: string | null): FlowStatus {
  return sdStatus === 'completed' ? 'completed' : 'active'
}

/**
 * Topic label for a flow's chat thread, e.g. "Tax Return 2025". The year is
 * appended only when known (deriveFlowYear may return null). Returns "" for an
 * empty/whitespace service type so callers can fall back to null. Pure.
 */
export function buildFlowTopic(
  serviceType: string | null | undefined,
  year: number | null | undefined,
): string {
  const base = (serviceType ?? '').trim()
  if (!base) return ''
  return year ? `${base} ${year}` : base
}

/** Transform one live SD row into a ResolvedFlow. */
export function mapSdToFlow(sd: SdRow, account: AccountDates): ResolvedFlow {
  return {
    flow_type: sd.service_type as FlowType,
    service_delivery_id: sd.id,
    stage_name: sd.stage,
    stage_order: sd.stage_order,
    year: deriveFlowYear(sd),
    status: flowStatusFromSd(sd.status),
    due_date: sd.due_date,
    account_id: account.id,
    company_name: account.company_name,
  }
}

/**
 * Build date-derived "scheduled" placeholders for RA Renewal / Annual Report
 * when the account carries the renewal date but no live SD exists yet for that
 * flow type. Honors the locked decision that flows are surfaced from the
 * account's renewal dates even before the cron materializes the SD.
 */
export function buildScheduledFlows(account: AccountDates, liveFlowTypes: Set<FlowType>): ResolvedFlow[] {
  const out: ResolvedFlow[] = []
  for (const flowType of Object.keys(SCHEDULED_FLOW_DATE_COLUMN) as FlowType[]) {
    if (liveFlowTypes.has(flowType)) continue
    const col = SCHEDULED_FLOW_DATE_COLUMN[flowType]!
    const date = account[col]
    if (!date) continue
    out.push({
      flow_type: flowType,
      service_delivery_id: null,
      stage_name: null,
      stage_order: null,
      year: yearOf(date),
      status: 'scheduled',
      due_date: date,
      account_id: account.id,
      company_name: account.company_name,
    })
  }
  return out
}

/**
 * Combine live SDs and scheduled placeholders into the final flow list.
 * Pure — the DB I/O lives in resolveFlows().
 */
export function assembleFlows(account: AccountDates, sds: SdRow[]): ResolvedFlow[] {
  const live = sds
    .filter((sd) => (FLOW_TYPES as readonly string[]).includes(sd.service_type ?? ''))
    .map((sd) => mapSdToFlow(sd, account))
  const liveTypes = new Set<FlowType>(live.map((f) => f.flow_type as FlowType))
  const scheduled = buildScheduledFlows(account, liveTypes)
  return [...live, ...scheduled]
}

// ── DB-backed entry point ────────────────────────────────────────────────────

/**
 * Resolve all active flows for an account: live SDs of the four recurring types
 * plus date-derived scheduled placeholders for RA/AR. Read-only.
 */
export async function resolveFlows(accountId: string): Promise<ResolvedFlow[]> {
  const [{ data: accountRow }, { data: sdRows }] = await Promise.all([
    supabaseAdmin
      .from('accounts')
      .select('id, company_name, ra_renewal_date, annual_report_due_date')
      .eq('id', accountId)
      .single(),
    supabaseAdmin
      .from('service_deliveries')
      .select('id, service_type, stage, stage_order, status, due_date, stage_entered_at, created_at, account_id')
      .eq('account_id', accountId)
      .in('service_type', FLOW_TYPES as unknown as string[])
      .neq('status', 'cancelled')
      .order('updated_at', { ascending: false }),
  ])

  if (!accountRow) return []

  const account: AccountDates = {
    id: accountRow.id as string,
    company_name: (accountRow.company_name as string | null) ?? null,
    ra_renewal_date: (accountRow.ra_renewal_date as string | null) ?? null,
    annual_report_due_date: (accountRow.annual_report_due_date as string | null) ?? null,
  }

  return assembleFlows(account, (sdRows ?? []) as SdRow[])
}

/**
 * Resolve CONTACT-scoped flows for a contact: live SDs of the contact-scoped
 * flow types (ITIN), which frequently have account_id = NULL. Read-only. No
 * scheduled placeholders — these flows aren't date-derived. Surfaces the flow
 * chips on the CRM contact-detail page (the account page can't show them because
 * the SDs have no account).
 */
export async function resolveFlowsByContact(contactId: string): Promise<ResolvedFlow[]> {
  const { data: sdRows } = await supabaseAdmin
    .from('service_deliveries')
    .select('id, service_type, service_name, stage, stage_order, status, due_date, stage_entered_at, created_at, account_id')
    .eq('contact_id', contactId)
    .in('service_type', [...CONTACT_FLOW_TYPES, ...STAFF_CONTACT_FLOW_TYPES] as unknown as string[])
    .neq('status', 'cancelled')
    .order('updated_at', { ascending: false })

  const rows = (sdRows ?? []) as SdRow[]
  // A closure chip is told apart by the company being closed: the CRM company for a closure on one of ours, else
  // the name the client wrote in the closure form (known only once the form is in).
  const closureNames = await closureCompanyNames(rows.filter((r) => r.service_type === 'Company Closure'))

  return rows.map((sd) => ({
    flow_type: sd.service_type as StaffFlowType,
    service_delivery_id: sd.id,
    stage_name: sd.stage,
    stage_order: sd.stage_order,
    year: deriveFlowYear(sd),
    status: flowStatusFromSd(sd.status),
    due_date: sd.due_date,
    account_id: sd.account_id ?? '',
    company_name: closureNames.get(sd.id) ?? null,
    unit_label: sd.service_type === 'Company Closure' ? closureUnitLabel(sd.service_name) : null,
  }))
}

/** "#2" from a closure job named "Company Closure - Client #2"; null when the name has no unit number. Pure. */
export function closureUnitLabel(serviceName: string | null | undefined): string | null {
  const m = /#(\d{1,2})\s*$/.exec(String(serviceName ?? ''))
  return m ? `#${m[1]}` : null
}

/**
 * The company a Company Closure job is about, per job: the CRM company for a closure on a company of ours, else the
 * name the client typed in the closure form (wizard answer `llc_name`). A job whose form is not in yet has no name.
 * Never throws — a failed lookup only means the chip has no name.
 */
async function closureCompanyNames(closures: SdRow[]): Promise<Map<string, string>> {
  const names = new Map<string, string>()
  if (closures.length === 0) return names
  try {
    const accountIds = Array.from(new Set(closures.map((c) => c.account_id).filter((x): x is string => !!x)))
    if (accountIds.length > 0) {
      const { data: accounts } = await supabaseAdmin.from('accounts').select('id, company_name').in('id', accountIds)
      const byId = new Map((accounts ?? []).map((a) => [a.id as string, (a.company_name as string | null) ?? '']))
      for (const c of closures) {
        const n = c.account_id ? byId.get(c.account_id) : ''
        if (n && n.trim()) names.set(c.id, n.trim())
      }
    }
    const personLevel = closures.filter((c) => !c.account_id).map((c) => c.id)
    if (personLevel.length > 0) {
      const { data: wizards } = await supabaseAdmin
        .from('wizard_progress')
        .select('service_delivery_id, data')
        .eq('wizard_type', 'closure')
        .in('service_delivery_id', personLevel)
      for (const w of wizards ?? []) {
        const answers = (w.data ?? {}) as { llc_name?: unknown }
        const n = typeof answers.llc_name === 'string' ? answers.llc_name.trim() : ''
        if (w.service_delivery_id && n) names.set(w.service_delivery_id, n)
      }
    }
  } catch {
    // a missing name is cosmetic
  }
  return names
}
