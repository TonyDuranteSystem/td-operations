/**
 * Portal Chats: delete several messages of ONE chat at once (Luca 2026-10-23: "delete six messages one by one").
 * Same soft delete as the single DELETE /api/portal/chat/message/[id] (R100): the row stays (deleted_at / deleted_by), the client no
 * longer sees it, staff see a "Message deleted" marker. These pure rules decide what a bulk request may do; the route does the writes.
 */

export const BULK_DELETE_MAX = 100
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export interface BulkDeleteRow {
  id: string
  account_id: string | null
  contact_id: string | null
  deleted_at: string | null
}

/** Pure: the ids of the request, de-duplicated, or an error message. */
export function parseBulkDeleteIds(raw: unknown): { ok: true; ids: string[] } | { ok: false; error: string } {
  if (!Array.isArray(raw) || raw.length === 0) return { ok: false, error: 'ids must be a non-empty list of message ids' }
  const ids = Array.from(new Set(raw.map((x) => (typeof x === 'string' ? x.trim().toLowerCase() : ''))))
  if (ids.some((x) => !UUID_RE.test(x))) return { ok: false, error: 'ids must all be valid message ids' }
  if (ids.length > BULK_DELETE_MAX) return { ok: false, error: `Select at most ${BULK_DELETE_MAX} messages at a time` }
  return { ok: true, ids }
}

/**
 * The conversation staff has open: a company's own chat, or one person's unified thread (their personal messages plus the messages of
 * the companies they belong to — the same superset the thread screen shows).
 */
export type BulkDeleteScope =
  | { kind: 'account'; accountId: string }
  | { kind: 'contact'; contactId: string; linkedAccountIds: string[] }

/** Pure: does this message belong to the open conversation? */
export function inScope(r: Pick<BulkDeleteRow, 'account_id' | 'contact_id'>, scope: BulkDeleteScope): boolean {
  if (scope.kind === 'account') return r.account_id === scope.accountId
  return r.contact_id === scope.contactId || (!!r.account_id && scope.linkedAccountIds.includes(r.account_id))
}

export type BulkDeletePlan =
  | { ok: true; toDelete: string[]; alreadyDeleted: number }
  | { ok: false; status: number; error: string }

/**
 * Pure: may these messages be deleted together? Every id must exist AND belong to the conversation the request names (a selection
 * that strays outside it could hide messages from the wrong client). Already-deleted ones are skipped and counted, never an error.
 */
export function planBulkDelete(ids: string[], rows: BulkDeleteRow[], scope: BulkDeleteScope): BulkDeletePlan {
  const byId = new Map(rows.map((r) => [r.id, r]))
  const missing = ids.filter((id) => !byId.has(id))
  if (missing.length > 0) return { ok: false, status: 404, error: `${missing.length} of the selected messages could not be found — refresh and try again` }
  if (ids.some((id) => !inScope(byId.get(id) as BulkDeleteRow, scope))) {
    return { ok: false, status: 400, error: 'All selected messages must be from the conversation that is open' }
  }
  const live = ids.filter((id) => !(byId.get(id) as BulkDeleteRow).deleted_at)
  return { ok: true, toDelete: live, alreadyDeleted: ids.length - live.length }
}
