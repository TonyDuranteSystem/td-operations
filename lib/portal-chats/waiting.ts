/**
 * "Waiting for client" rules for Portal Chats (2026-11-21, dev job 954af5db).
 *
 * Staff mark a conversation as waiting for the client's answer. A mark is stored with the time it was
 * made (`marked_at`). It is "still waiting" only while the client has NOT written since then — so the
 * mark ends by itself, with no write on every client message (any path a client message arrives by).
 * Pure functions, explicit `now` (the established time-travel testing pattern).
 */

const DAY_MS = 24 * 60 * 60 * 1000

/** Days of silence before the automatic reminder, and between reminders. */
export const WAITING_REMIND_AFTER_DAYS = 3
/** Reminders after which we stop (the chip stays until the client answers or staff clear it). */
export const WAITING_MAX_REMINDERS = 2

/** Still waiting = no client message at or after the mark time. */
export function isStillWaiting(markedAt: string, clientMessageTimes: readonly string[]): boolean {
  const marked = new Date(markedAt).getTime()
  if (Number.isNaN(marked)) return false
  return !clientMessageTimes.some(t => new Date(t).getTime() >= marked)
}

/** Whole days waited, never negative. */
export function daysWaiting(markedAt: string, now: Date): number {
  const marked = new Date(markedAt).getTime()
  if (Number.isNaN(marked)) return 0
  return Math.max(0, Math.floor((now.getTime() - marked) / DAY_MS))
}

export type WaitingReminderDecision = { send: true; reminderNumber: number } | { send: false; reason: string }

/** Should a reminder go out for this mark right now? (The caller has already checked the client has not answered.) */
export function decideWaitingReminder(opts: {
  markedAt: string
  remindersSent: number
  lastReminderAt: string | null
  now: Date
}): WaitingReminderDecision {
  const { markedAt, remindersSent, lastReminderAt, now } = opts
  if (remindersSent >= WAITING_MAX_REMINDERS) return { send: false, reason: `max reminders reached (${remindersSent}/${WAITING_MAX_REMINDERS})` }
  const anchor = remindersSent === 0 ? markedAt : lastReminderAt
  if (!anchor) return { send: false, reason: 'no reminder anchor' }
  const t = new Date(anchor).getTime()
  if (Number.isNaN(t)) return { send: false, reason: 'bad timestamp' }
  if (now.getTime() - t < WAITING_REMIND_AFTER_DAYS * DAY_MS) return { send: false, reason: `within ${WAITING_REMIND_AFTER_DAYS}d` }
  return { send: true, reminderNumber: remindersSent + 1 }
}
