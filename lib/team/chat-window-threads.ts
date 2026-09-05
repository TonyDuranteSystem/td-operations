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
 * CLIENT CONVERSATIONS ARE SCOPED TO GENUINE ENGAGEMENT ONLY (Antonio,
 * 2026-09-04): "I don't want to have all that conversations in the floating.
 * it's noise." `openConversations` used to list every live client
 * conversation company-wide, so a colleague's own routine back-and-forth with
 * a client you have no connection to showed up in your own list with its own
 * (real, but not yours) unread count.
 *
 * TWO WRONG FIXES SHIPPED BEFORE THIS ONE, LEARN FROM BOTH:
 *
 * (1) Filtered on `is_participant` (a row exists in internal_thread_reads) —
 * correct in theory (already the established check three other consumers of
 * this same RPC row use: lib/team/workspace.ts's two notification builders,
 * realtime-notifications.tsx's toast filter) but WRONG here, discovered live
 * in production: `is_participant` is true the instant a row exists, and TWO
 * existing paths (findOrCreateConversation on every new client conversation;
 * the share route's admin-notify fallback) deliberately seed EVERY other
 * staff member with a row whose `last_read_at` is the epoch (1970-01-01) —
 * on purpose, so a ring/dot fires once. Correct for THOSE surfaces; it made
 * this filter nearly a no-op (120 of Antonio's 122 live discussion threads).
 *
 * (2) Filtered on a genuine (non-epoch) `last_read_at` instead — real
 * engagement, provably better (47 of 122), shipped, STILL wrong: asked
 * directly why the list was still full, Antonio: "I don't read them at all
 * unless i have been mentioned. but they are messy because most of them are
 * luca or claude conversation about the clients." Checked a sample of the 47:
 * zero messages actually SENT by him in any of them — a genuine last_read_at
 * only proves he once opened a thread to check on it (a real habit of his,
 * "I have to know everything"), not that it means anything to him day to day.
 *
 * `ever_mentioned` (below) is what he actually described: has he EVER been
 * @mentioned in this conversation, regardless of read state. Computed
 * server-side in app/api/team/threads/route.ts. Verified against his real
 * account before shipping: 122 discussion threads → 1. Nothing is hidden
 * forever: any client's conversation remains reachable on purpose through
 * "New chat" (search by company), and this list only ever grows when someone
 * actually types his name into one.
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
  /** Does a row exist in internal_thread_reads for the viewer? TRUE almost
   *  always for a live discussion thread — see the file header before using
   *  this for "is this genuinely mine." Kept only because the RPC still
   *  returns it and other consumers of these same rows key on it correctly. */
  is_participant?: boolean | null
  /** Has the viewer EVER been @mentioned in this thread (any message, any
   *  time, regardless of read state)? Computed server-side in
   *  app/api/team/threads/route.ts (NOT by get_team_threads itself); only
   *  meaningful for `discussion` threads. This — not `is_participant`, not a
   *  genuine-read timestamp — is what "mine" means for this file's
   *  quick-list, per Antonio's own words: see the file header. */
  ever_mentioned?: boolean | null
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
 * the full Team Chat page is where you go digging. Ones the viewer has never
 * been @mentioned in are dropped too (`ever_mentioned` — see the file header
 * for the two other, wrong things this was before): this list is a quick
 * "what's mine" glance, not a company-wide directory of every open client
 * conversation regardless of who is actually in it.
 */
export function openConversations(
  threads: readonly ChatThreadRow[] | null | undefined,
  limit = 20,
): ChatThreadRow[] {
  return (threads ?? [])
    .filter((t) => t?.thread_type === 'discussion' && !t.resolved_at && !t.archived_at && !!t.ever_mentioned)
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
