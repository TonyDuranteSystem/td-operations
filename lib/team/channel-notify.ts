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

/**
 * Does a message in a CLIENT CONVERSATION (thread_type 'discussion') notify its
 * participants? **No — since 2026-08-04.**
 *
 * Antonio: "every time Luca do something on his pc I receive the notification.
 * I want to turn them off." He was getting a toast AND a phone push for every
 * message Luca typed into a client conversation and every answer the worker
 * wrote back — his own screenshot showed three in a row, all of them Luca
 * working normally.
 *
 * THE CAUSE IS THE PARTICIPANT RULE, not the volume. Participation is derived
 * from `internal_thread_reads`, a row written when you merely OPEN a thread —
 * so glancing at a client conversation once enrolled him in it permanently.
 * Two fixes were on the table (2026-08-04) and Antonio picked this one:
 *   (a) THIS — conversations stop notifying entirely; @mention is the way in.
 *   (b) rejected for now — notify only for conversations you actually POSTED in
 *       or were shared into, plus a per-conversation Mute. Narrower and better,
 *       but a bigger change. **If the silence turns out to be too much, (b) is
 *       the fix, and THIS FUNCTION is where it goes** — replace the constant
 *       with the real predicate and all three call sites follow.
 *
 * STATED PLAINLY BECAUSE IT IS THE COST: a teammate who writes "Antonio, look
 * at this" inside a conversation WITHOUT @naming him now reaches nobody in real
 * time. The Team Chat unread counter still counts conversations (a quiet
 * number, deliberately left on), and an @mention still pushes — that branch is
 * checked BEFORE this one at every call site and must stay that way.
 *
 * Read by all three sites that could notify for a conversation — the two send
 * paths (a person posting, and Claude posting) and the in-CRM toast listener —
 * for the same reason `channelNotifiesStaff` is: the phone and the screen must
 * not be able to disagree about what is worth interrupting you for.
 *
 * NOT the same thing as a deliberate SHARE into a conversation: that is one
 * person addressing another on purpose and still notifies (see the share route).
 */
export function conversationNotifiesParticipants(): boolean {
  return false
}
