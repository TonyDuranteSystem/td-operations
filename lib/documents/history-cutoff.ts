/**
 * A person added to a company that already has history can be set to see only what comes from a date on
 * (Storage check Phase 2 slice 3, dev job d14e823f; Antonio 2026-10-17: new owners do not see old history by
 * default, with an option to show it). account_contacts.history_visible_from holds that date; NULL = sees everything.
 *
 * Deliberately zero imports (client-safe, like visibility-guard.ts). The date compared is created_at — the day the
 * file was SAVED in the CRM, not the document's own date (documents moved from Drive on 14-15 Oct 2026 all carry that
 * date). So the cutoff is always "the day staff added the person", never a backdated one.
 */

export interface CutoffDoc {
  created_at: string
  category?: number | null
  contact_id?: string | null
  visible_to_new_owners?: boolean | null
}

/**
 * ONE rule for every kind of company history (slice 3b): documents, invoices, expenses, payments, notices, chat messages...
 * An item is hidden from a person with a start date when it was SAVED (created_at) before that date, unless staff opened it
 * on purpose, the person made it themselves, or it was addressed to them. A bad date never hides anything.
 */
export interface HistoryItem {
  created_at: string
  /** The item was created by / belongs personally to this person (their own document, their own message). */
  ownerContactId?: string | null
  /** The item was sent to this person by name. */
  addressedToContactId?: string | null
  /** Staff opened this one older item on purpose. */
  opened?: boolean
}

export function isItemHiddenByCutoff(item: HistoryItem, cutoffIso: string | null | undefined, viewerContactId: string | null | undefined): boolean {
  if (!cutoffIso) return false
  if (item.opened) return false
  if (viewerContactId && (item.ownerContactId === viewerContactId || item.addressedToContactId === viewerContactId)) return false
  const created = Date.parse(item.created_at)
  const cutoff = Date.parse(cutoffIso)
  if (Number.isNaN(created) || Number.isNaN(cutoff)) return false // never hide on a bad date
  return created < cutoff
}

/** Keep the rows this person may see. `describe` maps a row to its HistoryItem (which column is the date, who owns it). */
export function filterByHistoryCutoff<T>(rows: T[], cutoffIso: string | null | undefined, viewerContactId: string | null | undefined, describe: (row: T) => HistoryItem): T[] {
  if (!cutoffIso) return rows
  return rows.filter(r => !isItemHiddenByCutoff(describe(r), cutoffIso, viewerContactId))
}

/**
 * The same rule as a PostgREST "keep" list for queries that count or page in the database (notifications, chat), to be placed
 * inside an `or(...)`: created on/after the start date, OR owned by / addressed to the viewer, OR staff opened it.
 * Returns null when there is no cutoff (nothing to add).
 */
export function historyKeepClauses(cutoffIso: string | null | undefined, opts: { viewerContactId?: string | null; ownerColumns?: string[]; openedIds?: string[] } = {}): string | null {
  if (!cutoffIso || Number.isNaN(Date.parse(cutoffIso))) return null
  const parts = [`created_at.gte.${cutoffIso}`]
  if (opts.viewerContactId) for (const col of opts.ownerColumns ?? []) parts.push(`${col}.eq.${opts.viewerContactId}`)
  if (opts.openedIds && opts.openedIds.length > 0) parts.push(`id.in.(${opts.openedIds.join(",")})`)
  return parts.join(",")
}

/** The "this company" part of a PostgREST filter, narrowed by the keep list from historyKeepClauses (null keep = whole company). */
export function accountScopeWithHistory(accountId: string, keep: string | null): string {
  return keep ? `and(account_id.eq.${accountId},or(${keep}))` : `account_id.eq.${accountId}`
}

/**
 * A TD invoice (payments row) that is still OWED is a live obligation, not history: it stays visible to everyone linked to the
 * company, whatever its date. Only settled rows (paid, cancelled, waived) follow the start date.
 */
export function isSettledPaymentStatus(status: string | null | undefined): boolean {
  return status === "Paid" || status === "Cancelled" || status === "Waived"
}

/** True when the viewer must NOT see this company document because it is older than their start date. */
export function isHiddenByHistoryCutoff(doc: CutoffDoc, cutoffIso: string | null | undefined, viewerContactId: string | null | undefined): boolean {
  // A person's OWN personal document is theirs, not company history.
  const own = doc.category === 2 && doc.contact_id ? doc.contact_id : null
  return isItemHiddenByCutoff({ created_at: doc.created_at, opened: !!doc.visible_to_new_owners, ownerContactId: own }, cutoffIso, viewerContactId)
}

/** The choice staff make when they add a person to a company that already has history. */
export type HistoryChoice = "today" | "all"

export function normalizeHistoryChoice(v: unknown): HistoryChoice {
  return v === "all" ? "all" : "today"
}
