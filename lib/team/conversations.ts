/**
 * Team Workspace — "New conversation" helpers (client-ref parsing).
 *
 * The client picker (like the Slack Client-Threads modal) encodes the chosen
 * client as `"<kind>:<uuid>"` where kind ∈ account|contact|lead. These pure
 * helpers parse/validate that ref so the API route maps it to the right FK
 * column on internal_threads. Kept side-effect-free for unit testing (R086).
 */

import { channelSlug } from '@/lib/team/workspace'

export type ClientKind = 'account' | 'contact' | 'lead'

export interface ClientRef {
  kind: ClientKind
  id: string
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Parse a `"account:<uuid>"` / `"contact:<uuid>"` / `"lead:<uuid>"` value into
 * { kind, id }. Returns null for any malformed / unknown-kind / bad-uuid input.
 */
export function parseClientRef(value: string): ClientRef | null {
  if (!value || typeof value !== 'string') return null
  const idx = value.indexOf(':')
  if (idx < 0) return null
  const kind = value.slice(0, idx)
  const id = value.slice(idx + 1)
  if (kind !== 'account' && kind !== 'contact' && kind !== 'lead') return null
  if (!UUID_RE.test(id)) return null
  return { kind, id }
}

/** Map a ClientRef to the internal_threads FK column it populates. */
export function clientRefColumn(kind: ClientKind): 'account_id' | 'contact_id' | 'lead_id' {
  return kind === 'account' ? 'account_id' : kind === 'contact' ? 'contact_id' : 'lead_id'
}

/**
 * Build the discussion thread title from client name + optional topic.
 * "Acme LLC · Banking" or just "Acme LLC" when no topic.
 */
export function conversationTitle(clientName: string, topic?: string | null): string {
  const name = (clientName || 'Client').trim()
  const t = (topic || '').trim()
  return t ? `${name} · ${t}` : name
}

/**
 * A default name for a topic left blank at creation — "Topic — Sep 8" rather
 * than blocking with validation text (Erika Hall review, 2026-09-08: a topic
 * has no other identity to fall back on the way a client conversation falls
 * back on the client's own name, so it should never go truly nameless, but
 * naming it shouldn't be a hard requirement either).
 */
export function defaultTopicName(now: Date = new Date()): string {
  return `Topic — ${now.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`
}

/**
 * What a rename actually writes, for a `discussion` thread — Antonio,
 * 2026-09-08: "I want the option to delete/rename a topic or conversation."
 *
 * INTERNAL TOPICS keep `topic`/`topic_slug` in lockstep with the new title,
 * because for a topic `title` IS `topic` by construction (find-conversation.ts)
 * and the find-or-reuse path matches on `topic_slug` — a rename that only
 * touched `title` would leave "New chat → Topic → the NEW name" unable to find
 * the very thread it was just renamed to, forking a duplicate the first time
 * anyone (including whoever renamed it) tried to reopen it by its new name.
 *
 * CLIENT CONVERSATIONS deliberately do NOT touch `topic`/`topic_slug` on
 * rename — that pair is the client+subject identity a future "New chat" for
 * the SAME matter should still find, and a rename is a cosmetic relabel, not
 * a declaration that this is now about a different subject.
 */
export function renameDiscussionPatch(
  isInternal: boolean,
  newTitle: string,
): { title: string; topic?: string; topic_slug?: string | null } | { error: string } {
  const title = (newTitle ?? '').trim()
  if (!title) return { error: 'A name is required.' }
  if (!isInternal) return { title }
  return { title, topic: title, topic_slug: channelSlug(title) || null }
}
