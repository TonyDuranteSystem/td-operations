/**
 * Floating chat window — which conversations it offers, and what its badge says.
 *
 * Pure, so the two things most likely to drift are testable: WHO may be messaged
 * (a partner must never appear in a staff DM picker) and WHAT the badge counts.
 *
 * ON THE BADGE. The pill counts unread direct messages PLUS unread client
 * conversations the viewer actually participates in (below) — not the
 * sidebar's own number, and not reconciled with it on purpose: the sidebar
 * mixes grains (DM unread + participant-conversation unread + mentions +
 * followed threads), so making the two agree would mean either inflating the
 * pill with things the window cannot show, or quietly changing the sidebar.
 * Two honest different numbers beat one dishonest shared one — but they are
 * computed from the SAME rows, so neither can go stale while the other moves.
 *
 * CLIENT CONVERSATIONS ARE SCOPED TO PARTICIPANTS ONLY (Antonio, 2026-09-04):
 * "I don't want to have all that conversations in the floating. it's noise."
 * `openConversations` used to list every live client conversation company-
 * wide, so a colleague's own routine back-and-forth with a client you have no
 * connection to showed up in your own list with its own (real, but not
 * yours) unread count — confirmed live: several production conversations
 * were nothing but one staff member's own exchange with the AI, something
 * the other person had never opened. Filtering on `is_participant` — already
 * the correct, established check three other consumers of this same RPC row
 * use (lib/team/workspace.ts's two notification builders,
 * realtime-notifications.tsx's toast filter) — removes it from the ambient
 * quick-list entirely. Nothing is hidden forever: any client's conversation
 * remains reachable on purpose through "New chat" (search by company), and
 * becomes a participant (and reappears here) the moment you open or post in
 * it, the same way the sidebar's own participant flag already works.
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
  /** Client conversations carry a label, a topic and the client they are about. */
  label?: string | null
  title?: string | null
  topic?: string | null
  account_id?: string | null
  contact_id?: string | null
  client_label?: string | null
  resolved_at?: string | null
  archived_at?: string | null
  /** Does the viewer actually participate in this thread (has an
   *  internal_thread_reads row — opened or posted at least once)? Computed
   *  server-side by the SAME get_team_threads RPC row this whole file reads;
   *  only meaningful for `discussion` threads (channels/dm are scoped some
   *  other way already). */
  is_participant?: boolean | null
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

/**
 * The client conversations the window can open — live ones the viewer
 * actually participates in, newest first.
 *
 * These are ordinary top-level threads, each already carrying its own title,
 * its own read pointer and its own place in Team Workspace. That is the whole
 * reason this shape was chosen over chats-nested-inside-a-direct-message:
 * nothing here is a new kind of object, so nothing downstream has to learn
 * about it.
 *
 * Resolved and archived ones are dropped — the window shows what is live now;
 * the full Team Chat page is where you go digging. NON-PARTICIPANT ones are
 * dropped too (`is_participant` — see the file header): this list is a quick
 * "what's mine" glance, not a company-wide directory of every open client
 * conversation regardless of who is actually in it.
 */
export function openConversations(
  threads: readonly ChatThreadRow[] | null | undefined,
  limit = 20,
): ChatThreadRow[] {
  return (threads ?? [])
    .filter((t) => t?.thread_type === 'discussion' && !t.resolved_at && !t.archived_at && !!t.is_participant)
    .slice()
    .sort((a, b) => (b.last_activity_at ?? '').localeCompare(a.last_activity_at ?? ''))
    .slice(0, limit)
}

/** A conversation's display name, preferring what the server already resolved. */
export function conversationLabel(t: ChatThreadRow | null | undefined): string {
  return (t?.label || t?.title || t?.topic || t?.client_label || 'Conversation').trim() || 'Conversation'
}

/**
 * The badge number: unread across everything the window can actually OPEN.
 *
 * THE GRAIN RULE, learned the hard way twice on this feature: a badge must
 * count exactly what its surface can show. Counting less under-reports and the
 * user misses messages; counting more sends them hunting for something that
 * isn't there. Both numbers here come from the SAME thread-list rows the
 * sidebar reads, so the two can disagree only if one is stale — never because
 * they measure different things.
 *
 * Still never derived from a message's own read flag: the send route stamps
 * that at insert, so any such count is permanently zero.
 */
export function windowUnreadCount(
  threads: readonly ChatThreadRow[] | null | undefined,
  myId: string | null | undefined,
): number {
  let n = dmUnreadCount(threads, myId)
  for (const t of openConversations(threads, Number.MAX_SAFE_INTEGER)) n += Number(t.unread_count) || 0
  return n
}

/** The other person in a DM, from its key. */
export function otherPartyId(dmKey: string | null | undefined, myId: string | null | undefined): string | null {
  if (!dmKey || !myId) return null
  return (dmKey.split(':').find((id) => id && id !== myId)) ?? null
}
