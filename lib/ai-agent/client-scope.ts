/**
 * CLIENT SCOPE ENFORCEMENT (dev job a6c3d75b, council Security BLOCKER, 2026-07-18).
 *
 * On the Portal Chats panel the worker is open on ONE client — but that limit was
 * only ever a sentence in the prompt. Nothing in the server stopped it reading a
 * DIFFERENT client's records, while the same panel holds a live client-facing send
 * rail. That combination is the exposure Security flagged.
 *
 * WHAT THIS ENFORCES, and what it honestly does not:
 *
 *   ✅ Named lookups (search_payments, get_client_360, portal_chat_read, …): if the
 *      model passes an account/contact id that is NOT the client in scope, the call
 *      is refused. This is the realistic failure — a wrong id, or an injected
 *      instruction saying "now look up <other client>".
 *
 *   ✅ Free-form SQL that NAMES another client's id: refused by scanning the query
 *      for UUIDs that aren't the one in scope.
 *
 *   ❌ Free-form SQL with NO id (e.g. "select * from accounts limit 50") CANNOT be
 *      scoped by inspection. Closing that would mean removing raw SQL from client
 *      screens entirely — a real capability loss, and Antonio's requirement is that
 *      the worker can find out everything he can. So it stays, and this is the
 *      documented residual gap rather than a silent one.
 *
 * Pure + dependency-free so the policy is exhaustively unit-testable.
 */

/** The client the surface is pinned to, canonical form. */
export interface ClientScope {
  /** "account:<uuid>" | "contact:<uuid>" */
  key: string
  /** The bare uuid, for comparing against tool params. */
  id: string
  kind: 'account' | 'contact'
  /** Ids that legitimately belong to this client (account + its contacts). */
  allowedIds: string[]
}

/** Build a scope from the canonical key, plus any related ids the surface knows. */
export function buildClientScope(clientKey: string, relatedIds: readonly string[] = []): ClientScope | null {
  const v = (clientKey ?? '').trim()
  const m = v.match(/^(account|contact):([0-9a-fA-F-]{10,})$/)
  if (!m) return null
  const kind = m[1] as 'account' | 'contact'
  const id = m[2]
  const allowed = new Set<string>([id, ...relatedIds.filter(Boolean).map(String)])
  return { key: v, id, kind, allowedIds: Array.from(allowed) }
}

/** Param names that name a CLIENT. Anything else is not a scope decision. */
const CLIENT_ID_PARAMS = new Set([
  'account_id', 'accountId',
  'contact_id', 'contactId',
  'client_id', 'clientId',
])

const UUID_RE = /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g

export interface ScopeVerdict {
  allowed: boolean
  /** Plain-English reason, shown to the model when refused. */
  reason?: string
}

/**
 * Decide whether a tool call may run on a client-scoped surface.
 *
 * Fails OPEN when there is no scope (non-client surfaces are unaffected) and when
 * a call names no client at all (a general lookup like search_kb is fine).
 */
export function checkClientScope(
  toolName: string,
  params: Record<string, unknown> | undefined,
  scope: ClientScope | null | undefined,
): ScopeVerdict {
  if (!scope) return { allowed: true } // surface isn't client-pinned
  const p = params ?? {}

  // 1. Explicit client id params must match the client in scope.
  for (const [k, v] of Object.entries(p)) {
    if (!CLIENT_ID_PARAMS.has(k)) continue
    const val = typeof v === 'string' ? v.trim() : ''
    if (!val) continue
    if (!scope.allowedIds.includes(val)) {
      return {
        allowed: false,
        reason:
          `This screen is open on one client, and "${toolName}" was called with a DIFFERENT client's id. ` +
          `Refused. Look up only the client whose chat is open. If you genuinely need another client, ` +
          `ask the staff member to open that client, or use a screen that isn't pinned to one client.`,
      }
    }
  }

  // 2. Free-form SQL that names another client's uuid.
  if (toolName === 'run_sql_query' || toolName === 'crm_query') {
    const q = typeof p.query === 'string' ? p.query : typeof p.sql === 'string' ? p.sql : ''
    const found = q.match(UUID_RE) ?? []
    const foreign = found.filter((u) => !scope.allowedIds.includes(u))
    if (foreign.length) {
      return {
        allowed: false,
        reason:
          `This screen is open on one client, but that query names a different client's id. Refused. ` +
          `Query only the client in scope (${scope.key}).`,
      }
    }
  }

  return { allowed: true }
}
