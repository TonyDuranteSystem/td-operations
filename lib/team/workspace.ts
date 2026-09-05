/**
 * Team Workspace — pure helpers shared by the API routes, the @claude worker
 * adapter, and the UI. Kept side-effect-free so they're unit-testable without a
 * DB (R086).
 *
 * Backs the internal_threads / internal_messages Slack-replacement workspace.
 */

/**
 * Auth roles that are NOT TD staff and must never appear in a team surface.
 *
 * `client` is obvious. `partner` is the one that bit us: a managed partner
 * (Cris, in TD Communication) authenticates with `app_metadata.role='partner'`
 * and is confined to /collab by middleware — but the staff directory used to
 * exclude only clients and then relabel everyone else 'team', so partners were
 * offered as teammates for @mentions, DMs, thread assignment, share targets and
 * — worst — staff sticky-note sharing, which pushes the note's body to the
 * recipient. Found in production 2026-07-22.
 *
 * Kept here, pure and client-safe, so the server directory and any UI filter
 * apply the SAME rule instead of two lists that can drift.
 */
export const NON_STAFF_AUTH_ROLES = ['client', 'partner'] as const

/**
 * Is this auth role a TD staff member?
 *
 * This is a DENY-LIST, not an allow-list, and that is a deliberate trade-off:
 * an unknown or absent role counts as staff, which preserves the existing
 * behaviour for legacy accounts that predate the role being set (the previous
 * rule was simply `role !== 'client'`). So this fixes the partner hole and
 * changes nothing else.
 *
 * THE RISK IT LEAVES, stated plainly: a FUTURE outsider role — say 'contractor'
 * or 'auditor' — would again arrive as staff until it is added above. If a new
 * non-employee role is ever introduced, it must be added to NON_STAFF_AUTH_ROLES
 * in the same change. A strict allow-list would close that permanently, but it
 * would also silently lock out any account whose role is unset, which is a
 * different outage and a bigger behavioural change than this incident warrants.
 */
export function isStaffAuthRole(role: string | null | undefined): boolean {
  const r = (role ?? '').toLowerCase()
  if (!r) return true // legacy staff accounts predate the role being set
  return !(NON_STAFF_AUTH_ROLES as readonly string[]).includes(r)
}

/** Sentinel reactor/mention id for the AI worker. */
export const CLAUDE_MENTION_ID = 'claude'

/**
 * Fixed sender_id used when the AI worker posts into a team thread. A distinct
 * sentinel (not Antonio's real uuid) so Claude's replies count as unread for
 * everyone including Antonio, and are never confused with his own messages.
 * internal_messages.sender_id has no FK, so a sentinel is safe.
 */
export const CLAUDE_SENDER_UUID = '00000000-0000-0000-0000-00000000c1a1'
export const CLAUDE_SENDER_NAME = 'Claude'

/** A parsed @mention found in a message body. */
export interface ParsedMention {
  /** Raw handle as typed after '@' (lower-cased, no spaces). */
  handle: string
}

/**
 * Extract @mentions from a message body.
 *
 * Matches `@handle` where handle is letters/digits/._- (so `@claude`, `@luca`,
 * `@antonio.durante` all work) and NOT preceded by a word character (so an
 * email like `a@b.com` is never treated as a mention). De-duplicates.
 *
 * Returns handles only; resolving a handle to a real user id is the caller's job
 * (it needs the staff directory, which is not available in a pure function).
 */
export function parseMentionHandles(body: string): string[] {
  if (!body) return []
  const out: string[] = []
  const seen = new Set<string>()
  // (^|non-word) then @ then handle. Capture the handle group.
  const re = /(^|[^\w@])@([a-zA-Z0-9][a-zA-Z0-9._-]{0,40})/g
  let m: RegExpExecArray | null
  while ((m = re.exec(body)) !== null) {
    const handle = m[2].toLowerCase().replace(/[._-]+$/, '') // trim trailing punctuation
    if (handle && !seen.has(handle)) {
      seen.add(handle)
      out.push(handle)
    }
  }
  return out
}

/** True if the body explicitly mentions the AI worker (@claude / @ai). */
export function mentionsClaude(body: string): boolean {
  const handles = parseMentionHandles(body)
  return handles.includes('claude') || handles.includes('ai')
}

/**
 * Slack invitation-gate parity (Antonio 2026-07-08 — "every time I have to
 * @claude… is it normal?"): in a CLIENT DISCUSSION, once Claude has
 * participated, plain follow-up messages continue the conversation without
 * re-mentioning — exactly like Slack thread replies after a mentioned parent
 * (and /client conversation threads). Channels/general/DMs still require an
 * explicit @claude for each new ask (like Slack top-level channel messages).
 */
export function shouldAutoContinueWithClaude(args: {
  threadType: string
  claudeHasParticipated: boolean
  bodyMentionsClaude: boolean
}): boolean {
  if (args.bodyMentionsClaude) return true
  return args.threadType === 'discussion' && args.claudeHasParticipated
}

/**
 * Canonical DM key for an unordered pair of user ids. Sorting makes
 * dm(a,b) === dm(b,a) so the partial-unique index dedupes one thread per pair.
 * Self-DM (a===b) is allowed (a private notes-to-self thread) and yields "a".
 */
export function dmKey(userIdA: string, userIdB: string): string {
  const a = (userIdA || '').trim()
  const b = (userIdB || '').trim()
  if (!a || !b) throw new Error('dmKey requires two user ids')
  return [a, b].sort().join(':')
}

/**
 * The one real recipient in a DM's key, given every id that is NOT a genuine
 * recipient (the Claude sentinel, and/or the human dictating the message).
 *
 * Extracted (bug-hunter, 2026-09-05) after a dm_key stopped always being
 * "Claude:target" — once a dictated DM is keyed to the real acting user
 * instead of the sentinel (see lib/team/post-message.ts's resolveTargetThread),
 * filtering on the sentinel ALONE left an arbitrary sorted-first id standing
 * in as "the other participant," which could target a push at the person who
 * DICTATED the message instead of who it was actually sent to. Filtering out
 * every known non-recipient identity at once is correct for every shape:
 * old sentinel-keyed threads, new actor-keyed threads, and the self-DM case
 * (every id excluded, so nothing remains and nobody is pushed).
 */
export function otherDmParty(dmKey: string | null | undefined, excludeIds: readonly (string | null | undefined)[]): string | null {
  const exclude = new Set(excludeIds.filter((id): id is string => !!id))
  const parts = (dmKey ?? '').split(':')
  return parts.find(id => id && !exclude.has(id)) ?? null
}

/**
 * Slugify a channel name: lower-case, spaces/underscores → hyphens, strip
 * anything but [a-z0-9-], collapse repeats, trim hyphens, cap length. Returns
 * '' for empty/garbage input so the caller can reject it.
 */
export function channelSlug(name: string): string {
  return (name || '')
    .toLowerCase()
    .trim()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
}

/** Kanban work statuses for a thread (Antonio 2026-07-08). Order = board columns. */
export const TEAM_WORK_STATUSES = ['todo', 'in_progress', 'waiting', 'handled'] as const
export type TeamWorkStatus = (typeof TEAM_WORK_STATUSES)[number]

/**
 * Human labels for a work status — ONE source, shared by the conversation board
 * and the per-thread management panel so the two grains never drift into two
 * vocabularies (council, 2026-07-17).
 */
export const TEAM_WORK_STATUS_LABELS: Record<TeamWorkStatus, string> = {
  todo: 'Open',
  in_progress: 'Working',
  waiting: 'Pending',
  handled: 'Done',
}

/** Dot + pill colors for a work status — shared by board, StatusDot, thread pill. */
export const TEAM_STATUS_COLORS: Record<TeamWorkStatus, { dot: string; pill: string }> = {
  todo:        { dot: 'bg-zinc-300',    pill: 'bg-zinc-100 text-zinc-600 border-zinc-200' },
  in_progress: { dot: 'bg-blue-500',    pill: 'bg-blue-50 text-blue-700 border-blue-200' },
  waiting:     { dot: 'bg-amber-500',   pill: 'bg-amber-50 text-amber-700 border-amber-200' },
  handled:     { dot: 'bg-emerald-500', pill: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
}

/** True if the value is a valid work status. */
export function isValidWorkStatus(v: unknown): v is TeamWorkStatus {
  return typeof v === 'string' && (TEAM_WORK_STATUSES as readonly string[]).includes(v)
}

/** Default palette for channels / rich cards (hex). UI may offer more. */
export const TEAM_COLORS = [
  '#6366f1', // indigo
  '#0ea5e9', // sky
  '#10b981', // emerald
  '#f59e0b', // amber
  '#ef4444', // red
  '#ec4899', // pink
  '#8b5cf6', // violet
  '#64748b', // slate
] as const

/** Validate a hex color like #rgb or #rrggbb. Returns null when acceptable. */
export function validateHexColor(color: string): string | null {
  if (!color) return null // color is optional
  return /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(color)
    ? null
    : 'Color must be a hex value like #6366f1.'
}

/**
 * Rich card payload stored on internal_messages.card. A shared, colorable object
 * that renders as a clickable card (an account, invoice, document, task, or a
 * quoted client message shared into a discussion/channel).
 */
export interface TeamCard {
  kind: 'account' | 'invoice' | 'document' | 'task' | 'client_message' | 'link'
  title: string
  subtitle?: string
  /** In-app href the card links to (relative). */
  url?: string
  /** Optional colour band (hex); falls back to the channel/default colour. */
  color?: string
  /** Optional source entity for back-reference / dedupe. */
  entity_type?: string
  entity_id?: string
}

export interface TeamThreadCountRow {
  thread_type?: string | null
  unread_count?: number | null
  mention_count?: number | null
  /** True when the caller has an internal_thread_reads row (opened/posted/seeded). */
  is_participant?: boolean | null
}

/**
 * Team-chat notification count for the sidebar/menu signal.
 *
 * Signals for: a new **DM**, unread in a **client conversation you are a
 * participant of**, an **@mention**, and — since 2026-07-24 — **a work channel
 * with a bug that is new for you**.
 *
 * Channels used to contribute only their mention_count, so a bug could be
 * opened and answered with the sidebar showing nothing (Antonio: "I have to
 * know everything because I work on the bugs"). A CHANNEL's unread_count is now
 * counted at THREAD grain by get_team_threads — it is "how many bugs have
 * something new", not how many messages exist — which is why counting it here
 * cannot bring back the noisy per-message number.
 *
 * ⚠️ 'general' is deliberately still mention-only. It is NOT counted at thread
 * grain (48 top-level messages, no replies, no per-thread read rows), so its
 * unread_count is a raw message count that nothing in the UI can clear —
 * exactly the stuck "48" this signal was cleaned up to remove.
 */
export function countTeamNotifications(threads: TeamThreadCountRow[] | null | undefined): number {
  let n = 0
  for (const t of threads ?? []) {
    if (t.thread_type === 'dm') n += Number(t.unread_count) || 0
    else if (t.thread_type === 'discussion' && t.is_participant) n += Number(t.unread_count) || 0
    else if (t.thread_type === 'channel') n += Number(t.unread_count) || 0
    else n += Number(t.mention_count) || 0
  }
  return n
}

export interface TeamNotifThreadRow {
  id: string
  thread_type?: string | null
  dm_key?: string | null
  unread_count?: number | null
  mention_count?: number | null
  label?: string | null
  is_participant?: boolean | null
}

export interface TeamNotifItem {
  id: string
  kind: 'dm' | 'mention' | 'conversation' | 'thread' | 'channel'
  /** Display label: the other person (DM), or the channel/conversation. */
  label: string
  count: number
  /** Deep-link to the thread. */
  url: string
}

/**
 * Build the "what's new" list behind the Team Chat notification dot: one row per
 * unread DM (labelled with the other person) and per @mention (labelled with the
 * channel/discussion it's in) — SAME scope as `countTeamNotifications` (no plain
 * channel unread). Lets the user triage without opening Team Chat. DMs first,
 * then by count. `nameFor` resolves a user id → display name.
 */
export function buildTeamNotifications(
  threads: TeamNotifThreadRow[] | null | undefined,
  userId: string,
  nameFor: (id: string) => string | undefined,
): TeamNotifItem[] {
  const items: TeamNotifItem[] = []
  for (const t of threads ?? []) {
    if (t.thread_type === 'dm') {
      const unread = Number(t.unread_count) || 0
      if (unread <= 0) continue
      const otherId = (t.dm_key ?? '').split(':').find(id => id && id !== userId) ?? ''
      items.push({ id: t.id, kind: 'dm', label: nameFor(otherId) || 'Direct message', count: unread, url: `/team-chat?thread=${t.id}` })
    } else if (t.thread_type === 'discussion' && t.is_participant) {
      // A conversation you're part of: unread already includes any mentions.
      const unread = Number(t.unread_count) || 0
      if (unread <= 0) continue
      items.push({ id: t.id, kind: 'conversation', label: t.label || 'Conversation', count: unread, url: `/team-chat?thread=${t.id}` })
    } else if (t.thread_type === 'channel') {
      // A work channel: the count is BUGS with something new (thread grain), so
      // the row reads "#td-bug · 3" and opens the channel on its bug list.
      // Individual followed threads are appended separately by the notifications
      // route and deep-link to the bug itself — more specific, same signal.
      const unread = Number(t.unread_count) || 0
      if (unread <= 0) continue
      items.push({ id: t.id, kind: 'channel', label: `#${t.label || 'channel'}`, count: unread, url: `/team-chat?thread=${t.id}` })
    } else {
      const mentions = Number(t.mention_count) || 0
      if (mentions <= 0) continue
      items.push({ id: t.id, kind: 'mention', label: t.label || 'Mention', count: mentions, url: `/team-chat?thread=${t.id}` })
    }
  }
  // DMs first, then conversations, then mentions; by count within each kind.
  const rank = (k: TeamNotifItem['kind']) => (k === 'dm' ? 0 : k === 'conversation' ? 1 : k === 'channel' ? 2 : 3)
  return items.sort((a, b) => (a.kind === b.kind ? b.count - a.count : rank(a.kind) - rank(b.kind)))
}

/** Validate a TeamCard shape. Returns a user-friendly error or null. */
export function validateTeamCard(card: unknown): string | null {
  if (card == null) return null
  if (typeof card !== 'object') return 'Card must be an object.'
  const c = card as Record<string, unknown>
  // 'email_confirm' carries a FROZEN outbound email awaiting a human's Confirm —
  // its entity_id is the prepared-send row id and its buttons call the shared
  // confirm-send endpoint. Server-authored only (the @claude trigger stamps it).
  const kinds = ['account', 'invoice', 'document', 'task', 'client_message', 'link', 'email_confirm']
  if (typeof c.kind !== 'string' || !kinds.includes(c.kind)) {
    return 'Card kind is invalid.'
  }
  if (typeof c.title !== 'string' || !c.title.trim()) {
    return 'Card title is required.'
  }
  if (c.color != null) {
    const colErr = validateHexColor(String(c.color))
    if (colErr) return colErr
  }
  return null
}
