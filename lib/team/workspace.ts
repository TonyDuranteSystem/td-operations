/**
 * Team Workspace — pure helpers shared by the API routes, the @claude worker
 * adapter, and the UI. Kept side-effect-free so they're unit-testable without a
 * DB (R086).
 *
 * Backs the internal_threads / internal_messages Slack-replacement workspace.
 */

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

/** Human labels for the board columns. */
export const TEAM_WORK_STATUS_LABELS: Record<TeamWorkStatus, string> = {
  todo: 'To do',
  in_progress: 'In Progress',
  waiting: 'Waiting',
  handled: 'Handled',
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
 * Signals for: a new **DM**, an **@mention**, or unread in a **client
 * conversation you are a participant of** (you've opened, posted, or been
 * shared into it) — Antonio 2026-07-10. Still NOT ordinary channel chatter or a
 * conversation you've never touched (that was the noisy "48"). A participant
 * discussion contributes its full unread_count (which already includes any
 * mentions); every other non-DM thread contributes only its mention_count.
 */
export function countTeamNotifications(threads: TeamThreadCountRow[] | null | undefined): number {
  let n = 0
  for (const t of threads ?? []) {
    if (t.thread_type === 'dm') n += Number(t.unread_count) || 0
    else if (t.thread_type === 'discussion' && t.is_participant) n += Number(t.unread_count) || 0
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
  kind: 'dm' | 'mention' | 'conversation'
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
    } else {
      const mentions = Number(t.mention_count) || 0
      if (mentions <= 0) continue
      items.push({ id: t.id, kind: 'mention', label: t.label || 'Mention', count: mentions, url: `/team-chat?thread=${t.id}` })
    }
  }
  // DMs first, then conversations, then mentions; by count within each kind.
  const rank = (k: TeamNotifItem['kind']) => (k === 'dm' ? 0 : k === 'conversation' ? 1 : 2)
  return items.sort((a, b) => (a.kind === b.kind ? b.count - a.count : rank(a.kind) - rank(b.kind)))
}

/** Validate a TeamCard shape. Returns a user-friendly error or null. */
export function validateTeamCard(card: unknown): string | null {
  if (card == null) return null
  if (typeof card !== 'object') return 'Card must be an object.'
  const c = card as Record<string, unknown>
  const kinds = ['account', 'invoice', 'document', 'task', 'client_message', 'link']
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
