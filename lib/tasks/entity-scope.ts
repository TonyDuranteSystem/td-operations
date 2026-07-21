/**
 * Which entity a per-entity card request is scoped to.
 *
 * This exists because the To-Do card feed once had an unguarded else-branch: it filtered by
 * message_id or account_id, and a contact-scoped request matched neither and fell through to an
 * UNFILTERED query that returned every client's cards. The rule is now a pure function with
 * tests, so "no entity named" can never again silently mean "everything".
 *
 * Precedence is message > account > contact: a message id is the most specific thing a caller
 * can name, and the existing callers never send more than one.
 */

export type EntityScope =
  | { kind: "message"; column: "message_id"; value: string }
  | { kind: "account"; column: "account_id"; value: string }
  | { kind: "contact"; column: "contact_id"; value: string }

export interface EntityScopeInput {
  messageId?: string | null
  accountId?: string | null
  contactId?: string | null
}

/**
 * Resolve the scope, or return an error when the caller named no entity.
 * NEVER returns "no filter" — an unscoped read of this feed is always a caller bug.
 */
export function resolveEntityScope(
  input: EntityScopeInput,
): { scope: EntityScope | null; error: string | null } {
  const msg = nonEmpty(input.messageId)
  if (msg) return { scope: { kind: "message", column: "message_id", value: msg }, error: null }

  const acct = nonEmpty(input.accountId)
  if (acct) return { scope: { kind: "account", column: "account_id", value: acct }, error: null }

  const contact = nonEmpty(input.contactId)
  if (contact) return { scope: { kind: "contact", column: "contact_id", value: contact }, error: null }

  return { scope: null, error: "message_id, account_id or contact_id is required." }
}

/** Treat empty / whitespace-only params as absent — `?contact_id=` must not scope to "". */
function nonEmpty(v: string | null | undefined): string | null {
  if (typeof v !== "string") return null
  const t = v.trim()
  return t ? t : null
}
