/**
 * The reasons staff can give when they correct a Registered Agent renewal date
 * from the Calendar. Kept in its own file with NO imports so the browser pop-up
 * can use it without pulling server-only code (the database client) into the
 * page.
 *
 * Registered Agent only: the annual report is another procedure (we file it
 * ourselves) and is not touched by this pop-up (Antonio, 2026-11-10).
 */

export const CORRECTION_REASONS = ["harbor_shows", "matches_rule", "other"] as const
export type CorrectionReason = (typeof CORRECTION_REASONS)[number]

export const CORRECTION_REASON_LABEL: Record<CorrectionReason, string> = {
  harbor_shows: "Harbor Compliance shows this date",
  matches_rule: "Matches the renewal rule (Client Since or Formation)",
  other: "Other (explain in the note)",
}

/** The reasons offered (and accepted) for a Registered Agent renewal date. */
export function reasonsFor(): readonly CorrectionReason[] {
  return CORRECTION_REASONS
}
