/**
 * Pure decision rules behind the wizard-reminder cron, extracted so they can be
 * unit-tested without a database. The cron itself only supplies the rows.
 *
 * These decide whether a client keeps being chased to complete a form, so a
 * wrong answer here is either a client nagged for months about finished work
 * (what happened up to 2026-07-23) or a client never reminded at all.
 */

/**
 * Formation is done when EVERY company linked to the client already has a
 * formation date.
 *
 * "Every", not "any", is load-bearing. A client forming a SECOND company has one
 * account with a date and one without; "any" would silence the reminder for the
 * new company they genuinely still need to complete. Verified on production:
 * one client has two submitted formation wizards, so this is a real case.
 *
 * No linked accounts at all → NOT done. We cannot prove the work is finished,
 * so we keep reminding rather than silently dropping a real client.
 */
export function isFormationDoneForAccounts(
  accounts: { formation_date?: string | null }[],
): boolean {
  if (accounts.length === 0) return false
  return accounts.every(a => !!a.formation_date)
}

/**
 * Should this reminder be suppressed — either because one went out recently, or
 * because we have already sent it enough times?
 *
 * The cap exists because there was none: a "7-day" reminder re-fired every 2-3
 * days indefinitely, reaching 22 sends for a single form. Stopping is safe —
 * the 7-day branch opens a staff task, so a stuck client is still followed up
 * by a human rather than by an endless drip.
 */
export function shouldSuppressReminder(opts: {
  msSinceLastSameReminder: number | null
  timesAlreadySent: number
  repeatAfterMs: number
  maxRepeats: number
}): boolean {
  const { msSinceLastSameReminder, timesAlreadySent, repeatAfterMs, maxRepeats } = opts
  if (timesAlreadySent >= maxRepeats) return true
  if (msSinceLastSameReminder !== null && msSinceLastSameReminder < repeatAfterMs) return true
  return false
}
