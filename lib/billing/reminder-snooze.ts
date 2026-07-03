/**
 * Client-level payment-reminder pause — "client promised to pay by <date>".
 *
 * Backed by `accounts.dunning_pause_until` (+ free-text
 * `accounts.dunning_pause_reason` for the trace), added 2026-07-03. Sits next
 * to the older boolean `accounts.dunning_pause` (indefinite pause) — the dated
 * pause is the preferred tool because it expires by itself, so nobody has to
 * remember to un-pause (the failure mode that motivated this feature: staff
 * reminded a client who had already promised payment).
 *
 * Semantics (decided with Antonio, 2026-07-03):
 *   - While the date is today-or-future, the client's invoices get NO payment
 *     reminders from the dunning cron or the bulk action; the manual
 *     single-send warns and requires an explicit force.
 *   - The pause NEVER suppresses Overdue marking or overdue badges — the debt
 *     stays visible everywhere; only the nagging pauses.
 *   - After the date passes, reminders resume automatically (no un-pause step).
 *
 * Enforced at the single send choke point (lib/billing/invoice-reminder.ts) so
 * jobs enqueued BEFORE a pause was set are still skipped at send time.
 */

/**
 * True when `pauseUntil` (a `YYYY-MM-DD` date string) is today or in the
 * future relative to `now`. Null/empty/invalid values are never paused.
 * Date-only comparison in the server's local calendar day — same convention as
 * the dunning pass's `daysOverdue` math.
 */
export function isReminderPaused(
  pauseUntil: string | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!pauseUntil) return false
  const until = new Date(`${pauseUntil.slice(0, 10)}T23:59:59.999`)
  if (isNaN(until.getTime())) return false
  return now.getTime() <= until.getTime()
}

/** Combined pause check: the legacy indefinite boolean OR an active dated pause. */
export function isAccountReminderPaused(
  account: { dunning_pause?: boolean | null; dunning_pause_until?: string | null } | null | undefined,
  now: Date = new Date(),
): boolean {
  if (!account) return false
  return account.dunning_pause === true || isReminderPaused(account.dunning_pause_until, now)
}
