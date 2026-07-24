/**
 * Team Workspace — which channels notify the whole team (pure, client-safe).
 *
 * Antonio 2026-07-24: "There is only Luca and me, so it's not mentioned or not.
 * I have to know everything because I work on the bugs." TD LLC is two people
 * and every post in a work channel is work for one of them, so the follow /
 * @mention targeting that Slack needs for a 50-person channel is pure friction
 * here: it means a bug can be posted and answered with nobody told.
 *
 * So a work channel notifies EVERY staff member except the sender — new topic,
 * reply, or an answer written by Claude, all the same. The exception is the
 * channel Claude files its OWN bug reports into: that one is machine-written and
 * would eventually buzz a phone for every worker hiccup, which is how a channel
 * gets muted, and a muted channel is worse than a silent one.
 *
 * Pure and client-safe on purpose — the send routes decide who to push, and the
 * in-CRM toast listener decides which arriving message pops up. Those two must
 * agree, so they read the SAME predicate rather than each keeping a list.
 */

/**
 * Channels that never notify. Machine-written only — never add a channel here
 * because it is "busy": busy is exactly when the team needs to be told.
 */
export const SILENT_CHANNEL_SLUGS = ['td-worker-bug'] as const

/**
 * Does a post in this channel notify the rest of the staff?
 *
 * @param slug the channel's slug (or its name / label — matched case-insensitively
 *             so a caller holding only the display name still gets the right
 *             answer). `null`/empty is the general room, which does notify.
 */
export function channelNotifiesStaff(slug: string | null | undefined): boolean {
  const s = (slug ?? '').trim().toLowerCase()
  if (!s) return true
  return !(SILENT_CHANNEL_SLUGS as readonly string[]).includes(s)
}
