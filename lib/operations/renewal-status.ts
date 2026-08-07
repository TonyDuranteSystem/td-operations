/**
 * Renewal Status Engine — THE single source of truth for "what is the real
 * state of this company's RA renewal / annual report" (plan 89c951a7,
 * council-hardened design v2, Antonio's rulings 2026-08-06).
 *
 * Design contract (each rule traces to a council finding or an Antonio ruling):
 *  - DATE-PRIMARY: accounts.ra_renewal_date / annual_report_due_date ARE the
 *    record of renewal (counselor: only ~39% of renewals have completed-SD
 *    history; pre-2026-03 cycles have none). Completed SDs corroborate the
 *    CURRENT cycle only.
 *  - COMPOSES classifyAccount — this module answers "what state is the
 *    obligation in"; classifyAccount answers "should this account have the
 *    obligation at all" (architect blocker #3: no second classifier).
 *  - MONEY GATE = SOP v7.1 as implemented: ANY Overdue/Delinquent payment on
 *    the account holds a due renewal (Antonio ruling (a): hold is automatic
 *    and VISIBLE; unlocking is a human action). Computed LIVE from payment
 *    rows — never from a stored SD 'blocked' stamp (SE major: stale both ways).
 *  - PRECEDENCE (total order, SE blocker): not_applicable > renewed >
 *    on_hold_unpaid > overdue > upcoming > missing_data.
 *  - Every non-green status carries a plain-English CAUSE + the EVIDENCE rows
 *    it relied on (Antonio ruling (d)/(e): report the WHY, never a bare flag).
 *  - Pure function, `today` injectable — exhaustively unit-tested.
 */

import { normalizeStateCode, anniversaryForYear } from "@/lib/operations/renewal-dates"
import type { AccountClassification } from "@/lib/account-classification"

// ── Input ────────────────────────────────────────────────────────

export interface RenewalStatusInput {
  account: {
    id: string
    company_name: string
    account_type: string | null       // 'Client' | 'One-Time' | ...
    status: string | null             // 'Active' | 'Suspended' | ...
    state_of_formation: string | null
    formation_date: string | null
    ra_renewal_date: string | null
    annual_report_due_date: string | null
    is_test?: boolean | null
    is_internal?: boolean | null
  }
  classification: Pick<AccountClassification, "category">
  /** Renewal-type SDs for this account (both obligations, any status). */
  renewalSDs: Array<{
    id: string
    service_type: string              // 'State RA Renewal' | 'State Annual Report'
    status: string                    // 'active' | 'blocked' | 'completed' | 'cancelled'
    due_date: string | null
  }>
  /** Overdue/Delinquent payment rows on the account (the money gate). */
  overduePayments: Array<{
    id: string
    amount: number | string
    currency: string | null
    status: string
    due_date: string | null
  }>
  /** Active closure-flow SD present (Company Closure / Client Offboarding). */
  hasActiveClosure: boolean
  /** Injectable for tests: 'YYYY-MM-DD'. */
  today: string
  /** Days ahead treated as "upcoming" (matches the reminder cron window). */
  upcomingWindowDays?: number
}

// ── Output ───────────────────────────────────────────────────────

export type ObligationStatus =
  | "renewed"          // cycle date in the future beyond the upcoming window
  | "upcoming"         // due within the window, payments clean
  | "on_hold_unpaid"   // due/overdue AND unpaid invoice — renewal withheld (SOP v7.1)
  | "overdue"          // date in the past, no hold — real compliance risk
  | "missing_data"     // date NULL and the obligation applies — problem row
  | "not_applicable"   // NM annual report / discontinued / one-time

export type ObligationKind = "ra_renewal" | "annual_report"

export interface ObligationVerdict {
  obligation: ObligationKind
  status: ObligationStatus
  date: string | null
  /** Plain-English reason — ALWAYS present for non-renewed states. */
  cause: string
  /** The rows this verdict relied on (payment ids, SD ids) — shown on the card. */
  evidence: {
    paymentIds: string[]
    sdIds: string[]
    completedSdForCurrentCycle: boolean
  }
}

export interface CompanyRenewalStatus {
  accountId: string
  companyName: string
  /** One-Time / test / internal are excluded from the calendar roster entirely
   *  (Antonio ruling (b)); still computed for replay coverage. */
  onCalendar: boolean
  /** Active closure flow: stays visible, labelled, until closure completes
   *  (Antonio ruling (c)). */
  closing: boolean
  ra: ObligationVerdict
  annualReport: ObligationVerdict
}

const RA_TYPE = "State RA Renewal"
const AR_TYPE = "State Annual Report"
const NO_AR_STATES = new Set(["NM"])
const DEFAULT_UPCOMING_DAYS = 30

// ── Helpers ──────────────────────────────────────────────────────

function addDays(iso: string, days: number): string {
  // UTC math — local-time setDate drifts a day across DST transitions on
  // non-UTC machines (same bug class as the fixed setFullYear drift).
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().split("T")[0]
}

/** Completed SD corroborating the CURRENT cycle: due AFTER the previous
 *  anniversary and at/before the cycle date. The previous anniversary itself
 *  is STRICTLY excluded — last year's filing (whose SD carries exactly that
 *  due date, the shape the cron writes) must never "corroborate" this year's
 *  missed filing, or the safe one-click roll would retire a real unfiled
 *  renewal (bug-hunter blocker, 2026-08-06). Date-primary; SDs are
 *  corroboration only — counselor blocker #2. */
function hasCompletedSdForCycle(
  sds: RenewalStatusInput["renewalSDs"],
  type: string,
  cycleDate: string | null,
): { yes: boolean; ids: string[] } {
  if (!cycleDate) return { yes: false, ids: [] }
  const cycleYear = parseInt(cycleDate.slice(0, 4), 10)
  const prevAnniversary = anniversaryForYear(cycleDate, cycleYear - 1)
  const ids = sds
    .filter(s => s.service_type === type && s.status === "completed" && s.due_date
      && s.due_date <= cycleDate && s.due_date > prevAnniversary)
    .map(s => s.id)
  return { yes: ids.length > 0, ids }
}

function money(p: RenewalStatusInput["overduePayments"][number]): string {
  const n = Number(p.amount)
  const shown = Number.isFinite(n) ? (n % 1 === 0 ? String(n) : n.toFixed(2)) : String(p.amount)
  return `${p.currency || "USD"} ${shown}${p.due_date ? ` (due ${p.due_date})` : ""}`
}

// ── Engine ───────────────────────────────────────────────────────

export function computeRenewalStatus(input: RenewalStatusInput): CompanyRenewalStatus {
  const a = input.account
  const window = input.upcomingWindowDays ?? DEFAULT_UPCOMING_DAYS
  const windowEnd = addDays(input.today, window)
  const state = normalizeStateCode(a.state_of_formation)
  const isOneTime = input.classification.category === "one_time" || a.account_type === "One-Time"
  const excluded = isOneTime || !!a.is_test || !!a.is_internal

  const verdict = (kind: ObligationKind): ObligationVerdict => {
    const type = kind === "ra_renewal" ? RA_TYPE : AR_TYPE
    const date = kind === "ra_renewal" ? a.ra_renewal_date : a.annual_report_due_date
    const label = kind === "ra_renewal" ? "Registered Agent renewal" : "Annual report"
    const sdsOfType = input.renewalSDs.filter(s => s.service_type === type)
    // A recorded discontinuation only counts while NO live SD of the type
    // exists — a churn-and-return client's old cancelled SD must not silence
    // the re-engaged service forever (bug-hunter minor #8).
    const cancelled =
      sdsOfType.some(s => s.status === "cancelled") &&
      !sdsOfType.some(s => s.status === "active" || s.status === "blocked")
    const corroboration = hasCompletedSdForCycle(input.renewalSDs, type, date)
    const base = {
      obligation: kind,
      date,
      evidence: {
        paymentIds: [] as string[],
        sdIds: corroboration.ids,
        completedSdForCurrentCycle: corroboration.yes,
      },
    }

    // 1. not_applicable — highest precedence.
    if (isOneTime) {
      return { ...base, status: "not_applicable", cause: "One-time customer — no yearly compliance services (not listed on the calendar)." }
    }
    if (kind === "annual_report" && NO_AR_STATES.has(state)) {
      return { ...base, status: "not_applicable", cause: "New Mexico LLCs file no annual report." }
    }
    if (kind === "annual_report" && !state) {
      // Unknown state must be an explicit outcome, never a silent default (counselor).
      return { ...base, status: "missing_data", cause: "State of formation is not recorded — cannot determine the annual-report rule. Fix the state on the account." }
    }
    if (date == null && cancelled) {
      return { ...base, status: "not_applicable", cause: `${label} service was discontinued for this company (recorded cancellation).` }
    }

    // 2. missing_data — date NULL and the obligation applies.
    if (date == null) {
      return { ...base, status: "missing_data", cause: `No ${label.toLowerCase()} date on the account — this company is invisible to reminders until it is set.` }
    }

    // 3. renewed — date safely in the future.
    if (date > windowEnd) {
      return { ...base, status: "renewed", cause: `Next ${label.toLowerCase()} due ${date}.` }
    }

    // 4a. Past date WITH a completed renewal for the cycle = pure RECORD
    //     staleness — nothing is being withheld, so the money gate must not
    //     convert a proven-already-filed repair into an "on hold" card
    //     (bug-hunter major #4). The record repair stays a safe one-click.
    if (date < input.today && corroboration.yes) {
      return {
        ...base,
        status: "overdue",
        cause: `${label} date ${date} is in the past but a completed renewal exists for this cycle — the record was never rolled forward. Fix the record (no client work needed).`,
      }
    }

    // 4b. Due (within window) or past → money gate (SOP v7.1: hold is
    //     automatic and shown; unlocking is a human decision — Antonio (a)).
    if (input.overduePayments.length > 0) {
      const ids = input.overduePayments.map(p => p.id)
      const detail = input.overduePayments.map(money).join(", ")
      return {
        ...base,
        evidence: { ...base.evidence, paymentIds: ids },
        status: "on_hold_unpaid",
        cause: `${label} is ${date < input.today ? "overdue" : `due ${date}`} but ON HOLD — unpaid invoice${input.overduePayments.length > 1 ? "s" : ""}: ${detail}. Unlock or settle to proceed.`,
      }
    }

    // 5. overdue vs upcoming (corroborated-past already returned at 4a).
    if (date < input.today) {
      return {
        ...base,
        status: "overdue",
        cause: `${label} was due ${date} and no completed renewal is recorded — verify whether it was actually done.`,
      }
    }
    return { ...base, status: "upcoming", cause: `${label} due ${date} — within the ${window}-day window.` }
  }

  return {
    accountId: a.id,
    companyName: a.company_name,
    onCalendar: !excluded && a.status === "Active",
    closing: input.hasActiveClosure,
    ra: verdict("ra_renewal"),
    annualReport: verdict("annual_report"),
  }
}
