/**
 * Pure date/update logic for the recurring-invoices cron
 * (app/api/cron/recurring-invoices/route.ts). Kept separate from the route so
 * it can be unit tested directly, same pattern as
 * lib/billing/june-installment-eligibility.ts for the annual-installments cron.
 *
 * ORDERING INVARIANT (AI Architect review, dev job 4a854806): next_run_date
 * must advance ONLY on a successful generation, never on failure — a failed
 * cycle must stay due so the cron retries it tomorrow instead of silently
 * skipping a charge forever. buildTemplateSuccessUpdate and
 * buildTemplateFailureUpdate are the ONLY two places that build the
 * post-cycle update object, and only the success one ever sets
 * next_run_date — enforced by construction, not by a runtime check the route
 * could accidentally bypass.
 */

export type RecurringFrequency = "weekly" | "biweekly" | "monthly" | "quarterly" | "yearly"

/**
 * DAY-based frequencies — plain day-count addition, no clamping ambiguity.
 * MONTH-based frequencies — calendar months, day-of-month clamped (below).
 *
 * ⛔ Two explicit lookup tables, checked with an exhaustive switch below,
 * NOT a ternary chain with an implicit `else`. A ternary chain silently
 * routes any frequency the specific branches don't name into the LAST
 * branch — the exact shape that would make a weekly template advance 12
 * MONTHS instead of 7 days the moment 'weekly' was added as a value without
 * this restructure (senior-engineer review, dev job 4a854806, third pass).
 */
const DAY_FREQUENCIES: Record<string, number> = { weekly: 7, biweekly: 14 }
const MONTH_FREQUENCIES: Record<string, number> = { monthly: 1, quarterly: 3, yearly: 12 }

/** Number of days in a given UTC year/month (0-indexed month, JS Date convention). */
function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate()
}

/** Add N days to a YYYY-MM-DD date (UTC, plain day count — no clamping needed). */
export function addDaysToDate(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().split("T")[0]
}

/**
 * Add N months to a UTC date, clamping the day-of-month to the target
 * month's length. Without clamping, native Date math silently ROLLS OVER
 * (Jan 31 + 1 month -> Mar 3, not Feb 28) — a schedule anchored near
 * month-end would drift a few days every few cycles with no error and no
 * trace. Also correctly handles Feb 29 anchors on a yearly cadence landing
 * in a non-leap year (clamps to Feb 28).
 */
function addMonthsClamped(dateStr: string, months: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`)
  const day = d.getUTCDate()
  const targetYear = d.getUTCFullYear()
  const targetMonth = d.getUTCMonth() + months
  // Date.UTC normalizes an out-of-range month (e.g. 13) into the correct
  // following year, so this is safe for any `months` value.
  const normalized = new Date(Date.UTC(targetYear, targetMonth, 1))
  const clampedDay = Math.min(day, daysInMonth(normalized.getUTCFullYear(), normalized.getUTCMonth()))
  normalized.setUTCDate(clampedDay)
  return normalized.toISOString().split("T")[0]
}

/** Advance a YYYY-MM-DD date by one cycle of the given frequency (month-end / leap-day clamped for month-based cycles). */
export function advanceRecurringDate(dateStr: string, frequency: RecurringFrequency): string {
  if (frequency in DAY_FREQUENCIES) return addDaysToDate(dateStr, DAY_FREQUENCIES[frequency])
  if (frequency in MONTH_FREQUENCIES) return addMonthsClamped(dateStr, MONTH_FREQUENCIES[frequency])
  // Exhaustive by the RecurringFrequency type — this line is unreachable for
  // any value TypeScript allows in. If it ever throws, a new frequency was
  // added to the type/DB CHECK without a matching entry in one of the two
  // tables above.
  throw new Error(`advanceRecurringDate: unhandled frequency "${frequency}"`)
}

/**
 * Fast-forward a stale next_run_date to the next occurrence STRICTLY AFTER
 * `today` — used when re-activating a template that sat off for a while, so
 * flipping it back on doesn't dump a burst of backdated invoices (one per
 * missed cycle) on the very next cron pass. Advances at least once even if
 * next_run_date is already in the future, matching "the next time it would
 * naturally fire," not "today." (Bug-hunter finding, dev job 4a854806, third
 * pass — reactivation was previously unreachable except via raw SQL; the
 * Finance toggle makes it one click.)
 */
export function fastForwardToNextOccurrence(nextRunDate: string, frequency: RecurringFrequency, today: string): string {
  let candidate = advanceRecurringDate(nextRunDate, frequency)
  // Bounded loop: even weekly from a decade-stale date is a few hundred
  // iterations at most, and this only ever runs once, synchronously, on a
  // manual toggle click — not in a hot path.
  while (candidate <= today) {
    candidate = advanceRecurringDate(candidate, frequency)
  }
  return candidate
}

export interface TemplateSuccessUpdate {
  next_run_date: string
  last_generated_payment_id: string
  last_generated_at: string
  last_run_status: "ok"
  last_error: null
  updated_at: string
}

export interface TemplateFailureUpdate {
  last_run_status: "error"
  last_error: string
  updated_at: string
}

/**
 * Build the row update for a SUCCESSFUL generation cycle. The only function
 * in this module that ever sets next_run_date.
 */
export function buildTemplateSuccessUpdate(params: {
  runDate: string
  frequency: RecurringFrequency
  paymentId: string
  now: string
}): TemplateSuccessUpdate {
  return {
    next_run_date: advanceRecurringDate(params.runDate, params.frequency),
    last_generated_payment_id: params.paymentId,
    last_generated_at: params.now,
    last_run_status: "ok",
    last_error: null,
    updated_at: params.now,
  }
}

/**
 * Build the row update for a FAILED generation cycle. Deliberately has no
 * next_run_date field at all — the template stays due for tomorrow's run.
 */
export function buildTemplateFailureUpdate(params: { errorMessage: string; now: string }): TemplateFailureUpdate {
  return {
    last_run_status: "error",
    last_error: params.errorMessage,
    updated_at: params.now,
  }
}
