/**
 * Team Workspace — Slack mirror PURE classification (no server deps).
 *
 * Split out from lib/team/slack-mirror.ts (which is `server-only`) so these
 * pure helpers are unit-testable and safe to import anywhere. The server module
 * re-exports them.
 */

/**
 * Stopgap name map for the core team, since resolving arbitrary Slack user ids
 * to display names needs the `users:read` scope (not granted yet — the mirror
 * shipped with channels:read only). Once users:read is added, a users.info cache
 * in the sync supersedes this. Ids from the worker constants (slack-claude.ts).
 */
export const KNOWN_SLACK_USERS: Record<string, string> = {
  U0BAALR4Y4Q: 'Antonio',
  U0B9ZUE2Q75: 'Luca',
  U0B9S675WTT: 'Claude',
}

/** Replace `<@U123>` mentions in Slack text with `@Name` (or `@U123` if unknown). */
export function resolveSlackMentions(text: string, names: Record<string, string> = KNOWN_SLACK_USERS): string {
  return (text || '').replace(/<@([A-Z0-9]+)(\|[^>]*)?>/g, (_m, id) => '@' + (names[id] || id))
}

/** Slack ts ("1782141518.486979") → Date. null on garbage. */
export function slackTsToDate(ts: string | null | undefined): Date | null {
  if (!ts) return null
  const secs = parseFloat(ts)
  if (!Number.isFinite(secs) || secs <= 0) return null
  return new Date(Math.floor(secs * 1000))
}

/** Message subtypes that are channel noise we don't mirror into the feed. */
export const SKIP_SUBTYPES = new Set<string>([
  'channel_join', 'channel_leave', 'channel_topic', 'channel_purpose',
  'channel_name', 'channel_archive', 'channel_unarchive', 'group_join', 'group_leave',
])

export interface MirrorRow {
  channel_id: string
  ts: string
  thread_ts: string | null
  slack_user_id: string | null
  author_name: string | null
  text: string
  subtype: string | null
  edited: boolean
  posted_at: string | null
}

export type MirrorAction =
  | { op: 'skip' }
  | { op: 'delete'; channel_id: string; ts: string }
  | { op: 'upsert'; row: MirrorRow }

/**
 * Classify a Slack `message` event into a mirror action (pure — unit-tested).
 * Handles new messages, edits (message_changed), and deletes (message_deleted).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function classifySlackEvent(event: any): MirrorAction {
  if (!event || event.type !== 'message') return { op: 'skip' }
  const subtype: string | undefined = event.subtype

  if (subtype === 'message_deleted') {
    const channel_id = event.channel
    const ts = event.deleted_ts
    if (!channel_id || !ts) return { op: 'skip' }
    return { op: 'delete', channel_id, ts }
  }

  // Edits carry the new content under event.message.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const m: any = subtype === 'message_changed' ? event.message : event
  const edited = subtype === 'message_changed'
  const effSubtype: string | undefined = edited ? m?.subtype : subtype

  if (effSubtype && SKIP_SUBTYPES.has(effSubtype)) return { op: 'skip' }

  const channel_id = event.channel
  const ts = m?.ts
  if (!channel_id || !ts) return { op: 'skip' }

  const posted = slackTsToDate(ts)
  return {
    op: 'upsert',
    row: {
      channel_id,
      ts,
      thread_ts: m?.thread_ts ?? null,
      slack_user_id: m?.user ?? null,
      author_name: m?.username ?? null, // bot posts carry username; human names resolved lazily
      text: typeof m?.text === 'string' ? m.text : '',
      subtype: effSubtype ?? null,
      edited,
      posted_at: posted ? posted.toISOString() : null,
    },
  }
}
