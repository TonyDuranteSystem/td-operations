/**
 * Workspace prior-return answers (2026-07-06, Antonio: first-year companies
 * can never produce a prior return — the workspace must know that).
 *
 * The CLIENT wizard already solves this (prior-return-case.ts: first_year
 * cross-checked against accounts.formation_date, never_filed declaration);
 * the staff P&L workspace only ever RECEIVED a snapshot copied at fork time,
 * with no way to set one — gate 2 nagged "complete the prior-return step"
 * forever on blank workspaces and first-year forks.
 *
 * This module builds the SAME PriorReturnCaseRecord shapes the wizard stores,
 * so the verification gates and the engine read both paths identically — no
 * new record kinds, no new readers. Pure; callers load formation_date.
 */

import { firstYearCoherent, type PriorReturnCaseRecord } from "./prior-return-case"

export type WorkspacePriorReturnChoice = "first_year" | "never_filed"

/**
 * Build a staff-set prior-return record for a workspace.
 * first_year is cross-checked against the linked client's formation date —
 * a claim the CRM contradicts is stored as claim_mismatch (same behavior as
 * the wizard), shown to staff, never silently trusted.
 */
export function buildWorkspacePriorReturnRecord(input: {
  choice: WorkspacePriorReturnChoice
  taxYear: number
  /** Linked client's accounts.formation_date; null for blank workspaces. */
  formationDate: string | null
  /** Staff identity, recorded in the note for the audit trail. */
  actor: string
}): PriorReturnCaseRecord {
  const now = new Date().toISOString()
  if (input.choice === "never_filed") {
    return {
      case: "never_filed",
      status: "never_filed",
      cleanup_interest: "No", // the back-filing upsell is a client-wizard rail, not a scratch-tool one
      declaration_accepted: true,
      recorded_at: now,
    }
  }
  const coherent = firstYearCoherent(input.formationDate, input.taxYear)
  if (coherent === false) {
    return {
      case: "first_year",
      status: "claim_mismatch",
      formation_date: input.formationDate,
      note: `Staff (${input.actor}) set ${input.taxYear} as the first year, but the company was formed ${input.formationDate} — verify whether prior returns exist.`,
      recorded_at: now,
    }
  }
  return {
    case: "first_year",
    status: "first_year",
    formation_date: input.formationDate,
    note: coherent === null
      ? `Staff (${input.actor}) set ${input.taxYear} as the first year. No formation date on file — claim not cross-checked.`
      : `Staff (${input.actor}) set ${input.taxYear} as the first year. Formation date confirms it. Beginning balances start at zero.`,
    recorded_at: now,
  }
}

/**
 * Auto-derive first_year at FORK time when the client never answered the
 * wizard's prior-return step: a company formed IN (or after) the filing year
 * cannot have a prior return — don't wait for anyone to say so. Returns null
 * unless the formation date POSITIVELY confirms it (no formation date = no
 * assumption, R093).
 */
export function deriveFirstYearFromFormation(formationDate: string | null, taxYear: number): PriorReturnCaseRecord | null {
  if (firstYearCoherent(formationDate, taxYear) !== true) return null
  return {
    case: "first_year",
    status: "first_year",
    formation_date: formationDate,
    note: `Auto-derived from the CRM formation date (${formationDate}): the company was formed in/after ${taxYear}, so no prior return can exist. Beginning balances start at zero.`,
    recorded_at: new Date().toISOString(),
  }
}

/** The staff control may only replace nothing, a failed record, or another
 *  staff-settable answer — never a validated/quarantined prior-return
 *  EXTRACTION (real carried-forward balances would be silently discarded). */
export function canStaffSetPriorReturn(existing: PriorReturnCaseRecord | null): boolean {
  if (!existing) return true
  if (existing.status === "failed") return true
  return existing.case === "first_year" || existing.case === "never_filed"
}
