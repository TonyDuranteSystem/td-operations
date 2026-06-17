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
] as const

/** CONTACT-scoped flow types — their SDs carry a contact_id and frequently have
 *  account_id = NULL, so they're resolved by contact, never by account:
 *   - ITIN: can exist before/without an LLC.
 *   - Company Formation: while a NEW company is being formed it has no account yet
 *     (account_id is set only at materialization, per getInProgressFormations), so
 *     in-progress formations are contact-scoped and must surface on the contact page.
 */
export const CONTACT_FLOW_TYPES = ['ITIN', 'Company Formation'] as const

/** Every flow type that has a Workspace (account-scoped + contact-scoped). */
export const ALL_FLOW_TYPES = [...FLOW_TYPES, ...CONTACT_FLOW_TYPES] as const

export type FlowType = (typeof ALL_FLOW_TYPES)[number]

/** Flow types whose SD is created lazily by a date-cron — eligible for a
 *  date-derived "scheduled" placeholder when no SD exists yet. */
export const SCHEDULED_FLOW_DATE_COLUMN: Partial<Record<FlowType, 'ra_renewal_date' | 'annual_report_due_date'>> = {
  'State RA Renewal': 'ra_renewal_date',
  'State Annual Report': 'annual_report_due_date',
}

export type FlowStatus = 'scheduled' | 'active' | 'completed'

export interface ResolvedFlow {
  flow_type: FlowType
  service_delivery_id: string | null
  stage_name: string | null
  stage_order: number | null
  year: number | null
  status: FlowStatus
  due_date: string | null
  account_id: string
  company_name: string | null
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
 * Best-effort cycle year for a live SD. There is no `year` column, so we prefer
 * the most semantically meaningful date available: the deadline, then when the
 * SD entered its current stage, then creation. Returns null if none parse.
 */
export function deriveFlowYear(sd: Pick<SdRow, 'due_date' | 'stage_entered_at' | 'created_at'>): number | null {
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
  const liveTypes = new Set<FlowType>(live.map((f) => f.flow_type))
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
    .select('id, service_type, stage, stage_order, status, due_date, stage_entered_at, created_at, account_id')
    .eq('contact_id', contactId)
    .in('service_type', CONTACT_FLOW_TYPES as unknown as string[])
    .neq('status', 'cancelled')
    .order('updated_at', { ascending: false })

  return ((sdRows ?? []) as SdRow[]).map((sd) => ({
    flow_type: sd.service_type as FlowType,
    service_delivery_id: sd.id,
    stage_name: sd.stage,
    stage_order: sd.stage_order,
    year: deriveFlowYear(sd),
    status: flowStatusFromSd(sd.status),
    due_date: sd.due_date,
    account_id: sd.account_id ?? '',
    company_name: null,
  }))
}
