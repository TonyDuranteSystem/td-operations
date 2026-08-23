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
import { updateAccount } from "@/lib/operations/account"

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

/**
 * Which cycle year a renewal completion is FOR (council blocker, 2026-08-06):
 * explicit caller value (Mark Filed dialog) → the SD's own due-date year
 * (the cron stamps due_date with the account date, so completing that SD is
 * filing FOR that cycle) → the completion year only as a last resort.
 * "Today's year" alone over-rolled a December cycle completed in January by
 * a full year, and absorbed owed years when completing a stale cron SD.
 */
export function resolveFilingForYear(
  explicit: number | undefined,
  sdDueDate: string | null | undefined,
  fallbackYear: number,
): number {
  if (explicit != null) return explicit
  if (sdDueDate) {
    const y = parseInt(String(sdDueDate).slice(0, 4), 10)
    if (!Number.isNaN(y)) return y
  }
  return fallbackYear
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
  const year = parseInt(due.slice(0, 4), 10) // string math — never local-time Date parsing
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
    // Completed AND Filed rows are history — repurposing a Filed row to a
    // new cycle kept its Filed status + old receipt on the client portal
    // (senior-engineer major, council 2026-08-06). A new cycle gets a
    // fresh Pending row instead.
    .not("status", "in", '("Completed","Filed")')
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

// ─────────────────────────────────────────────────────────────────────────
// setAccountRenewalDate — the ONE writer for accounts.ra_renewal_date /
// accounts.annual_report_due_date (dev job 8bd0e51a, 3-round council review,
// 2026-08-23).
//
// mirrorDeadlineDate above is year-SCOPED — correct for the calendar's own
// roll-forward/Mark Filed flow, which always knows which cycle it's filing
// FOR. Every OTHER writer of these two account columns (an account-page
// correction, an MCP update, deactivating or reverting a renewal service)
// is not filing a cycle — it's just correcting or clearing the client's
// stored date — and needs a year-AGNOSTIC match: "the one open deadlines
// row for this obligation, whatever year it's stamped", so a date moved
// across a year boundary corrects that SAME row instead of forking a
// second one (council round 1 blocker).
// ─────────────────────────────────────────────────────────────────────────

export type RenewalDateColumn = "ra_renewal_date" | "annual_report_due_date"

const DEADLINE_TYPE_FOR_COLUMN: Record<RenewalDateColumn, "RA Renewal" | "Annual Report"> = {
  ra_renewal_date: "RA Renewal",
  annual_report_due_date: "Annual Report",
}

export interface SetAccountRenewalDateResult {
  success: boolean
  outcome: "updated" | "stale" | "not_found" | "error"
  error?: string
  /** Set when the deadlines-table mirror could NOT be safely auto-corrected
   *  because more than one open row exists for this obligation — the account
   *  column write above still succeeded; this needs a human to pick the
   *  right row instead of the write silently guessing (council round 3,
   *  bug-hunter major — the anomaly was previously logged only, invisible
   *  at the screen the person editing was actually looking at). */
  mirrorWarning?: string
}

/**
 * The single sanctioned writer for accounts.ra_renewal_date /
 * accounts.annual_report_due_date. Writes the account column (through
 * updateAccount — optimistic lock + action_log summary/details preserved
 * exactly as before) then keeps the ONE open `deadlines` row in sync, so the
 * client portal and the renewal-creation cron never disagree with what
 * staff just set. Every caller of these two columns (account-page edit,
 * crm_update_record, deactivateSD, revertServiceDelivery) must route
 * through here — enforced by a lint rule outside lib/operations/**.
 *
 * Deadlines-side matching excludes Cancelled (alongside Completed/Filed):
 * a Cancelled row is never "revived" by a fresh date write — reviving
 * conflated "the date got corrected" with "deliberately un-cancel this",
 * risking a resurrected record with stale leftover fields (council round 2).
 * A cycle correction after a Cancelled row always inserts a fresh row
 * instead. The OLD Cancelled row is left in place as history — the client
 * portal is responsible for not showing it as live (see the Deadlines page
 * query, which excludes Cancelled) rather than this function trying to
 * guess whether it's now safe to delete.
 *
 * A currently-Blocked row (a real, active status staff set for reasons
 * unrelated to this sync — e.g. waiting on the client, or a filing paused
 * for an unpaid invoice) IS matched and gets its date corrected; its status
 * is left untouched. Refusing to touch it would leave the wrong date on an
 * obligation that's still genuinely open (council round 3).
 */
export async function setAccountRenewalDate(
  accountId: string,
  column: RenewalDateColumn,
  value: string | null,
  opts?: {
    expectedUpdatedAt?: string
    actor?: string
    summary?: string
    details?: Record<string, unknown>
    state?: string | null
  },
): Promise<SetAccountRenewalDateResult> {
  const acctResult = await updateAccount({
    id: accountId,
    patch: { [column]: value },
    expected_updated_at: opts?.expectedUpdatedAt,
    actor: opts?.actor,
    summary: opts?.summary,
    details: opts?.details,
  })
  if (!acctResult.success) {
    return { success: false, outcome: acctResult.outcome, error: acctResult.error }
  }

  // The deadlines mirror is best-effort: the account column above is the
  // source of truth for this obligation and must not fail because the
  // mirror step threw.
  let mirrorWarning: string | undefined
  try {
    mirrorWarning = await syncDeadlineRowForRenewalDate(
      accountId,
      DEADLINE_TYPE_FOR_COLUMN[column],
      value,
      opts?.state,
    )
  } catch {
    // best-effort by design
  }

  return { success: true, outcome: "updated", mirrorWarning }
}

/** Year-agnostic single-writer mirror for setAccountRenewalDate. Returns a
 *  human-readable warning string when more than one open row was found
 *  (never guesses which one to touch), else undefined. */
async function syncDeadlineRowForRenewalDate(
  accountId: string,
  deadlineType: "RA Renewal" | "Annual Report",
  value: string | null,
  state?: string | null,
): Promise<string | undefined> {
  const { data: openRows } = await supabaseAdmin
    .from("deadlines")
    .select("id, due_date, status")
    .eq("account_id", accountId)
    .eq("deadline_type", deadlineType)
    .not("status", "in", '("Completed","Filed","Cancelled")')

  const rows = openRows ?? []

  if (rows.length > 1) {
    const warning = `${deadlineType}: found ${rows.length} open records for this account — could not auto-correct the client-facing date. Needs manual review (dedupe the deadlines rows).`
    await supabaseAdmin.from("action_log").insert({
      actor: "renewal-dates:setAccountRenewalDate",
      action_type: "update",
      table_name: "deadlines",
      account_id: accountId,
      summary: warning,
      details: { deadline_type: deadlineType, row_ids: rows.map((r) => r.id), attempted_value: value },
    })
    return warning
  }

  const existing = rows[0] ?? null

  if (value == null) {
    // Clearing the account date (e.g. deactivating the service) — close out
    // the one open record, if any. Never inserts on a clear.
    if (existing) {
      await supabaseAdmin
        .from("deadlines")
        .update({ status: "Cancelled", updated_at: new Date().toISOString() })
        .eq("id", existing.id)
    }
    return undefined
  }

  const year = parseInt(value.slice(0, 4), 10)
  if (existing) {
    if (existing.due_date !== value) {
      await supabaseAdmin
        .from("deadlines")
        .update({ due_date: value, year, updated_at: new Date().toISOString() })
        .eq("id", existing.id)
    }
    return undefined
  }

  await supabaseAdmin.from("deadlines").insert({
    account_id: accountId,
    deadline_type: deadlineType,
    due_date: value,
    status: "Pending",
    state: state || null,
    year,
    assigned_to: "Luca",
  })
  return undefined
}

// ─────────────────────────────────────────────────────────────────────────
// checkDeadlineDirectWrite — guard shared by crm_update_record and
// deadline_update (MCP tools) for direct edits to a `deadlines` row.
// ─────────────────────────────────────────────────────────────────────────

const RENEWAL_DEADLINE_TYPES = new Set(["RA Renewal", "Annual Report"])
// Only these two transitions are blocked directly — NOT every status change.
// Filed/Completed normally only happen through the calendar's Mark Filed
// action, which also rolls the account's date forward for the next cycle;
// bypassing it here would leave that roll-forward undone. Cancelled,
// Blocked, Pending, Overdue, and every other field (notes, blocked_reason,
// filed_date, confirmation_number, assigned_to) stay directly writable —
// Cancelled deliberately so, since it's the only way to resolve a genuine
// duplicate-row anomaly this same design can surface (council round 3,
// bug-hunter blocker: a blanket status refusal would have removed the one
// tool that fixes the exact problem it's meant to catch).
const TERMINAL_STATUSES_REQUIRING_ROLL_FORWARD = new Set(["Filed", "Completed"])

export interface DeadlineDirectWriteCheck {
  allowed: boolean
  reason?: string
}

/**
 * Guards a direct edit to a `deadlines` row typed RA Renewal / Annual
 * Report — these rows are mirrored FROM the account's own renewal-date
 * column via setAccountRenewalDate, and the account column is what the
 * renewal-creation cron reads. A direct due_date edit here would leave the
 * account stale (the exact bug this project exists to fix); a direct flip
 * to Filed/Completed skips the roll-forward that mirrorDeadlineDate/
 * fileRenewal perform, so the account's date never advances for the next
 * cycle either. Everything else on this row is unaffected and stays
 * directly writable.
 */
export function checkDeadlineDirectWrite(
  deadlineType: string | null | undefined,
  updates: Record<string, unknown>,
): DeadlineDirectWriteCheck {
  if (!deadlineType || !RENEWAL_DEADLINE_TYPES.has(deadlineType)) return { allowed: true }

  if (Object.prototype.hasOwnProperty.call(updates, "due_date")) {
    return {
      allowed: false,
      reason: `Direct due_date edits on a ${deadlineType} record are blocked — correct the account's own renewal-date field instead, which keeps this record and the renewal-tracking automation in sync.`,
    }
  }
  if (
    Object.prototype.hasOwnProperty.call(updates, "status") &&
    TERMINAL_STATUSES_REQUIRING_ROLL_FORWARD.has(String(updates.status))
  ) {
    return {
      allowed: false,
      reason: `Directly setting a ${deadlineType} record to "${String(updates.status)}" is blocked — use the calendar's "Mark Filed" action instead, which also advances the account's renewal date for the next cycle.`,
    }
  }
  return { allowed: true }
}
