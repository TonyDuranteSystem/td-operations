/**
 * Envelope expiry — the window, and how it reads on screen.
 *
 * The window was 14 days and was shown NOWHERE in the tool: staff had no way to
 * know a document was about to lapse, and found out only when a client couldn't
 * sign. Antonio set it to 30 days on 2026-07-31.
 *
 * Changing this constant only affects NEWLY created documents — anything
 * already in flight keeps the deadline it was stamped with at creation.
 */
export const DEFAULT_EXPIRY_DAYS = 30

/** Warn this far out, so there is time to chase before the document lapses. */
export const EXPIRY_WARNING_DAYS = 3

export type ExpiryTone = "none" | "normal" | "warning" | "past"

export interface ExpiryDisplay {
  tone: ExpiryTone
  /** Short label for a table cell, e.g. "in 6 days" / "today" / "lapsed". */
  short: string
  /** Fuller label, e.g. "Expires 14 Aug 2026 (in 6 days)". */
  full: string
  daysLeft: number | null
}

/**
 * Describe a deadline for the UI.
 *
 * Deliberately worded as a scheduled deadline rather than a hard cut-off: the
 * status flip is done by a job that runs every 6 hours and the signing routes
 * gate on status, so a document reading "expires today" genuinely still accepts
 * a signature for a few more hours. Overstating that would make staff tell a
 * client the door is shut when it isn't.
 *
 * `expires_at` is nullable in the database, so a missing deadline is a normal
 * case, not an error — it renders as nothing at all.
 */
export function describeExpiry(
  expiresAt: string | Date | null | undefined,
  now: Date = new Date(),
): ExpiryDisplay {
  if (!expiresAt) return { tone: "none", short: "—", full: "No expiry date", daysLeft: null }

  const when = new Date(expiresAt)
  if (Number.isNaN(when.getTime())) {
    return { tone: "none", short: "—", full: "No expiry date", daysLeft: null }
  }

  const date = when.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })
  const msLeft = when.getTime() - now.getTime()
  const daysLeft = Math.ceil(msLeft / 86400000)

  if (msLeft <= 0) {
    return { tone: "past", short: "lapsed", full: `Deadline passed ${date}`, daysLeft }
  }
  const relative = daysLeft <= 1 ? "today" : `in ${daysLeft} days`
  return {
    tone: daysLeft <= EXPIRY_WARNING_DAYS ? "warning" : "normal",
    short: relative,
    full: `Expires ${date} (${relative})`,
    daysLeft,
  }
}
