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

/** +1 year via setFullYear — matches the SD-completion roll-forward (Feb 29 → Mar 1). */
export function plusOneYear(isoDate: string): string {
  const d = new Date(isoDate)
  d.setFullYear(d.getFullYear() + 1)
  return d.toISOString().split("T")[0]
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
      const year = new Date(m.due).getFullYear()
      const { data: existing } = await supabaseAdmin
        .from("deadlines")
        .select("id, due_date")
        .eq("account_id", accountId)
        .eq("deadline_type", m.type)
        .eq("year", year)
        .maybeSingle()
      if (existing) {
        if (existing.due_date !== m.due) {
          await supabaseAdmin
            .from("deadlines")
            .update({ due_date: m.due, updated_at: new Date().toISOString() })
            .eq("id", existing.id)
        }
      } else {
        await supabaseAdmin.from("deadlines").insert({
          account_id: accountId,
          deadline_type: m.type,
          due_date: m.due,
          status: "Pending",
          state: opts?.state || null,
          year,
          assigned_to: "Luca",
          notes: `Auto-derived at intake (${opts?.actor || "renewal-dates"})`,
        })
      }
    }
  } catch {
    // mirror is best-effort by design
  }

  return applied
}
