/**
 * Renewal-date derivation — single source of truth for the initial
 * ra_renewal_date / annual_report_due_date / cmra_renewal_date fills.
 *
 * Business rules (Antonio, 2026-07):
 *  - RA renewal = anniversary of the RA service start. Formation intake → the
 *    formation date. Onboarding intake → the day TD took over the agent
 *    (ra_switch_date, falling back to client_since — the same start-date
 *    precedence billing uses in lib/billing/june-installment-eligibility.ts).
 *  - Annual report per state: FL May 1, DE Jun 1, WY 1st of the formation
 *    month — all next calendar year; NM has NO annual report. TD files ARs
 *    itself (never via Harbor).
 *  - CMRA renewal = Dec 31 of the current year (the lease term end).
 *
 * Contract:
 *  - FILL-IF-NULL ONLY, and only from company-creation moments (materialize,
 *    Articles Received, first onboarding run, onboarding review). Never from
 *    re-runnable generic paths — service_deactivate deliberately NULLs these
 *    columns to stop the renewal crons, and a blind refill would resurrect a
 *    discontinued service (lib/operations/service-delivery.ts:1015-1037).
 *  - Yearly advancement stays owned by the SD-completion roll-forward
 *    (lib/service-delivery.ts §10-11) / revert / installment handler. This
 *    module never touches a non-null column (DB writes carry .is(col, null)).
 *  - +1yr uses Date.setFullYear like the roll-forward, so Feb 29 overflows to
 *    Mar 1 — both writers share one convention.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"

export type RenewalIntake = "formation" | "onboarding"

export interface RenewalDeriveInput {
  intake: RenewalIntake
  formation_date: string | null
  ra_switch_date?: string | null
  client_since?: string | null
  state_of_formation: string | null
  existing: {
    ra_renewal_date: string | null
    annual_report_due_date: string | null
    cmra_renewal_date: string | null
  }
  /** Injectable for tests; defaults to the current year. */
  currentYear?: number
}

export interface RenewalDateFills {
  ra_renewal_date?: string
  annual_report_due_date?: string
  cmra_renewal_date?: string
}

/** 'New Mexico' → 'NM' etc.; already-short codes pass through uppercased. */
export function normalizeStateCode(state: string | null | undefined): string {
  return (state || "")
    .toUpperCase()
    .trim()
    .replace("NEW MEXICO", "NM")
    .replace("WYOMING", "WY")
    .replace("FLORIDA", "FL")
    .replace("DELAWARE", "DE")
}

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0
}

/** The obligation's anniversary (month/day of the stored date) in the given
 *  year; Feb 29 → Mar 1 in non-leap years (the roll-forward convention).
 *  PURE STRING MATH — `new Date(iso).setFullYear(...)` runs in LOCAL time and
 *  drifts a day for dates inside the DST-transition window (2026-11-07 + 1yr
 *  gave 2027-11-06 on a US-timezone machine; Vercel's UTC masked it). */
export function anniversaryForYear(storedDate: string, year: number): string {
  const [, month, day] = storedDate.split("-")
  if (month === "02" && day === "29" && !isLeapYear(year)) return `${year}-03-01`
  return `${year}-${month}-${day}`
}

/** +1 year, Feb 29 → Mar 1 — matches the SD-completion roll-forward. */
export function plusOneYear(isoDate: string): string {
  return anniversaryForYear(isoDate, parseInt(isoDate.slice(0, 4), 10) + 1)
}

export interface RollForwardDecision {
  action: "roll" | "already_current"
  /** The date the record should hold after this filing. */
  next: string
}

/**
 * Filed-year semantics for the SD-completion roll (plan 89c951a7, replaces
 * the blind stored+1yr): a filing FOR year N moves the record to the
 * anniversary in year N+1. A record already at/past that date is
 * "already_current" — completing an old SD twice, or completing after the
 * record was repaired, must NEVER move the date backwards or double-roll.
 * A record MORE than a year behind stays behind after one filing (each owed
 * year needs its own filing) — the calendar's overdue flag reports the rest.
 */
export function computeRollForward(storedDate: string, filingForYear: number): RollForwardDecision {
  const next = anniversaryForYear(storedDate, filingForYear + 1)
  if (next <= storedDate) return { action: "already_current", next: storedDate }
  return { action: "roll", next }
}

/** Pure derivation. Returns ONLY the columns that are null and derivable. */
export function deriveRenewalDates(input: RenewalDeriveInput): RenewalDateFills {
  const fills: RenewalDateFills = {}
  const year = input.currentYear ?? new Date().getFullYear()
  const state = normalizeStateCode(input.state_of_formation)

  // RA renewal — anniversary of the RA start, per-intake start date. Never a
  // blended coalesce: a formation account can carry client_since (bulk edits,
  // workflow chains) and must still derive from formation_date.
  if (input.existing.ra_renewal_date == null) {
    const start =
      input.intake === "formation"
        ? input.formation_date
        : input.ra_switch_date || input.client_since || null
    if (start) fills.ra_renewal_date = plusOneYear(start)
  }

  // Annual report — state rule; NM never has one.
  if (input.existing.annual_report_due_date == null) {
    if (state === "FL") fills.annual_report_due_date = `${year + 1}-05-01`
    else if (state === "DE") fills.annual_report_due_date = `${year + 1}-06-01`
    else if (state === "WY" && input.formation_date) {
      const month = String(input.formation_date).slice(5, 7)
      fills.annual_report_due_date = `${year + 1}-${month}-01`
    }
  }

  // CMRA — lease term end, Dec 31 current year.
  if (input.existing.cmra_renewal_date == null) {
    fills.cmra_renewal_date = `${year}-12-31`
  }

  return fills
}

/**
 * Apply fills to the account with a per-column `.is(col, null)` guard
 * (TOCTOU-safe: a concurrent fill or a deliberate clear wins over us), then
 * mirror RA/AR dates into the `deadlines` table — the client portal's
 * Deadlines page and the dashboard cards read that table, so leaving it
 * stale would show clients a different truth than the calendar.
 */
export async function applyRenewalDateFills(
  accountId: string,
  fills: RenewalDateFills,
  opts?: { state?: string | null; actor?: string },
): Promise<string[]> {
  const applied: string[] = []

  for (const [column, value] of Object.entries(fills)) {
    if (!value) continue
    // eslint-disable-next-line no-restricted-syntax -- renewal-date fill; single writer for initial dates (plan c2d97552)
    const { data, error } = await supabaseAdmin
      .from("accounts")
      .update({ [column]: value, updated_at: new Date().toISOString() })
      .eq("id", accountId)
      .is(column, null)
      .select("id")
    if (!error && data?.length) applied.push(`${column}=${value}`)
  }

  // Mirror rows for the portal/dashboard readers (best-effort; date fills above
  // are the source of truth and must not fail on a mirror error).
  try {
    const mirrors: Array<{ type: "RA Renewal" | "Annual Report"; due: string | undefined }> = [
      { type: "RA Renewal", due: applied.some(a => a.startsWith("ra_renewal_date")) ? fills.ra_renewal_date : undefined },
      { type: "Annual Report", due: applied.some(a => a.startsWith("annual_report_due_date")) ? fills.annual_report_due_date : undefined },
    ]
    for (const m of mirrors) {
      if (!m.due) continue
      await mirrorDeadlineDate(accountId, m.type, m.due, {
        state: opts?.state,
        note: `Auto-derived at intake (${opts?.actor || "renewal-dates"})`,
      })
    }
  } catch {
    // mirror is best-effort by design
  }

  return applied
}

/**
 * Keep ONE `deadlines` row in sync with an account renewal date — the client
 * portal's Deadlines page and the dashboard cards read that table, so a date
 * repair that skips the mirror shows clients a different truth than the
 * calendar. Shared by the intake fills above and the calendar's one-click
 * record repairs.
 *
 * Matching rule: the current OPEN row for this obligation — same year OR the
 * year-NULL legacy import rows (the majority of the table — file-renewal
 * carries the same fallback). Completed rows are history — never updated;
 * a completed prior cycle correctly gets a NEW row for the new cycle.
 * limit(1) tolerates duplicate rows instead of erroring into an insert.
 */
export async function mirrorDeadlineDate(
  accountId: string,
  deadlineType: "RA Renewal" | "Annual Report",
  due: string,
  opts?: { state?: string | null; note?: string; matchYear?: number; includeNullYear?: boolean },
): Promise<void> {
  const year = new Date(due).getFullYear()
  const lookupYear = opts?.matchYear ?? year
  // includeNullYear=false: only exact-year rows match — used by the roll
  // forward's "ensure a NEW cycle row exists" so it can never steal the OLD
  // cycle's year-NULL legacy row out from under file-renewal's completion.
  const yearFilter = (opts?.includeNullYear ?? true)
    ? `year.eq.${lookupYear},year.is.null`
    : `year.eq.${lookupYear}`
  const { data: existingRows } = await supabaseAdmin
    .from("deadlines")
    .select("id, due_date")
    .eq("account_id", accountId)
    .eq("deadline_type", deadlineType)
    .neq("status", "Completed")
    .or(yearFilter)
    .order("due_date", { ascending: false })
    .limit(1)
  const existing = existingRows?.[0] ?? null
  if (existing) {
    if (existing.due_date !== due) {
      await supabaseAdmin
        .from("deadlines")
        .update({ due_date: due, year, updated_at: new Date().toISOString() })
        .eq("id", existing.id)
    }
  } else {
    await supabaseAdmin.from("deadlines").insert({
      account_id: accountId,
      deadline_type: deadlineType,
      due_date: due,
      status: "Pending",
      state: opts?.state || null,
      year,
      assigned_to: "Luca",
      notes: opts?.note || null,
    })
  }
}
