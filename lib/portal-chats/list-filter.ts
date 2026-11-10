/**
 * Portal Chats conversation-list filter chips (staff CRM, left list).
 *
 * Chips, in order: All · Unread · What's New · Chats · Pinned. The list opens on "Chats".
 *
 *   - All       every conversation.
 *   - Unread    the client wrote and nobody on the team has read it yet.
 *   - What's New  unhandled client-action notes (payments, signatures, forms…).
 *   - Chats     conversations where a PERSON wrote (the client or the team). A conversation that
 *               holds only automatic notices (sender_type 'system') is left out — it is still in
 *               All and, while something is unhandled, in What's New.
 *   - Pinned    the manually pinned conversations (shared by all staff).
 *
 * "Chats" depends on a flag the threads route computes (`has_people_messages`). If that flag is
 * missing — an old API answer, or the database function is not installed yet — the chip keeps the
 * conversation (shows everything) rather than hiding it: an empty list by default would be worse
 * than a list that is merely unfiltered.
 */
import { whatsNewCountForThread, type SortableThread, type WhatsNewCounts } from "./sort-threads"

export type ListFilter = "all" | "unread" | "whatsnew" | "chats" | "pinned"

/** The chip a fresh visit to the list opens on. */
export const DEFAULT_LIST_FILTER: ListFilter = "chats"

/** Chip order and labels, left to right. */
export const LIST_FILTER_CHIPS: ReadonlyArray<readonly [ListFilter, string]> = [
  ["all", "All"],
  ["unread", "Unread"],
  ["whatsnew", "What's New"],
  ["chats", "Chats"],
  ["pinned", "Pinned"],
]

export interface FilterableThread extends SortableThread {
  /** True when at least one non-deleted message was written by the client or the team. Undefined = unknown. */
  has_people_messages?: boolean
}

/** Does this conversation belong under the given chip? (Search is applied separately by the page.) */
export function matchesListFilter(
  thread: FilterableThread,
  filter: ListFilter,
  counts?: WhatsNewCounts | null
): boolean {
  switch (filter) {
    case "all":
      return true
    case "unread":
      return thread.unread_count > 0
    case "whatsnew":
      return whatsNewCountForThread(thread, counts) > 0
    case "chats":
      // Unknown (undefined) counts as a real chat — see the file header.
      return thread.has_people_messages !== false
    case "pinned":
      return thread.is_pinned === true
    default:
      return true
  }
}

export interface PeopleThreadKey {
  contact_id: string | null
  account_id: string | null
}

/** Turns the database function's rows into a set the route can test each thread against. */
export function buildPeopleThreadKeySet(rows: ReadonlyArray<PeopleThreadKey>): Set<string> {
  const keys = new Set<string>()
  for (const r of rows) {
    if (r.account_id) keys.add(`account:${r.account_id}`)
    else if (r.contact_id) keys.add(`contact:${r.contact_id}`)
  }
  return keys
}

/** The one method of the database client the loader below needs (kept tiny so a test can fake it). */
export interface PeopleKeysClient {
  rpc(fn: string): PromiseLike<{ data: unknown; error: { message?: string } | null }>
}

/**
 * Asks the database which conversations have a person-written message. NEVER throws and never blocks
 * the thread list: any failure (function not installed yet, network blip) returns null, which the route
 * turns into "unknown" for every conversation — so the Chats chip then shows everything.
 * (Written with try/await on purpose: the database client's calls are thenables, not full Promises —
 * they have no `.catch` — which broke the first version of this code in the browser.)
 */
export async function loadPeopleThreadKeys(client: PeopleKeysClient): Promise<Set<string> | null> {
  try {
    const { data, error } = await client.rpc("get_portal_chat_people_thread_keys")
    if (error) {
      console.warn("[portal-chat/threads] people-thread keys unavailable — Chats chip will show every conversation:", error.message)
      return null
    }
    if (!Array.isArray(data)) return null
    return buildPeopleThreadKeySet(data as PeopleThreadKey[])
  } catch (e) {
    console.warn("[portal-chat/threads] people-thread keys failed — Chats chip will show every conversation:", e instanceof Error ? e.message : e)
    return null
  }
}

/**
 * Does this thread have a person-written message? Account-level threads (multi-member companies)
 * are keyed by account; contact-level threads by person — the same shapes the thread list uses.
 */
export function threadHasPeopleMessages(
  thread: { account_id: string | null; contact_id: string | null },
  keys: Set<string>
): boolean {
  if (thread.account_id) return keys.has(`account:${thread.account_id}`)
  if (thread.contact_id) return keys.has(`contact:${thread.contact_id}`)
  return false
}
