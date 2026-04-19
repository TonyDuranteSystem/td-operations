import { supabaseAdmin } from '@/lib/supabase-admin'

export type CasePhase = 'Offboarded' | 'Closure' | 'Formation' | 'Onboarding' | 'Active'

export interface CaseViewRow {
  account_id: string
  company_name: string
  case_phase: CasePhase
  case_opened_at: string
  case_phase_entered_at: string | null
  active_service_count: number
  has_active_renewal: boolean
  has_active_closure: boolean
  open_exception_count: number
  overdue_invoice_count: number
  unread_thread_count: number
  last_activity_at: string | null
}

export interface ActiveSD {
  service_type: string
  updated_at: string | null
}

export const RENEWAL_SERVICE_TYPES = [
  'State RA Renewal',
  'State Annual Report',
  'Annual Renewal',
] as const

export const CLOSURE_SERVICE_TYPES = [
  'Company Closure',
  'Client Offboarding',
] as const

/**
 * Derives case phase from account status and active service deliveries.
 * Precedence: Offboarded → Closure → Formation → Onboarding → Active.
 * Renewal is a flag (has_active_renewal), not a phase.
 */
export function derivePhase(
  accountStatus: string | null,
  portalTier: string | null,
  activeSDs: ActiveSD[]
): CasePhase {
  if (accountStatus === 'Cancelled' || accountStatus === 'Closed') {
    return 'Offboarded'
  }

  if (
    accountStatus === 'Offboarding' ||
    activeSDs.some(sd => (CLOSURE_SERVICE_TYPES as readonly string[]).includes(sd.service_type))
  ) {
    return 'Closure'
  }

  if (
    accountStatus === 'Pending Formation' ||
    activeSDs.some(sd => sd.service_type === 'Company Formation')
  ) {
    return 'Formation'
  }

  if (
    activeSDs.some(sd => sd.service_type === 'Client Onboarding') ||
    portalTier === 'onboarding'
  ) {
    return 'Onboarding'
  }

  return 'Active'
}

/**
 * Approximates when the account entered the current phase.
 * Uses MAX(updated_at) of the SDs driving the phase, falling back to
 * accountUpdatedAt or caseOpenedAt when no SDs are relevant.
 * This is intentionally approximate — see case-view-step1-final.md §2.
 */
export function derivePhaseEnteredAt(
  phase: CasePhase,
  accountUpdatedAt: string | null,
  caseOpenedAt: string,
  activeSDs: ActiveSD[]
): string | null {
  const latestSDUpdatedAt = (sds: ActiveSD[]): string | null => {
    const dates = sds.map(sd => sd.updated_at).filter((d): d is string => d !== null)
    return dates.length > 0 ? dates.sort().at(-1)! : null
  }

  switch (phase) {
    case 'Offboarded':
      return accountUpdatedAt ?? caseOpenedAt

    case 'Closure': {
      const closureSDs = activeSDs.filter(sd =>
        (CLOSURE_SERVICE_TYPES as readonly string[]).includes(sd.service_type)
      )
      return latestSDUpdatedAt(closureSDs) ?? accountUpdatedAt ?? caseOpenedAt
    }

    case 'Formation': {
      const formationSDs = activeSDs.filter(sd => sd.service_type === 'Company Formation')
      return latestSDUpdatedAt(formationSDs) ?? accountUpdatedAt ?? caseOpenedAt
    }

    case 'Onboarding': {
      const onboardingSDs = activeSDs.filter(sd => sd.service_type === 'Client Onboarding')
      return latestSDUpdatedAt(onboardingSDs) ?? caseOpenedAt
    }

    case 'Active':
      return caseOpenedAt
  }
}

function maxDate(...dates: (string | null | undefined)[]): string | null {
  const valid = dates.filter((d): d is string => typeof d === 'string' && d.length > 0)
  return valid.length > 0 ? valid.sort().at(-1)! : null
}

export async function getCaseViewRows(): Promise<CaseViewRow[]> {
  const { data: accounts, error: accErr } = await supabaseAdmin
    .from('accounts')
    .select('id, company_name, status, portal_tier, created_at, updated_at')
    .order('company_name')

  if (accErr || !accounts || accounts.length === 0) return []

  const accountIds = accounts.map(a => a.id)

  const [sdsResult, paymentsResult, messagesResult, jobsResult, tasksResult, paymentActivityResult] =
    await Promise.all([
      supabaseAdmin
        .from('service_deliveries')
        .select('account_id, service_type, updated_at')
        .in('account_id', accountIds)
        .eq('status', 'active'),

      supabaseAdmin
        .from('payments')
        .select('account_id')
        .in('account_id', accountIds)
        .eq('status', 'Overdue'),

      supabaseAdmin
        .from('messages')
        .select('account_id')
        .in('account_id', accountIds)
        .eq('status', 'new'),

      supabaseAdmin
        .from('job_queue')
        .select('account_id')
        .in('account_id', accountIds)
        .eq('status', 'failed'),

      supabaseAdmin
        .from('tasks')
        .select('account_id, updated_at')
        .in('account_id', accountIds)
        .not('updated_at', 'is', null),

      supabaseAdmin
        .from('payments')
        .select('account_id, updated_at')
        .in('account_id', accountIds)
        .not('updated_at', 'is', null),
    ])

  // Build lookup maps
  const sdsByAccount = new Map<string, ActiveSD[]>()
  for (const sd of sdsResult.data ?? []) {
    if (!sd.account_id) continue
    const list = sdsByAccount.get(sd.account_id) ?? []
    list.push({ service_type: sd.service_type, updated_at: sd.updated_at })
    sdsByAccount.set(sd.account_id, list)
  }

  const overdueByAccount = new Map<string, number>()
  for (const p of paymentsResult.data ?? []) {
    if (!p.account_id) continue
    overdueByAccount.set(p.account_id, (overdueByAccount.get(p.account_id) ?? 0) + 1)
  }

  const unreadByAccount = new Map<string, number>()
  for (const m of messagesResult.data ?? []) {
    if (!m.account_id) continue
    unreadByAccount.set(m.account_id, (unreadByAccount.get(m.account_id) ?? 0) + 1)
  }

  const exceptionsByAccount = new Map<string, number>()
  for (const j of jobsResult.data ?? []) {
    if (!j.account_id) continue
    exceptionsByAccount.set(j.account_id, (exceptionsByAccount.get(j.account_id) ?? 0) + 1)
  }

  const latestTaskAt = new Map<string, string>()
  for (const t of tasksResult.data ?? []) {
    if (!t.account_id || !t.updated_at) continue
    const current = latestTaskAt.get(t.account_id)
    if (!current || t.updated_at > current) latestTaskAt.set(t.account_id, t.updated_at)
  }

  const latestPaymentAt = new Map<string, string>()
  for (const p of paymentActivityResult.data ?? []) {
    if (!p.account_id || !p.updated_at) continue
    const current = latestPaymentAt.get(p.account_id)
    if (!current || p.updated_at > current) latestPaymentAt.set(p.account_id, p.updated_at)
  }

  return accounts.map(account => {
    const sds = sdsByAccount.get(account.id) ?? []
    const phase = derivePhase(account.status, account.portal_tier, sds)
    const caseOpenedAt = account.created_at ?? new Date().toISOString()

    const sdDates = sds.map(sd => sd.updated_at).filter((d): d is string => d !== null)
    const maxSDAt = sdDates.length > 0 ? sdDates.sort().at(-1)! : null

    return {
      account_id: account.id,
      company_name: account.company_name,
      case_phase: phase,
      case_opened_at: caseOpenedAt,
      case_phase_entered_at: derivePhaseEnteredAt(phase, account.updated_at, caseOpenedAt, sds),
      active_service_count: sds.length,
      has_active_renewal: sds.some(sd =>
        (RENEWAL_SERVICE_TYPES as readonly string[]).includes(sd.service_type)
      ),
      has_active_closure: sds.some(sd =>
        (CLOSURE_SERVICE_TYPES as readonly string[]).includes(sd.service_type)
      ),
      open_exception_count: exceptionsByAccount.get(account.id) ?? 0,
      overdue_invoice_count: overdueByAccount.get(account.id) ?? 0,
      unread_thread_count: unreadByAccount.get(account.id) ?? 0,
      last_activity_at: maxDate(maxSDAt, latestTaskAt.get(account.id), latestPaymentAt.get(account.id)),
    }
  })
}
