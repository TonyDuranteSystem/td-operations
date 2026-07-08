/**
 * Team Workspace — "New conversation" helpers (client-ref parsing).
 *
 * The client picker (like the Slack Client-Threads modal) encodes the chosen
 * client as `"<kind>:<uuid>"` where kind ∈ account|contact|lead. These pure
 * helpers parse/validate that ref so the API route maps it to the right FK
 * column on internal_threads. Kept side-effect-free for unit testing (R086).
 */

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
