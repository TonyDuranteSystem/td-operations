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
