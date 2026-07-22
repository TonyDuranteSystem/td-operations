/**
 * Floating chat window — which conversations it offers, and what its badge says.
 *
 * Pure, so the two things most likely to drift are testable: WHO may be messaged
 * (a partner must never appear in a staff DM picker) and WHAT the badge counts.
 *
 * ON THE BADGE. The window's pill deliberately counts DIRECT MESSAGES ONLY, and
 * is labelled as such. It is NOT the sidebar's number and must not be reconciled
 * with it: the sidebar mixes grains (DM unread + participant-conversation unread
 * + mentions + followed threads), so making the two agree would mean either
 * inflating the pill with things the window cannot show, or quietly changing the
 * sidebar. Two honest different numbers beat one dishonest shared one — but they
 * are computed from the SAME rows, so neither can go stale while the other moves.
 */

/** A staff member who may be picked in the person switcher. */
export interface ChatMember {
  id: string
  name: string
  role?: string | null
}

/** The shape the window needs from a thread row. */
export interface ChatThreadRow {
  id: string
  thread_type?: string | null
  dm_key?: string | null
  unread_count?: number | null
  last_activity_at?: string | null
}

/**
 * Roles that may appear in the staff DM picker.
 *
 * PARTNERS ARE NOT STAFF. The thread-list endpoint returns the directory
 * UNFILTERED, while the notes API filters to these two roles and re-checks on
 * share. Reusing the raw list would have put partners in a staff-only picker —
 * Cris is a partner in TD Communication, not a member of the team.
 */
const STAFF_ROLES = new Set(['admin', 'team'])

/**
 * Who may be messaged from the window: staff only, never yourself.
 *
 * Self-exclusion is not cosmetic — the DM endpoint will happily create a thread
 * keyed to you-and-you, which then has no other participant, so nothing is ever
 * pushed and the conversation is a dead end.
 */
export function selectableChatMembers(
  members: readonly ChatMember[] | null | undefined,
  myId: string | null | undefined,
): ChatMember[] {
  if (!myId) return []
  return (members ?? [])
    .filter((m) => !!m?.id && m.id !== myId)
    .filter((m) => STAFF_ROLES.has((m.role ?? '').toLowerCase()))
    .slice()
    .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''))
}

/** Every DM thread belonging to me, newest activity first. */
export function myDmThreads(
  threads: readonly ChatThreadRow[] | null | undefined,
  myId: string | null | undefined,
): ChatThreadRow[] {
  if (!myId) return []
  return (threads ?? [])
    .filter((t) => t?.thread_type === 'dm' && !!t.dm_key && t.dm_key.split(':').includes(myId))
    .slice()
    .sort((a, b) => (b.last_activity_at ?? '').localeCompare(a.last_activity_at ?? ''))
}

/** The set of my DM thread ids — the membership test the auto-pop decision uses. */
export function myDmThreadIdSet(
  threads: readonly ChatThreadRow[] | null | undefined,
  myId: string | null | undefined,
): Set<string> {
  return new Set(myDmThreads(threads, myId).map((t) => t.id))
}

/**
 * The pill's number: unread DIRECT MESSAGES only.
 *
 * Never derive this from a message row's `read_at`: the send route stamps every
 * message read_at=now at insert, so any "read_at IS NULL" count is permanently
 * zero. Unread lives on the per-user read pointer, which is what the thread-list
 * query already returns as unread_count.
 */
export function dmUnreadCount(
  threads: readonly ChatThreadRow[] | null | undefined,
  myId: string | null | undefined,
): number {
  let n = 0
  for (const t of myDmThreads(threads, myId)) n += Number(t.unread_count) || 0
  return n
}

/** The other person in a DM, from its key. */
export function otherPartyId(dmKey: string | null | undefined, myId: string | null | undefined): string | null {
  if (!dmKey || !myId) return null
  return (dmKey.split(':').find((id) => id && id !== myId)) ?? null
}
