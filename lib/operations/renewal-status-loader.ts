/**
 * Batched loader for the Renewal Status Engine (plan 89c951a7).
 *
 * Loads the FULL active roster in a fixed number of queries (never N+1),
 * builds one RenewalStatusInput per account, and runs computeRenewalStatus.
 * Consumers: the calendar page (full-roster inversion), the problems rail,
 * the daily cron report, and the replay QA script — all read THIS loader so
 * they can never disagree.
 *
 * Query-shape rules:
 *  - Child tables (SDs, payments, tax returns) are fetched by TYPE/STATUS
 *    filters and joined in code — never `.in('account_id', [300 uuids])`,
 *    which risks PostgREST URL-length limits on the full roster.
 *  - Every list fetch is paged (PAGE_SIZE) — supabase-js silently caps at
 *    1000 rows and a truncated SD list would mislabel real companies
 *    (the paged-fetch scar from the S-corp books build).
 */

import type { SupabaseClient } from "@supabase/supabase-js"
import { classifyAccount } from "@/lib/account-classification"
import {
  computeRenewalStatus,
  type CompanyRenewalStatus,
  type RenewalStatusInput,
} from "@/lib/operations/renewal-status"

const PAGE_SIZE = 1000

const RENEWAL_TYPES = ["State RA Renewal", "State Annual Report"] as const
const CLOSURE_TYPES = ["Company Closure", "Client Offboarding"] as const
const FORMATION_TYPE = "Company Formation"
const OVERDUE_PAYMENT_STATUSES = ["Overdue", "Delinquent"] as const

/** Account row loaded for status computation + calendar presentation. */
export interface RenewalAccountRow {
  id: string
  company_name: string
  account_type: string | null
  status: string | null
  state_of_formation: string | null
  formation_date: string | null
  ra_renewal_date: string | null
  annual_report_due_date: string | null
  is_test: boolean | null
  is_internal: boolean | null
  ein_number: string | null
  entity_type: string | null
  ra_switch_date: string | null
  client_since: string | null
  // Presentation extras for the calendar (RA registry + Drive)
  registered_agent_id: string | null
  registered_agent_provider: string | null
  registered_agent_address: string | null
  gdrive_folder_url: string | null
  drive_folder_id: string | null
  portal_tier: string | null
}

export interface LoadedRenewalAccount {
  account: RenewalAccountRow
  status: CompanyRenewalStatus
  /** How this company entered TD — decides which anniversary rule a missing
   *  date would be derived from. null = ambiguous, never guess (R093). */
  intake: "formation" | "onboarding" | null
  /** The renewal SDs the verdicts were computed from (calendar rows need
   *  the active SD id for the Mark-Filed dialog — no re-query). */
  renewalSDs: RenewalStatusInput["renewalSDs"]
}

interface SdRow {
  id: string
  account_id: string | null
  service_type: string
  status: string
  stage: string | null
  stage_order: number | null
  due_date: string | null
}

async function fetchAllPages<T>(
  fetchPage: (from: number, to: number) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
): Promise<T[]> {
  const all: T[] = []
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await fetchPage(from, from + PAGE_SIZE - 1)
    if (error) throw new Error(`renewal-status-loader fetch failed: ${error.message}`)
    const rows = data ?? []
    all.push(...rows)
    if (rows.length < PAGE_SIZE) return all
  }
}

export interface LoadRenewalStatusOptions {
  /** Restrict to specific accounts (e.g. one company's detail view). */
  accountIds?: string[]
  /** Injectable for tests/replay: 'YYYY-MM-DD'. Defaults to today. */
  today?: string
  upcomingWindowDays?: number
}

/**
 * Load and compute renewal status for every Active Client / One-Time account.
 * One-Time rows are computed (replay coverage) but come back onCalendar=false.
 */
export async function loadRenewalStatuses(
  supabase: SupabaseClient,
  opts: LoadRenewalStatusOptions = {},
): Promise<LoadedRenewalAccount[]> {
  const today = opts.today ?? new Date().toISOString().split("T")[0]
  const currentYear = parseInt(today.split("-")[0], 10)

  // ── 1. The roster ────────────────────────────────────────────────
  const accounts = await fetchAllPages<RenewalAccountRow>((from, to) => {
    let q = supabase
      .from("accounts")
      .select(
        "id, company_name, account_type, status, state_of_formation, formation_date, ra_renewal_date, annual_report_due_date, is_test, is_internal, ein_number, entity_type, ra_switch_date, client_since, registered_agent_id, registered_agent_provider, registered_agent_address, gdrive_folder_url, drive_folder_id, portal_tier",
      )
      .eq("status", "Active")
      .in("account_type", ["Client", "One-Time"])
      .order("id")
      .range(from, to)
    if (opts.accountIds?.length) q = q.in("id", opts.accountIds)
    return q
  })
  if (accounts.length === 0) return []
  const accountIdSet = new Set(accounts.map(a => a.id))

  // ── 2. All relevant SDs, joined in code ──────────────────────────
  const sds = await fetchAllPages<SdRow>((from, to) =>
    supabase
      .from("service_deliveries")
      .select("id, account_id, service_type, status, stage, stage_order, due_date")
      .in("service_type", [...RENEWAL_TYPES, ...CLOSURE_TYPES, FORMATION_TYPE])
      .order("id")
      .range(from, to),
  )
  const renewalSDsByAccount = new Map<string, RenewalStatusInput["renewalSDs"]>()
  const formationSDByAccount = new Map<string, SdRow>()
  const closureAccounts = new Set<string>()
  for (const sd of sds) {
    if (!sd.account_id || !accountIdSet.has(sd.account_id)) continue
    if ((RENEWAL_TYPES as readonly string[]).includes(sd.service_type)) {
      const list = renewalSDsByAccount.get(sd.account_id) ?? []
      list.push({ id: sd.id, service_type: sd.service_type, status: sd.status, due_date: sd.due_date })
      renewalSDsByAccount.set(sd.account_id, list)
    } else if ((CLOSURE_TYPES as readonly string[]).includes(sd.service_type)) {
      if (sd.status === "active") closureAccounts.add(sd.account_id)
    } else if (sd.service_type === FORMATION_TYPE && sd.status === "active") {
      formationSDByAccount.set(sd.account_id, sd)
    } else if (sd.service_type === FORMATION_TYPE && sd.status === "completed" && !formationSDByAccount.has(sd.account_id)) {
      formationSDByAccount.set(sd.account_id, sd)
    }
  }

  // ── 3. The money gate: live Overdue/Delinquent payments ──────────
  // (payments.is_test excluded — a QA invoice must never hold a real renewal)
  const payments = await fetchAllPages<{
    id: string
    account_id: string | null
    amount: number | string
    amount_currency: string | null
    status: string
    due_date: string | null
  }>((from, to) =>
    supabase
      .from("payments")
      .select("id, account_id, amount, amount_currency, status, due_date")
      .in("status", [...OVERDUE_PAYMENT_STATUSES])
      // NOT (is_test IS TRUE) — .neq would silently drop the NULL majority
      .not("is_test", "is", true)
      .order("id")
      .range(from, to),
  )
  const overdueByAccount = new Map<string, RenewalStatusInput["overduePayments"]>()
  for (const p of payments) {
    if (!p.account_id || !accountIdSet.has(p.account_id)) continue
    const list = overdueByAccount.get(p.account_id) ?? []
    list.push({ id: p.id, amount: p.amount, currency: p.amount_currency, status: p.status, due_date: p.due_date })
    overdueByAccount.set(p.account_id, list)
  }

  // ── 4. Tax-return presence (feeds classifyAccount's legacy-client
  //       detection). Latest row per account. ──────────────────────
  const taxReturns = await fetchAllPages<{
    account_id: string | null
    tax_year: number
    status: string
    extension_filed: boolean | null
    first_year_skip: boolean | null
  }>((from, to) =>
    supabase
      .from("tax_returns")
      .select("account_id, tax_year, status, extension_filed, first_year_skip")
      .order("tax_year", { ascending: false })
      .order("account_id")
      .range(from, to),
  )
  const taxReturnByAccount = new Map<string, (typeof taxReturns)[number]>()
  for (const t of taxReturns) {
    if (!t.account_id || !accountIdSet.has(t.account_id)) continue
    if (!taxReturnByAccount.has(t.account_id)) taxReturnByAccount.set(t.account_id, t)
  }

  // ── 5. Classify + compute per account (pure, in memory) ──────────
  // ss4 is deliberately not loaded: it only distinguishes pending_ein from
  // new_formation, and the engine's verdicts depend on category ONLY for
  // one_time (verified against classifyAccount Step 2 — activeServiceTypes
  // and ss4 never change that branch).
  return accounts.map((a): LoadedRenewalAccount => {
    const formationSD = formationSDByAccount.get(a.id)
    const taxReturn = taxReturnByAccount.get(a.id)
    const classification = classifyAccount({
      accountId: a.id,
      accountType: a.account_type,
      accountStatus: a.status,
      einNumber: a.ein_number,
      formationDate: a.formation_date,
      entityType: a.entity_type,
      activeServiceTypes: (renewalSDsByAccount.get(a.id) ?? [])
        .filter(sd => sd.status === "active")
        .map(sd => sd.service_type),
      formationSD: formationSD
        ? { stage: formationSD.stage, stageOrder: formationSD.stage_order, status: formationSD.status }
        : null,
      taxReturn: taxReturn
        ? {
            taxYear: taxReturn.tax_year,
            extensionFiled: !!taxReturn.extension_filed,
            status: taxReturn.status,
            firstYearSkip: !!taxReturn.first_year_skip,
          }
        : null,
      ss4: null,
      currentYear,
    })
    const status = computeRenewalStatus({
      account: a,
      classification,
      renewalSDs: renewalSDsByAccount.get(a.id) ?? [],
      overduePayments: overdueByAccount.get(a.id) ?? [],
      hasActiveClosure: closureAccounts.has(a.id),
      today,
      upcomingWindowDays: opts.upcomingWindowDays,
    })
    // Intake: a Company Formation SD (any status) proves TD formed the
    // company; otherwise a recorded RA-switch/client-since points to
    // onboarding. Neither → null, and proposals stay manual.
    const intake: LoadedRenewalAccount["intake"] = formationSD
      ? "formation"
      : a.ra_switch_date || a.client_since
        ? "onboarding"
        : null
    return { account: a, status, intake, renewalSDs: renewalSDsByAccount.get(a.id) ?? [] }
  })
}
