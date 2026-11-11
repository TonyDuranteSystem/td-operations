/**
 * Correct a company's renewal date from the Calendar's "renewal details"
 * pop-up (dev job 51324085, Antonio 2026-11-10: "when we click, a pop-up opens
 * with the information in the CRM; if the date is wrong, pick the right one").
 *
 * One call does everything a correction must, so no screen can do half of it:
 *   1. checks the date the staff member SAW is still the stored one (a stale
 *      pop-up never overwrites a newer value) and that the company is not
 *      being closed,
 *   2. checks the REASON is true: "matches the renewal rule" must really be the
 *      rule date; moving a PAST-DUE date forward needs the staff member's
 *      confirmation that the renewal was really done (it makes the overdue flag
 *      disappear, so it must never be a one-click),
 *   3. writes the account's date through `setAccountRenewalDate` (the one
 *      sanctioned writer — it also keeps the client-portal `deadlines` row in
 *      sync and writes the audit line) and then CHECKS the portal deadline,
 *   4. deals with the company's open renewal job: when the new date is more than
 *      30 days away the job was created too early (the nightly cron makes it 30
 *      days before the date), so — if no work has started on it — the job, its
 *      open tasks and its To-Do card are REMOVED and the cron creates them again
 *      at the right time. Otherwise the job just gets the new date.
 *
 * It never files anything, never contacts the client.
 */

import { supabaseAdmin } from "@/lib/supabase-admin"
import { setAccountRenewalDate, type RenewalDateColumn } from "@/lib/operations/renewal-dates"
import { deactivateSD } from "@/lib/operations/service-delivery"
import {
  CORRECTION_REASON_LABEL,
  reasonsFor,
  type CorrectionReason,
} from "@/lib/operations/renewal-correction-reasons"
import {
  validateCorrectedDate,
  isRealIsoDate,
  renewalCheckStart,
  expectedRaRenewalDate,
} from "@/lib/operations/renewal-date-check"

// Registered Agent only: the annual report is another procedure (we file it ourselves) and is not touched here.
const COLUMN: RenewalDateColumn = "ra_renewal_date"
const JOB_TYPE = "State RA Renewal"
const DEADLINE_TYPE = "RA Renewal"
/** The To-Do card the nightly cron makes for a renewal job is keyed `ra_renewal:<job id>`. */
const CARD_PREFIX = "ra_renewal"
const LABEL = "Registered Agent renewal"
const CLOSURE_TYPES = ["Company Closure", "Client Offboarding"]
const TERMINAL_DEADLINE_STATUSES = new Set(["Completed", "Filed", "Cancelled"])
/** The nightly crons create the job and the card this many days before the date. */
export const JOB_WINDOW_DAYS = 30

export interface CorrectRenewalDateInput {
  accountId: string
  /** The date the staff member saw (must still be what is stored). */
  from: string
  /** The date they picked. */
  to: string
  reason: string
  note?: string | null
  /** Required when a past-due date is moved forward: "I checked that this renewal was really done." */
  confirmOverdue?: boolean
  /** Who is doing it, e.g. the signed-in email. */
  actor: string
  /** Injectable for tests; defaults to today (UTC date). */
  today?: string
}

export type CorrectRenewalDateResult =
  | { ok: true; message: string; warnings: string[] }
  | { ok: false; error: string; status: 400 | 404 | 409 | 500 }

/** Plain `YYYY-MM-DD` plus whole days, by string/UTC math (no local-time drift). */
function addDays(iso: string, days: number): string {
  const [y, m, d] = iso.split("-").map(Number)
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10)
}

/** True when moving `from` to `to` hides a past-due date (from is already past, to is today or later). */
export function movesPastDueDateForward(from: string, to: string, today: string): boolean {
  return from < today && to >= today
}

/** Pure input check — returns a plain-words problem or null. (Checks that need the company's record are in correctRenewalDate.) */
export function validateCorrection(
  input: Pick<CorrectRenewalDateInput, "from" | "to" | "reason" | "note" | "confirmOverdue">,
  today: string,
): string | null {
  if (!isRealIsoDate(input.from)) return "The date you saw is not a valid date — refresh the Calendar and try again."
  const dateProblem = validateCorrectedDate(input.to, today)
  if (dateProblem) return dateProblem
  if (input.to === input.from) return "That is the date already stored — pick a different date."
  if (!(reasonsFor() as readonly string[]).includes(input.reason)) return "Say why the date is being changed."

  const note = (input.note ?? "").trim()
  if (input.reason === "other" && !note) return 'Explain the change in the note when the reason is "Other".'
  if (note.length > 500) return "The note is too long (500 characters at most)."
  if (movesPastDueDateForward(input.from, input.to, today)) {
    if (input.reason === "matches_rule") {
      return 'This renewal is past due. The rule date is not proof that it was done — choose "Harbor Compliance shows this date" (or the state website) or "Other".'
    }
    if (input.confirmOverdue !== true) {
      return "This renewal is past due. Moving its date forward makes the overdue flag disappear, so first check in Harbor (or on the state website) that it was really renewed, then tick the confirmation."
    }
  }
  return null
}

export async function correctRenewalDate(input: CorrectRenewalDateInput): Promise<CorrectRenewalDateResult> {
  const today = input.today ?? new Date().toISOString().slice(0, 10)
  const problem = validateCorrection(input, today)
  if (problem) return { ok: false, error: problem, status: 400 }

  const column = COLUMN
  const label = LABEL
  const reason = input.reason as CorrectionReason
  const note = (input.note ?? "").trim()

  const { data: account, error: readErr } = await supabaseAdmin
    .from("accounts")
    .select("id, company_name, state_of_formation, updated_at, ra_renewal_date, client_since, formation_date")
    .eq("id", input.accountId)
    .maybeSingle()
  if (readErr) return { ok: false, error: `Could not read the company: ${readErr.message}`, status: 500 }
  if (!account) return { ok: false, error: "Company not found.", status: 404 }

  const stored = (account as Record<string, unknown>)[column] as string | null
  if (stored !== input.from) {
    return {
      ok: false,
      error: `This date changed while the pop-up was open (the CRM now holds ${stored ?? "no date"}). Refresh the Calendar and look again.`,
      status: 409,
    }
  }

  // "Matches the renewal rule" must be TRUE: the date picked has to be the rule date (Client Since if filled, else Formation).
  if (reason === "matches_rule") {
    const start = renewalCheckStart({ client_since: account.client_since ?? null, formation_date: account.formation_date ?? null })
    const ruleDate = start ? expectedRaRenewalDate(start.date, today) : null
    if (!ruleDate || input.to !== ruleDate) {
      return {
        ok: false,
        error: ruleDate
          ? `${input.to} is not the rule date (${ruleDate}). Choose "Harbor Compliance shows this date" or "Other" for a different date.`
          : "There is no Client Since or Formation date to apply the rule to. Choose \"Harbor Compliance shows this date\" or \"Other\".",
        status: 400,
      }
    }
  }

  // A company that is being closed is not renewed — its dates are left alone.
  const { data: closing, error: closeErr } = await supabaseAdmin
    .from("service_deliveries")
    .select("id")
    .eq("account_id", input.accountId)
    .in("service_type", CLOSURE_TYPES)
    .eq("status", "active")
  if (closeErr) return { ok: false, error: `Could not check whether the company is being closed: ${closeErr.message}`, status: 500 }
  if ((closing ?? []).length > 0) {
    return { ok: false, error: "This company is being closed — its renewal dates are not changed.", status: 409 }
  }

  const summary = `${label} date corrected ${input.from} → ${input.to} (${CORRECTION_REASON_LABEL[reason]})`
  const written = await setAccountRenewalDate(input.accountId, column, input.to, {
    expectedUpdatedAt: account.updated_at,
    actor: input.actor,
    summary,
    details: {
      from: input.from, to: input.to, reason, note: note || null,
      confirmed_past_due: movesPastDueDateForward(input.from, input.to, today) ? true : undefined,
      source: "calendar-renewal-details",
    },
    state: account.state_of_formation,
  })
  if (!written.success) {
    if (written.outcome === "stale") {
      return { ok: false, error: "The company was edited by someone else a moment ago. Refresh the Calendar and try again.", status: 409 }
    }
    return { ok: false, error: written.error ?? "The date could not be saved.", status: written.outcome === "not_found" ? 404 : 500 }
  }

  const warnings: string[] = []
  if (written.mirrorWarning) warnings.push(written.mirrorWarning)

  // The client's portal deadline must now show the new date — checked, not assumed (the writer's own
  // portal-deadline sync swallows its errors).
  if (!written.mirrorWarning) {
    try {
      const { data: dl, error: dlErr } = await supabaseAdmin
        .from("deadlines")
        .select("id, due_date, status")
        .eq("account_id", input.accountId)
        .eq("deadline_type", DEADLINE_TYPE)
      if (dlErr) {
        warnings.push(`The date is saved, but the client's portal deadline could not be checked (${dlErr.message}).`)
      } else {
        const open = (dl ?? []).filter(r => r.status == null || !TERMINAL_DEADLINE_STATUSES.has(r.status))
        if (open.length === 0 || !open.some(r => r.due_date === input.to) || open.some(r => r.due_date !== input.to)) {
          warnings.push(`The date is saved, but the client's portal deadline does not show ${input.to} yet — check the client's Deadlines page.`)
        }
      }
    } catch (e) {
      warnings.push(`The date is saved, but the client's portal deadline could not be checked: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  // The company's open renewal job (if exactly one).
  let message = `${account.company_name}: ${label.toLowerCase()} date changed from ${input.from} to ${input.to}.`
  try {
    const { data: jobs, error: jobErr } = await supabaseAdmin
      .from("service_deliveries")
      .select("id, due_date, stage")
      .eq("account_id", input.accountId)
      .eq("service_type", JOB_TYPE)
      .in("status", ["active", "blocked"])
    if (jobErr) {
      warnings.push(`The date is saved, but the open ${label.toLowerCase()} job could not be read to update it (${jobErr.message}).`)
    } else if ((jobs ?? []).length > 1) {
      warnings.push(`The date is saved, but there are ${(jobs ?? []).length} open ${label.toLowerCase()} jobs for this company — none was changed. Someone needs to look at the duplicates.`)
    } else if ((jobs ?? []).length === 1) {
      const job = jobs![0]
      const outsideWindow = input.to > addDays(today, JOB_WINDOW_DAYS)

      let notStarted = false
      if (outsideWindow) {
        const { data: first } = await supabaseAdmin
          .from("pipeline_stages")
          .select("stage_name")
          .eq("service_type", JOB_TYPE)
          .order("stage_order", { ascending: true })
          .limit(1)
          .maybeSingle()
        // Not started = still on the pipeline's first step (the name differs between environments, so it is read, never hard-coded)
        // or no step recorded at all.
        notStarted = !job.stage || (!!first?.stage_name && job.stage === first.stage_name)
      }

      if (outsideWindow && notStarted) {
        // Created too early for the old date and nobody has started: remove the job, its open tasks and its To-Do card.
        const now = new Date().toISOString()
        const { error: cardErr } = await supabaseAdmin
          .from("message_actions")
          .update({ resolved_at: now })
          .eq("source_ref", `${CARD_PREFIX}:${job.id}`)
          .is("resolved_at", null)
        if (cardErr) warnings.push(`The date is saved, but the To-Do card for the early ${label.toLowerCase()} job could not be removed (${cardErr.message}).`)

        const removed = await deactivateSD({
          delivery_id: job.id,
          actor: input.actor,
          reason: `date corrected ${input.from} → ${input.to}; created too early, it is created again ${JOB_WINDOW_DAYS} days before the new date`,
        })
        if (removed.success || removed.outcome === "already_terminal") {
          message += ` The early renewal job and its To-Do card were removed; they are created again ${JOB_WINDOW_DAYS} days before the new date.`
        } else {
          warnings.push(`The date is saved, but the early ${label.toLowerCase()} job could not be removed (${removed.error ?? removed.outcome}).`)
        }
      } else {
        if (outsideWindow && !notStarted) {
          warnings.push(`The date is saved. Work on this ${label.toLowerCase()} had already started (the job is at "${job.stage ?? "a later step"}"), so the job and its To-Do card were kept.`)
        }
        if (job.due_date !== input.to) {
          const { error: updErr } = await supabaseAdmin
            .from("service_deliveries")
            .update({ due_date: input.to, updated_at: new Date().toISOString() })
            .eq("id", job.id)
          if (updErr) warnings.push(`The date is saved, but the open ${label.toLowerCase()} job still shows ${job.due_date ?? "no date"} (${updErr.message}).`)
        }
      }
    }
  } catch (e) {
    warnings.push(`The date is saved, but the open job could not be updated: ${e instanceof Error ? e.message : String(e)}`)
  }

  return { ok: true, message, warnings }
}
