/**
 * Who gets a reminder, and when — the pure rules shared by the automatic cron
 * and the staff "Send reminder" button.
 *
 * Both callers must agree, or the two paths drift and clients get chased twice
 * (or not at all). Kept side-effect-free and `now`-injectable so the cadence is
 * testable without mocking the clock.
 */

/** A signer is chaseable only once they have actually been invited. */
export const REMINDABLE_SIGNER_STATUSES = ["sent", "viewed"] as const

/** Quiet period before an automatic nudge. */
export const REMINDER_AFTER_HOURS = 48

/** Automatic nudges per signer, per reminder cycle (a reopen starts a new one). */
export const MAX_REMINDERS = 2

/** Staff can re-nudge the same signer only this often. */
export const MANUAL_REMINDER_COOLDOWN_HOURS = 6

/**
 * Signers eligible to be chased for this envelope.
 *
 * `pending` is deliberately EXCLUDED, and that exclusion is load-bearing:
 *  - a pending signer has never been sent the document, so a "reminder" is
 *    really a first invite — and because the reminder path returns before the
 *    pending→sent transition, the signer stays pending and the Send button
 *    stays live, so staff then click Send and the client receives the SAME
 *    invite email twice;
 *  - a signer can also sit pending because they are undeliverable (no email,
 *    no portal login), in which case the reminder job skips them and reports
 *    success — telling staff a client was chased when nobody was.
 * Pending signers need Send, not Remind.
 *
 * Sequential envelopes chase only the signer whose turn it is; parallel chase
 * everyone outstanding.
 */
export function selectReminderTargets<T extends { status: string; signing_order?: number | null }>(
  signers: T[],
  routingOrder: string,
): T[] {
  const remindable = signers.filter(s =>
    (REMINDABLE_SIGNER_STATUSES as readonly string[]).includes(s.status),
  )
  if (routingOrder !== "sequential") return remindable
  const ordered = [...remindable].sort((a, b) => (a.signing_order ?? 0) - (b.signing_order ?? 0))
  return ordered.slice(0, 1)
}

/**
 * Automatic cadence for one signer: has the quiet period elapsed, and is the
 * budget for this cycle unspent?
 *
 * `reminderTimes` must already be scoped to the CURRENT cycle — reminders older
 * than the latest reopen do not count, otherwise a reopened envelope inherits
 * an exhausted budget and gets chased zero times for its whole new window.
 * `lastTouch` is the invite time (never rewritten by a reminder, so the clock
 * measures silence rather than restarting on every nudge).
 */
export function shouldSendAutoReminder(opts: {
  sentAt: string | Date | null | undefined
  reminderTimes: Array<string | Date>
  now: Date
}): boolean {
  if (!opts.sentAt) return false
  if (opts.reminderTimes.length >= MAX_REMINDERS) return false
  const cutoff = new Date(opts.now.getTime() - REMINDER_AFTER_HOURS * 3600 * 1000)
  const times = opts.reminderTimes.map(t => new Date(t).getTime())
  const lastTouch = times.length ? new Date(Math.max(...times)) : new Date(opts.sentAt)
  return lastTouch <= cutoff
}

/**
 * Manual throttle for one signer. Counts reminders of ANY origin — the point is
 * to protect the client from being chased repeatedly, and the client cannot
 * tell whether the last nudge was automatic or a staff click.
 */
export function isManualReminderThrottled(opts: {
  reminderTimes: Array<string | Date>
  now: Date
}): boolean {
  if (!opts.reminderTimes.length) return false
  const cutoff = new Date(opts.now.getTime() - MANUAL_REMINDER_COOLDOWN_HOURS * 3600 * 1000)
  return opts.reminderTimes.some(t => new Date(t) > cutoff)
}

/**
 * Reminders that count for the current cycle: those raised after the envelope
 * was last reopened. With no reopen, every reminder counts.
 */
export function remindersInCurrentCycle(
  reminderTimes: Array<string | Date>,
  lastReopenedAt: string | Date | null | undefined,
): Array<string | Date> {
  if (!lastReopenedAt) return reminderTimes
  const boundary = new Date(lastReopenedAt).getTime()
  return reminderTimes.filter(t => new Date(t).getTime() > boundary)
}
