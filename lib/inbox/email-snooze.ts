/**
 * Email snooze — pure logic shared by the email-actions route, the unsnooze
 * cron, and the row snooze menu. Gmail's API has NO native snooze, so ours is:
 * remove INBOX + add the "Snoozed" user label now, record a row in email_snoozes,
 * and a 10-min cron re-inboxes due rows. THE CRON ACTS ONLY ON TABLE ROWS —
 * never by sweeping the label (the label predates this feature and may carry
 * manually-filed threads; and sandbox + production share the SAME real Gmail,
 * so each environment's cron must only ever touch threads its own table owns).
 *
 * All time-dependent functions take `now` explicitly (time-travel test
 * pattern, per CLAUDE.md).
 */

export const SNOOZE_LABEL_NAME = "Snoozed"

/** Reject snoozes that would wake immediately (clock skew, stale menu). */
export const MIN_SNOOZE_LEAD_MS = 60_000

export interface SnoozePreset {
  key: string
  label: string
  until: Date
}

/**
 * Gmail-style presets, computed in the caller's local time. Presets whose
 * instant is not strictly in the future (with lead margin) are dropped —
 * "Later today 18:00" clicked at 19:30 must not appear and instantly wake.
 */
export function snoozePresets(now: Date): SnoozePreset[] {
  const laterToday = new Date(now)
  laterToday.setHours(18, 0, 0, 0)

  const tomorrow = new Date(now)
  tomorrow.setDate(tomorrow.getDate() + 1)
  tomorrow.setHours(8, 0, 0, 0)

  // Strictly NEXT Monday: 1..7 days ahead, never today.
  const nextMonday = new Date(now)
  const daysAhead = (8 - nextMonday.getDay()) % 7 || 7
  nextMonday.setDate(nextMonday.getDate() + daysAhead)
  nextMonday.setHours(8, 0, 0, 0)

  const all: SnoozePreset[] = [
    { key: "later_today", label: "Later today · 18:00", until: laterToday },
    { key: "tomorrow", label: "Tomorrow · 08:00", until: tomorrow },
    { key: "next_monday", label: "Next Monday · 08:00", until: nextMonday },
  ]
  return all.filter((p) => p.until.getTime() > now.getTime() + MIN_SNOOZE_LEAD_MS)
}

export type WakeDecision =
  | { kind: "wake" }
  | { kind: "cancel"; reason: "gone" | "trashed" | "new_mail" }

/**
 * What should the unsnooze cron do with a DUE row, given the thread as Gmail
 * returns it right now? (Council bug-hunter blockers, 2026-07-28:)
 * - thread deleted / 404            → cancel: nothing to wake ("gone")
 * - any message in TRASH            → cancel: waking would resurrect deleted
 *   mail into the Inbox list, which has no -in:trash filter ("trashed")
 * - messages newer than at snooze   → cancel: the new inbound mail already
 *   carried INBOX and re-surfaced the thread (Gmail-parity), and if staff then
 *   archived it, waking would resurrect a handled thread ("new_mail")
 * - otherwise                       → wake.
 */
export function decideWakeAction(args: {
  threadFound: boolean
  messages: Array<{ id?: string; labelIds?: string[] }>
  snoozedLastMessageId: string | null
}): WakeDecision {
  if (!args.threadFound || args.messages.length === 0) {
    return { kind: "cancel", reason: "gone" }
  }
  if (args.messages.some((m) => m.labelIds?.includes("TRASH"))) {
    return { kind: "cancel", reason: "trashed" }
  }
  if (args.snoozedLastMessageId) {
    const ids = args.messages.map((m) => m.id)
    const at = ids.indexOf(args.snoozedLastMessageId)
    const hasNewer = at === -1 ? true : at < ids.length - 1
    if (hasNewer) return { kind: "cancel", reason: "new_mail" }
  }
  return { kind: "wake" }
}

/** Server-side validity gate for a requested snooze instant. */
export function isValidSnoozeUntil(untilIso: string, now: Date): boolean {
  const t = Date.parse(untilIso)
  if (isNaN(t)) return false
  return t > now.getTime() + MIN_SNOOZE_LEAD_MS
}
